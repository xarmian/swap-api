// Unit tests for the two-pool split refinement (refineSplitAmount).
// Run with: node --test tests/split-refinement.test.js
//
// The closed-form seed (calculateOptimalSplitAmount) solves the split for the
// Uniswap fee-adjusted-INPUT denominator — a good fit for HumbleSwap (though
// still floor-rounded via a heuristic integer sqrt, so not exact) and only
// approximate for Nomadex (fee on the numerator only, raw (in + reserve)
// denominator). refineSplitAmount performs a bounded, DEX-agnostic search that
// maximizes total output against the ACTUAL per-pool output curves supplied as
// closures. Its one hard guarantee is on OUTPUT — g(refined) >= g(seed), i.e.
// the chosen split's total output is never below the seed's (the split AMOUNT
// itself may differ) — so it never worsens the prior 3-point method. It improves
// routing most for Nomadex-involving/mixed pairs and can also recover a base
// unit or two on HumbleSwap-only pairs.
//
// Pure BigInt math: no network, no node_modules, no algosdk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOptimalSplitAmount, refineSplitAmount } from '../lib/utils.js';
import { calculateOutputAmount as nomadexOut, NOMADEX_FEE_SCALE } from '../lib/nomadex.js';
import { calculateOutputAmount as humbleOut } from '../lib/humbleswap.js';

const bpsToScale = (bps) => BigInt(bps) * (NOMADEX_FEE_SCALE / 10000n);

// Build per-pool output closures for a pair described declaratively.
function makeOut(pool) {
  if (pool.dex === 'nomadex') {
    return (x) => nomadexOut(x, pool.rIn, pool.rOut, bpsToScale(pool.bps));
  }
  return (x) => humbleOut(x, pool.rIn, pool.rOut, pool.bps);
}

// Independent brute-force optimum over EVERY integer split in [0, T].
// Only used for small T so it stays cheap and exact.
function bruteOptimum(T, out1, out2) {
  let bestX = 0n;
  let bestOut = out1(0n) + out2(T);
  for (let x = 1n; x <= T; x++) {
    const v = out1(x) + out2(T - x);
    if (v > bestOut) { bestOut = v; bestX = x; }
  }
  return { bestX, bestOut };
}

function seedFor(T, p1, p2) {
  return calculateOptimalSplitAmount(T, p1.rIn, p1.rOut, p1.bps, p2.rIn, p2.rOut, p2.bps);
}

test('split amounts always sum EXACTLY to the input (no stranded/negative leg)', () => {
  const T = 1_000_000n;
  const p1 = { dex: 'nomadex', rIn: 5_000_000n, rOut: 250_000_000n, bps: 30 };
  const p2 = { dex: 'humbleswap', rIn: 20_000_000n, rOut: 900_000_000n, bps: 100 };
  const out1 = makeOut(p1), out2 = makeOut(p2);
  for (const seed of [0n, T, T / 2n, seedFor(T, p1, p2)]) {
    const x = refineSplitAmount(T, out1, out2, seed);
    assert.ok(x >= 0n && x <= T, `x=${x} out of range for seed=${seed}`);
    assert.equal(x + (T - x), T); // exact-sum invariant
    assert.ok(T - x >= 0n);
  }
});

test('refined is NEVER worse than the closed-form seed (improve or tie)', () => {
  const T = 1_000_000n;
  const pairs = [
    // Nomadex/Nomadex, Nomadex/HumbleSwap (mixed), HumbleSwap/HumbleSwap
    [{ dex: 'nomadex', rIn: 5_000_000n, rOut: 250_000_000n, bps: 30 },
     { dex: 'nomadex', rIn: 20_000_000n, rOut: 900_000_000n, bps: 100 }],
    [{ dex: 'nomadex', rIn: 8_000_000n, rOut: 300_000_000n, bps: 200 },
     { dex: 'humbleswap', rIn: 12_000_000n, rOut: 400_000_000n, bps: 30 }],
    [{ dex: 'humbleswap', rIn: 5_000_000n, rOut: 250_000_000n, bps: 30 },
     { dex: 'humbleswap', rIn: 20_000_000n, rOut: 900_000_000n, bps: 100 }],
  ];
  for (const [p1, p2] of pairs) {
    const out1 = makeOut(p1), out2 = makeOut(p2);
    const seed = seedFor(T, p1, p2);
    const gSeed = out1(seed) + out2(T - seed);
    const x = refineSplitAmount(T, out1, out2, seed);
    const gRef = out1(x) + out2(T - x);
    assert.ok(gRef >= gSeed, `${p1.dex}/${p2.dex}: refined ${gRef} < seed ${gSeed}`);
    // Also never worse than either single-pool endpoint.
    assert.ok(gRef >= out1(T) + out2(0n));
    assert.ok(gRef >= out1(0n) + out2(T));
  }
});

// Integer flooring of the AMM outputs makes the discrete objective only weakly
// concave, so the search lands NEAR the true integer optimum, not necessarily
// exactly on it. This is an EMPIRICAL regression bound (a base-unit gap this
// small is economically nil), NOT a proven guarantee — the only proven guarantee
// is `refined >= seed`, asserted separately. The randomized sweep below (wide
// reserve ranges up to ~1e13, including the sharp-plateau regime that a floored
// grid step can otherwise strand) holds the gap within this bound.
const FLOOR_NOISE_TOLERANCE = 2n;

test('Nomadex-involving pairs: refinement is optimal within floor-rounding noise', () => {
  // Small T so brute force is exhaustive and cheap.
  const T = 20_000n;
  const cases = [
    // Nomadex/Nomadex, asymmetric reserves + differing fees.
    [{ dex: 'nomadex', rIn: 40_000n, rOut: 1_800_000n, bps: 30 },
     { dex: 'nomadex', rIn: 150_000n, rOut: 5_000_000n, bps: 200 }],
    // Mixed Nomadex/HumbleSwap.
    [{ dex: 'nomadex', rIn: 60_000n, rOut: 2_100_000n, bps: 200 },
     { dex: 'humbleswap', rIn: 90_000n, rOut: 2_800_000n, bps: 30 }],
    // Mixed, reversed DEX order.
    [{ dex: 'humbleswap', rIn: 55_000n, rOut: 1_500_000n, bps: 50 },
     { dex: 'nomadex', rIn: 70_000n, rOut: 2_400_000n, bps: 100 }],
  ];
  for (const [p1, p2] of cases) {
    const out1 = makeOut(p1), out2 = makeOut(p2);
    const seed = seedFor(T, p1, p2);
    const x = refineSplitAmount(T, out1, out2, seed);
    const gRef = out1(x) + out2(T - x);
    const { bestOut } = bruteOptimum(T, out1, out2);
    assert.ok(bestOut - gRef <= FLOOR_NOISE_TOLERANCE,
      `${p1.dex}/${p2.dex}: refined ${gRef} vs optimum ${bestOut} (gap ${bestOut - gRef})`);
    assert.ok(gRef >= out1(seed) + out2(T - seed)); // and never worse than the seed
  }
});

test('Nomadex seed is provably sub-optimal and the refinement recovers the gain', () => {
  // Construct a Nomadex/Nomadex pair where the Uniswap-denominator seed misses
  // the true optimum, then show the refinement strictly improves on it and lands
  // within floor-rounding noise of the exhaustive optimum.
  const T = 20_000n;
  const p1 = { dex: 'nomadex', rIn: 40_000n, rOut: 1_800_000n, bps: 30 };
  const p2 = { dex: 'nomadex', rIn: 150_000n, rOut: 5_000_000n, bps: 200 };
  const out1 = makeOut(p1), out2 = makeOut(p2);
  const seed = seedFor(T, p1, p2);
  const gSeed = out1(seed) + out2(T - seed);
  const x = refineSplitAmount(T, out1, out2, seed);
  const gRef = out1(x) + out2(T - x);
  const { bestOut } = bruteOptimum(T, out1, out2);
  assert.ok(gRef > gSeed, `expected strict improvement: refined ${gRef} <= seed ${gSeed}`);
  assert.ok(bestOut - gRef <= FLOOR_NOISE_TOLERANCE);
});

test('regression: adversarial-review counterexamples (floored grid strands a tail)', () => {
  // These were found by adversarial codex review. Before the fixes they exposed
  // (a) a sharp single-point peak a ternary bisection stepped over, and (b) a
  // FLOORED grid step whose K samples fell short of `hi`, stranding an improving
  // tail (the rebracket then discarded it — a 518-base-unit miss). With a ceiling
  // step + 2-cell slack the search now reaches these optima within floor noise.
  const cases = [
    // [T, [p1..], [p2..]] where a pool spec is {dex, rIn, rOut, bps}.
    [1561n,
     { dex: 'nomadex', rIn: 258n, rOut: 8327n, bps: 519 },
     { dex: 'nomadex', rIn: 4757n, rOut: 9214n, bps: 1426 }],
    [506n,
     { dex: 'humbleswap', rIn: 229n, rOut: 4_549_500_000n, bps: 34 },
     { dex: 'nomadex', rIn: 73_940n, rOut: 399_610_000_000n, bps: 124 }],
    [4768n,
     { dex: 'humbleswap', rIn: 88_478n, rOut: 716_281n, bps: 132 },
     { dex: 'humbleswap', rIn: 2_264n, rOut: 161_515n, bps: 35 }],
  ];
  for (const [T, p1, p2] of cases) {
    const out1 = makeOut(p1), out2 = makeOut(p2);
    const seed = seedFor(T, p1, p2);
    const x = refineSplitAmount(T, out1, out2, seed);
    const gRef = out1(x) + out2(T - x);
    const { bestOut } = bruteOptimum(T, out1, out2);
    assert.ok(gRef >= out1(seed) + out2(T - seed), `${p1.dex}/${p2.dex} T=${T}: regressed vs seed`);
    assert.ok(bestOut - gRef <= FLOOR_NOISE_TOLERANCE,
      `${p1.dex}/${p2.dex} T=${T}: gap ${bestOut - gRef} exceeds noise bound`);
  }
});

test('randomized: never worse than seed and within floor-noise of the optimum', () => {
  // Deterministic LCG so the sweep is reproducible across runs.
  let state = 0x9e3779b9 >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const rnd = (a, b) => BigInt(a + (next() % (b - a)));
  const dex = () => (next() & 1) ? 'nomadex' : 'humbleswap';
  // Vary the reserve magnitude so the sweep exercises the sharp-plateau /
  // large-output regime (where a floored grid step strands a tail), not just
  // small reserves.
  const scales = [1, 1_000, 1_000_000, 1_000_000_000];
  for (let it = 0; it < 5000; it++) {
    const T = rnd(50, 3000);
    const scale = scales[next() % scales.length];
    const r = () => rnd(50, 20000) * BigInt(scale);
    const p1 = { dex: dex(), rIn: r(), rOut: r(), bps: 1 + (next() % 2500) };
    const p2 = { dex: dex(), rIn: r(), rOut: r(), bps: 1 + (next() % 2500) };
    const out1 = makeOut(p1), out2 = makeOut(p2);
    const seed = seedFor(T, p1, p2);
    const x = refineSplitAmount(T, out1, out2, seed);
    assert.equal(x + (T - x), T);
    const gRef = out1(x) + out2(T - x);
    assert.ok(gRef >= out1(seed) + out2(T - seed), `regressed vs seed at it=${it}`);
    const { bestOut } = bruteOptimum(T, out1, out2);
    assert.ok(bestOut - gRef <= FLOOR_NOISE_TOLERANCE, `it=${it} gap ${bestOut - gRef}`);
  }
});

test('BigInt-clean for reserves far above 2^53 (no Number precision loss)', () => {
  const T = 10_000_000_000n;
  const p1 = { dex: 'nomadex', rIn: 9_000_000_000_000_000_000n, rOut: 11_000_000_000_000_000_000n, bps: 30 };
  const p2 = { dex: 'humbleswap', rIn: 7_000_000_000_000_000_000n, rOut: 13_000_000_000_000_000_000n, bps: 50 };
  const out1 = makeOut(p1), out2 = makeOut(p2);
  const seed = seedFor(T, p1, p2);
  const x = refineSplitAmount(T, out1, out2, seed);
  assert.equal(typeof x, 'bigint');
  assert.equal(x + (T - x), T);
  const gRef = out1(x) + out2(T - x);
  assert.ok(gRef >= out1(seed) + out2(T - seed));
});

test('evaluation count is bounded (no unbounded loop) even for a huge input', () => {
  const T = 1_099_511_627_776n; // 2^40
  const p1 = { dex: 'nomadex', rIn: 5_000_000_000n, rOut: 250_000_000_000n, bps: 30 };
  const p2 = { dex: 'humbleswap', rIn: 20_000_000_000n, rOut: 900_000_000_000n, bps: 100 };
  let calls = 0;
  const rawOut1 = makeOut(p1), rawOut2 = makeOut(p2);
  const out1 = (x) => { calls++; return rawOut1(x); };
  const out2 = (y) => { calls++; return rawOut2(y); };
  const seed = seedFor(T, p1, p2);
  refineSplitAmount(T, out1, out2, seed);
  // K-ary zoom is O(log T) levels of O(K) samples, plus a <= K+1 residual scan.
  // A loose cap that still proves boundedness: nowhere near a scan of 2^40.
  assert.ok(calls < 4000, `evaluation count not bounded: ${calls}`);
});

test('residual scan stays bounded for an ENORMOUS uncapped input (P1 regression)', () => {
  // The quote endpoint does not cap `amount`, so an adversarial 2^400 input must
  // not make the zoom exit early (via its level cap) and leave a huge window for
  // the residual scan to walk one unit at a time. The MAX_LEVELS cap is sized
  // from T's bit length so the loop always exits via `hi - lo <= K`, bounding the
  // residual scan to <= K + 1 iterations. This completes near-instantly; a hang
  // would mean P1 regressed.
  const T = 2n ** 400n;
  const p1 = { dex: 'nomadex', rIn: 5_000_000_000n, rOut: 250_000_000_000n, bps: 30 };
  const p2 = { dex: 'humbleswap', rIn: 20_000_000_000n, rOut: 900_000_000_000n, bps: 100 };
  let calls = 0;
  const rawOut1 = makeOut(p1), rawOut2 = makeOut(p2);
  const out1 = (x) => { calls++; return rawOut1(x); };
  const out2 = (y) => { calls++; return rawOut2(y); };
  const x = refineSplitAmount(T, out1, out2, seedFor(T, p1, p2));
  assert.ok(x >= 0n && x <= T);
  assert.equal(x + (T - x), T);
  // ~ (bitlen+8) levels * (K+1) samples + residual; far below any linear scan.
  assert.ok(calls < 20000, `residual scan not bounded for 2^400: ${calls}`);
});

test('degenerate inputs: T <= 0 returns 0, T = 1 stays in range', () => {
  const out = (x) => x; // trivial monotone closure
  assert.equal(refineSplitAmount(0n, out, out, 0n), 0n);
  assert.equal(refineSplitAmount(-5n, out, out, 0n), 0n);
  const x = refineSplitAmount(1n, out, out, 0n);
  assert.ok(x === 0n || x === 1n);
});

test('accepts string/number total and seed identically to BigInt', () => {
  const p1 = { dex: 'nomadex', rIn: 40_000n, rOut: 1_800_000n, bps: 30 };
  const p2 = { dex: 'humbleswap', rIn: 90_000n, rOut: 2_800_000n, bps: 30 };
  const out1 = makeOut(p1), out2 = makeOut(p2);
  const a = refineSplitAmount('20000', out1, out2, '10000');
  const b = refineSplitAmount(20000n, out1, out2, 10000n);
  assert.equal(a, b);
});
