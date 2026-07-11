// TASK-51: the platform fee is capped at the realized gain.
//
// calculateOptimalSplit charges a platform fee ONLY when a multi-pool split
// strictly beats the best single pool, on the `gain` (split output minus best
// single-pool output). The fee is now capped at that gain:
//   feeAmount = min(gain * feeBps / 10000, gain)   (BigInt throughout)
//
// Consequences these tests pin down:
//   - For every real config (feeBps <= 10000) the cap is a strict NO-OP:
//     feeAmount == gain*feeBps/10000, identical to the pre-cap behavior.
//   - For a misconfigured feeBps > 10000 the fee is capped at `gain`, so the
//     fee-adjusted split output stays >= the best single-pool baseline and the
//     user is never pushed below it. This is the ONLY behavioral change.
//   - feeAmount NEVER exceeds gain in any configuration.
//
// The quote engine talks to algod/indexer several layers deep, so we mock
// lib/nomadex.js / lib/utils.js / lib/config.js wholesale (exactly the symbols
// the split path touches) and import lib/quotes.js with a cache-busting query
// string so each test links a fresh module graph against its own mocks. Two
// equal-reserve Nomadex pools with a deliberately CONCAVE output curve make a
// 50/50 split genuinely beat either single pool, so a real `gain` exists.
import test from 'node:test';
import assert from 'node:assert/strict';

let importSeq = 0;
async function importFreshQuotes() {
  importSeq += 1;
  return import(`../lib/quotes.js?platformFeeCapTest=${importSeq}`);
}

// Concave output curve keyed on the exact candidate input amounts the 2-pool
// split path probes: full amount (1_000_000 -> 500 into ONE pool) vs a 50/50
// leg (500_000 -> 300 into EACH pool). So a 50/50 split yields 300+300 = 600,
// strictly beating the best single pool's 500 -> gain = 100.
function twoPoolCurve(amountIn) {
  const a = BigInt(amountIn);
  if (a === 1_000_000n) return 500n;
  if (a === 500_000n) return 300n;
  return a / 2n;
}

// Constant-product output curve out(a) = R*a/(K+a) -- genuinely concave for ANY
// input, so splitting a trade across N equal-reserve pools beats one pool. Used
// by the 3+-pool path (which grid-searches arbitrary allocations, not just the
// two keyed amounts above).
function ammCurve(amountIn) {
  const a = BigInt(amountIn);
  if (a <= 0n) return 0n;
  const R = 1_000_000n;
  const K = 1_000_000n;
  return (R * a) / (K + a);
}

function mockSplitDeps(t, outFn = twoPoolCurve) {
  t.mock.module('../lib/utils.js', {
    namedExports: {
      getTokenDecimals: async () => 6,
      calculatePriceImpact: () => 0,
      // Seed contributes an endpoint (0 -> "100% pool2"); the refinement forces
      // the interior 50/50 split that actually wins.
      calculateOptimalSplitAmount: () => 0n,
      refineSplitAmount: (total) => total / 2n,
      calculateRate: () => 1,
      // Identity slippage so minOutput mirrors expectedOutput and we can assert
      // the fee cap flows into the enforced min-received identically.
      applySlippageToOutput: (out) => out
    }
  });
  t.mock.module('../lib/config.js', {
    namedExports: {
      getPoolConfigById: () => null,
      generateRouteCombinations: () => [],
      findMatchingPools: () => [],
      findRoutes: () => [],
      getDiscoveryStatus: () => null,
      getUnderlyingForWrapped: () => null
    }
  });
  t.mock.module('../lib/nomadex.js', {
    namedExports: {
      NOMADEX_FEE_SCALE: 10000n,
      getPoolInfo: async () => ({ tokA: 1, tokB: 2, reserveA: 1_000_000n, reserveB: 1_000_000n, fee: 30, feeScale: 10000n }),
      calculateOutputAmount: (amountIn) => outFn(amountIn)
    }
  });
  t.mock.module('../lib/humbleswap.js', {
    namedExports: {
      getPoolInfo: async () => { throw new Error('humbleswap not used'); },
      calculateOutputAmount: () => 0n,
      resolveWrappedTokens: () => ({ inputWrapped: 0, outputWrapped: 0 }),
      validateWrappedPair: () => true
    }
  });
}

// Equal-reserve Nomadex pools over token pair (1, 2).
function pools(n) {
  return Array.from({ length: n }, (_, i) => ({
    poolId: 7001 + i, dex: 'nomadex', tokens: { tokA: { id: 1 }, tokB: { id: 2 } }
  }));
}

async function runSplit(feeBps, feeAddr, poolCount = 2) {
  const { createPoolInfoCache, calculateOptimalSplit } = await importFreshQuotes();
  const prevBps = process.env.PLATFORM_FEE_BPS;
  const prevAddr = process.env.PLATFORM_FEE_ADDR;
  process.env.PLATFORM_FEE_BPS = String(feeBps);
  if (feeAddr === null) delete process.env.PLATFORM_FEE_ADDR;
  else process.env.PLATFORM_FEE_ADDR = feeAddr;
  try {
    return await calculateOptimalSplit(pools(poolCount), 1, 2, 1_000_000n, 0.01, '', createPoolInfoCache());
  } finally {
    if (prevBps === undefined) delete process.env.PLATFORM_FEE_BPS; else process.env.PLATFORM_FEE_BPS = prevBps;
    if (prevAddr === undefined) delete process.env.PLATFORM_FEE_ADDR; else process.env.PLATFORM_FEE_ADDR = prevAddr;
  }
}

function sumExpected(splitDetails) {
  return splitDetails.reduce((s, leg) => s + BigInt(leg.expectedOutput), 0n);
}
function sumMin(splitDetails) {
  return splitDetails.reduce((s, leg) => s + BigInt(leg.minOutput), 0n);
}

test('real config (feeBps=5000): cap is a strict no-op; fee = gain*bps/10000 < gain', async (t) => {
  mockSplitDeps(t);
  const result = await runSplit(5000, 'FEEADDR');

  // A genuine 2-pool split won.
  assert.equal(result.splitDetails.length, 2, 'a 2-pool split is selected');
  assert.equal(result.platformFee.applied, true, 'platform fee applied to the multi-pool winner');

  const gain = BigInt(result.platformFee.gain);
  const feeAmount = BigInt(result.platformFee.feeAmount);
  assert.equal(gain, 100n, 'gain = split(600) - best single(500)');

  // Cap is a no-op here: feeAmount equals the uncapped gain*feeBps/10000.
  const uncapped = (gain * 5000n) / 10000n;
  assert.equal(feeAmount, uncapped, 'feeAmount equals the uncapped value (cap no-op)');
  assert.equal(feeAmount, 50n, 'fee = 100 * 5000 / 10000 = 50');
  assert.ok(feeAmount < gain, 'fee is strictly below gain for feeBps < 10000');

  // Fee-adjusted split still beats the single-pool baseline (600 - 50 = 550).
  assert.equal(sumExpected(result.splitDetails), 550n, 'split output net of fee');
  assert.ok(sumExpected(result.splitDetails) >= 500n, 'net split >= single-pool baseline');
  // Cap flows into the enforced min-received identically (identity slippage).
  assert.equal(sumMin(result.splitDetails), sumExpected(result.splitDetails), 'min-received tracks expected after fee');
});

test('misconfig (feeBps=20000): fee capped at gain; user never pushed below baseline', async (t) => {
  mockSplitDeps(t);
  const result = await runSplit(20000, 'FEEADDR');

  assert.equal(result.splitDetails.length, 2, 'a 2-pool split is selected');
  assert.equal(result.platformFee.applied, true, 'platform fee applied to the multi-pool winner');

  const gain = BigInt(result.platformFee.gain);
  const feeAmount = BigInt(result.platformFee.feeAmount);
  assert.equal(gain, 100n, 'gain unchanged (selection is by raw output)');

  // Uncapped would be 100 * 20000 / 10000 = 200 (> gain); the cap clamps to gain.
  assert.equal(feeAmount, gain, 'fee is capped exactly at the realized gain');
  assert.ok(feeAmount < 200n, 'fee is strictly below the uncapped 200');

  // Fee-adjusted split ties the single-pool baseline (600 - 100 = 500) and is
  // NEVER below it -- the inversion PR #26's guard protected against is gone.
  assert.equal(sumExpected(result.splitDetails), 500n, 'net split == single-pool baseline (not below)');
  assert.ok(sumExpected(result.splitDetails) >= 500n, 'net split >= single-pool baseline');
  assert.equal(sumMin(result.splitDetails), sumExpected(result.splitDetails), 'min-received tracks expected after fee');
});

test('invariant: feeAmount never exceeds gain across a sweep of feeBps', async (t) => {
  mockSplitDeps(t);
  for (const feeBps of [1, 100, 5000, 9999, 10000, 10001, 20000, 1000000]) {
    const result = await runSplit(feeBps, 'FEEADDR');
    const gain = BigInt(result.platformFee.gain);
    const feeAmount = BigInt(result.platformFee.feeAmount);
    assert.ok(feeAmount <= gain, `feeAmount (${feeAmount}) must not exceed gain (${gain}) at feeBps=${feeBps}`);
    // Net split output is always >= the single-pool baseline (500).
    assert.ok(sumExpected(result.splitDetails) >= 500n, `net split >= baseline at feeBps=${feeBps}`);
  }
});

test('3+-pool path: fee also capped at gain (both fee sites covered)', async (t) => {
  // Exercises the separate 3+-pool fee-application site with a genuinely concave
  // AMM curve, so a multi-pool grid split beats the best single pool.
  mockSplitDeps(t, ammCurve);
  const baseline = ammCurve(1_000_000n); // best single-pool output

  for (const feeBps of [5000, 10000, 20000, 1000000]) {
    const result = await runSplit(feeBps, 'FEEADDR', 3);
    assert.ok(result.splitDetails.length >= 2, `a multi-pool split is selected at feeBps=${feeBps}`);
    assert.equal(result.platformFee.applied, true, `fee applied at feeBps=${feeBps}`);

    const gain = BigInt(result.platformFee.gain);
    const feeAmount = BigInt(result.platformFee.feeAmount);
    assert.ok(gain > 0n, `a real gain exists at feeBps=${feeBps}`);
    assert.ok(feeAmount <= gain, `3+-pool feeAmount (${feeAmount}) must not exceed gain (${gain}) at feeBps=${feeBps}`);
    if (feeBps > 10000) {
      assert.equal(feeAmount, gain, `3+-pool fee capped exactly at gain at feeBps=${feeBps}`);
    } else {
      assert.equal(feeAmount, (gain * BigInt(feeBps)) / 10000n, `3+-pool cap is a no-op at feeBps=${feeBps}`);
    }
    // Net split output never pushed below the single-pool baseline.
    assert.ok(sumExpected(result.splitDetails) >= baseline, `net split >= baseline at feeBps=${feeBps}`);
    assert.equal(sumMin(result.splitDetails), sumExpected(result.splitDetails), `min tracks expected at feeBps=${feeBps}`);
  }
});
