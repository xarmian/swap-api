// Unit tests for the pure split/fee helpers in lib/quotes.js.
// Run with: node --test tests/quotes-helpers.test.js
//
// resolveFee, generateSplitRatios and allocateAmounts are pure (no chain access),
// so they are exported for testing and imported REAL here. Importing quotes.js
// transitively pulls in algosdk via lib/clients.js but makes no network call at
// import time, so the suite stays hermetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFee, generateSplitRatios, allocateAmounts, skipReconcileKey, mergeSkippedPools } from '../lib/quotes.js';

// --- resolveFee ------------------------------------------------------------

test('resolveFee: uses the live fee when there is no config override', () => {
  assert.equal(resolveFee(null, 30), 30);
  assert.equal(resolveFee(undefined, 25), 25);
});

test('resolveFee: a config override takes precedence over the live fee', () => {
  assert.equal(resolveFee(15, 30), 15);
  // Explicit 0 override is honored (0 is a valid fee, not "missing").
  assert.equal(resolveFee(0, 30), 0);
});

test('resolveFee: accepts a bigint fee', () => {
  assert.equal(resolveFee(30n, null), 30);
});

test('resolveFee: rejects coercion traps that Number() would silently turn into 0', () => {
  // null/undefined for BOTH sources, empty string, whitespace, booleans:
  // Number() maps these to 0, which would silently drop the fee and overstate
  // output — resolveFee must throw instead.
  assert.throws(() => resolveFee(null, null), /Invalid pool fee/);
  assert.throws(() => resolveFee(undefined, undefined), /Invalid pool fee/);
  assert.throws(() => resolveFee('', null), /Invalid pool fee/);
  assert.throws(() => resolveFee('  ', null), /Invalid pool fee/);
  assert.throws(() => resolveFee(false, null), /Invalid pool fee/);
});

test('resolveFee: rejects out-of-range and non-integer fees', () => {
  assert.throws(() => resolveFee(-1, null), /Invalid pool fee/);
  assert.throws(() => resolveFee(10000, null), /Invalid pool fee/);   // >= 100%
  assert.throws(() => resolveFee(30.5, null), /Invalid pool fee/);
  assert.throws(() => resolveFee(NaN, null), /Invalid pool fee/);
});

// --- generateSplitRatios ---------------------------------------------------

test('generateSplitRatios: n=1 yields the single (and its duplicate equal-split)', () => {
  // 1 "single" vector + 1 "equal split across all" vector, which coincide at n=1.
  assert.deepEqual(generateSplitRatios(1), [[1], [1]]);
});

test('generateSplitRatios: count is n singles + C(n,2) pairs + 1 equal-split', () => {
  for (const n of [2, 3, 4]) {
    const pairs = (n * (n - 1)) / 2;
    assert.equal(generateSplitRatios(n).length, n + pairs + 1, `n=${n}`);
  }
});

test('generateSplitRatios: every vector has length n and weights summing to 1', () => {
  for (const n of [2, 3, 5]) {
    for (const v of generateSplitRatios(n)) {
      assert.equal(v.length, n);
      const sum = v.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 1) < 1e-12, `weights must sum to 1 (got ${sum})`);
    }
  }
});

test('generateSplitRatios: includes the pure singles and a 50/50 pair', () => {
  const v = generateSplitRatios(2);
  assert.ok(v.some(r => r[0] === 1 && r[1] === 0));
  assert.ok(v.some(r => r[0] === 0 && r[1] === 1));
  assert.ok(v.some(r => r[0] === 0.5 && r[1] === 0.5));
});

// --- allocateAmounts -------------------------------------------------------

test('allocateAmounts: parts always sum EXACTLY to the total', () => {
  const cases = [
    [1_000_000n, [0.5, 0.5]],
    [1_000_001n, [0.5, 0.5]],           // odd total, remainder must be absorbed
    [1_000_000n, [1 / 3, 1 / 3, 1 / 3]],
    [7n, [0.25, 0.25, 0.5]],
    [1n, [0.5, 0.5]],                    // tiny total: every slot floors to 0n
  ];
  for (const [total, ratios] of cases) {
    const parts = allocateAmounts(total, ratios);
    const sum = parts.reduce((a, b) => a + b, 0n);
    assert.equal(sum, total, `sum(${parts}) must equal ${total}`);
  }
});

test('allocateAmounts: remainder lands in the last positive-ratio slot (no dust in a zero slot)', () => {
  // total=1 split 50/50: both floor to 0; remainder goes to the last funded slot.
  assert.deepEqual(allocateAmounts(1n, [0.5, 0.5]), [0n, 1n]);
  // A zero-ratio slot must receive exactly nothing.
  const parts = allocateAmounts(1_000_001n, [0.5, 0, 0.5]);
  assert.equal(parts[1], 0n);
  assert.equal(parts.reduce((a, b) => a + b, 0n), 1_000_001n);
});

test('allocateAmounts: 100%-to-one-pool leaves the others at exactly 0n', () => {
  assert.deepEqual(allocateAmounts(500n, [1, 0]), [500n, 0n]);
  assert.deepEqual(allocateAmounts(3n, [0, 1]), [0n, 3n]);
});

// --- skipReconcileKey / mergeSkippedPools ----------------------------------
// (dex, poolId) reconciliation: matches the pool cache-key discipline (PR #23)
// so skip/success bookkeeping never collides two pools by numeric poolId alone.

test('skipReconcileKey: composes ${dex}:${poolId} and defaults dex to humbleswap', () => {
  assert.equal(skipReconcileKey({ poolId: 123, dex: 'nomadex' }), 'nomadex:123');
  assert.equal(skipReconcileKey({ poolId: '123', dex: 'humbleswap' }), 'humbleswap:123');
  // Missing dex defaults to 'humbleswap' (the PR #23 default) so an implicit-dex
  // config still matches an explicit humbleswap entry for the same poolId.
  assert.equal(skipReconcileKey({ poolId: 123 }), 'humbleswap:123');
  assert.equal(skipReconcileKey({ poolId: 123, dex: undefined }), 'humbleswap:123');
});

test('mergeSkippedPools: two entries with the same poolId but different dex do NOT collide', () => {
  const merged = mergeSkippedPools(
    [{ poolId: '123', dex: 'humbleswap', reason: 'error' }],
    [{ poolId: '123', dex: 'nomadex', reason: 'timeout' }]
  );
  assert.equal(merged.length, 2);
  assert.deepEqual(merged, [
    { poolId: '123', dex: 'humbleswap', reason: 'error' },
    { poolId: '123', dex: 'nomadex', reason: 'timeout' }
  ]);
});

test('mergeSkippedPools: same (dex, poolId) is deduped, first occurrence wins', () => {
  const merged = mergeSkippedPools(
    [{ poolId: '123', dex: 'nomadex', reason: 'error' }],
    [{ poolId: '123', dex: 'nomadex', reason: 'timeout' }]
  );
  assert.deepEqual(merged, [{ poolId: '123', dex: 'nomadex', reason: 'error' }]);
});

test('mergeSkippedPools: implicit-dex entry dedupes against an explicit humbleswap entry', () => {
  const merged = mergeSkippedPools(
    [{ poolId: '123', reason: 'error' }],
    [{ poolId: '123', dex: 'humbleswap', reason: 'timeout' }]
  );
  assert.deepEqual(merged, [{ poolId: '123', reason: 'error' }]);
});
