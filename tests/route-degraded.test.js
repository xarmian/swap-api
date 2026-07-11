// Regression tests for TASK-44 (degrade + signal on pool quote failure).
// Run with: node --experimental-test-module-mocks --test tests/route-degraded.test.js
//
// calculateOptimalSplit's real dependencies (lib/nomadex.js's getPoolInfo,
// lib/humbleswap.js's getPoolInfo) talk to algod/indexer several layers deep
// (application global state, account info, ARC-200 contract reads), so a
// hermetic test mocks those modules wholesale via node:test's `mock.module`
// rather than faking on-chain responses. This isolates exactly the behavior
// under test: when one pool's quote throws mid-request, calculateOptimalSplit
// must (a) still return a valid quote for the pool(s) that DID respond, and
// (b) report the failed pool in `skippedPools` with a reason, WITHOUT ever
// reporting a pool that had no error (no false positives - CONVE-35).
//
// Each test uses its own `t.mock.module` (auto-restored when the test ends,
// so re-mocking the same specifier across tests doesn't hit node:test's
// "module is already mocked" guard) AND imports lib/quotes.js with a unique
// cache-busting query string, so the module graph is re-linked fresh against
// THAT test's mocks rather than reusing another test's already-cached graph
// (ESM module instances - and the live bindings within them - are cached by
// resolved specifier, so a bare `import('../lib/quotes.js')` in a later test
// would otherwise silently keep resolving to the first test's mocked nomadex.js).
import test from 'node:test';
import assert from 'node:assert/strict';

const WORKING_POOL_ID = 9111;
const FAILING_POOL_ID = 9222;

const workingPoolCfg = { poolId: WORKING_POOL_ID, dex: 'nomadex', tokens: { tokA: { id: 1 }, tokB: { id: 2 } } };
const failingPoolCfg = { poolId: FAILING_POOL_ID, dex: 'nomadex', tokens: { tokA: { id: 1 }, tokB: { id: 2 } } };

function mockDeps(t, getFailingPoolInfo) {
  t.mock.module('../lib/nomadex.js', {
    namedExports: {
      NOMADEX_FEE_SCALE: 10000n,
      getPoolInfo: async (poolId) => {
        if (Number(poolId) === FAILING_POOL_ID) {
          return getFailingPoolInfo();
        }
        return { tokA: 1, tokB: 2, reserveA: 1_000_000n, reserveB: 1_000_000n, fee: 30, feeScale: 10000n };
      },
      // Deterministic stand-in for the constant-product curve - the exact
      // shape doesn't matter here, only that responding pools produce a
      // non-zero, self-consistent output.
      calculateOutputAmount: (amountIn) => {
        const amt = BigInt(amountIn);
        return amt > 0n ? amt / 2n : 0n;
      }
    }
  });

  // Not exercised by these nomadex-only test pools, but statically imported
  // by lib/quotes.js so the module must resolve.
  t.mock.module('../lib/humbleswap.js', {
    namedExports: {
      getPoolInfo: async () => { throw new Error('humbleswap not used in this test'); },
      calculateOutputAmount: () => 0n,
      resolveWrappedTokens: () => ({ inputWrapped: 0, outputWrapped: 0 }),
      validateWrappedPair: () => true
    }
  });

  t.mock.module('../lib/config.js', {
    namedExports: {
      getPoolConfigById: (id) => (Number(id) === WORKING_POOL_ID ? workingPoolCfg : failingPoolCfg),
      generateRouteCombinations: () => [],
      findMatchingPools: () => [],
      findRoutes: () => [],
      getDiscoveryStatus: () => null,
      getUnderlyingForWrapped: () => null
    }
  });

  t.mock.module('../lib/utils.js', {
    namedExports: {
      getTokenDecimals: async () => 6,
      calculatePriceImpact: () => 0,
      calculateOptimalSplitAmount: () => 0n,
      refineSplitAmount: (total) => total / 2n,
      calculateRate: () => 1,
      applySlippageToOutput: (out) => out
    }
  });
}

// Cache-busting import so each test links a fresh lib/quotes.js module graph
// against that test's own mocks (see file-header comment).
let importSeq = 0;
async function importFreshQuotes() {
  importSeq += 1;
  return import(`../lib/quotes.js?routeDegradedTest=${importSeq}`);
}

test('routeDegraded signal: a timed-out pool is reported in skippedPools with reason "timeout" and excluded from splitDetails', async (t) => {
  mockDeps(t, () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  });

  const { calculateOptimalSplit } = await importFreshQuotes();
  const result = await calculateOptimalSplit(
    [workingPoolCfg, failingPoolCfg],
    1, 2, 1000n, 0.01, ''
  );

  // The responding pool's quote is still returned, unaffected.
  assert.equal(result.splitDetails.length, 1);
  assert.equal(String(result.splitDetails[0].poolCfg.poolId), String(WORKING_POOL_ID));
  assert.equal(result.splitDetails[0].expectedOutput, '500');

  // The failed pool is signaled, not silently dropped. The entry carries `dex`
  // so skip/success reconciliation keys on (dex, poolId), not poolId alone.
  assert.deepEqual(result.skippedPools, [{ poolId: String(FAILING_POOL_ID), dex: 'nomadex', reason: 'timeout' }]);

  // This is exactly the condition lib/handlers.js uses for routeDegraded.
  const routeDegraded = result.skippedPools.length > 0;
  assert.equal(routeDegraded, true);
});

test('routeDegraded signal: a non-timeout thrown error is classified as reason "error"', async (t) => {
  mockDeps(t, () => { throw new Error('Invalid application info'); });

  const { calculateOptimalSplit } = await importFreshQuotes();
  const result = await calculateOptimalSplit(
    [workingPoolCfg, failingPoolCfg],
    1, 2, 1000n, 0.01, ''
  );

  assert.deepEqual(result.skippedPools, [{ poolId: String(FAILING_POOL_ID), dex: 'nomadex', reason: 'error' }]);
});

test('routeDegraded signal: no false positive when every pool responds successfully', async (t) => {
  // "Failing" pool actually succeeds this time - no error is ever thrown.
  mockDeps(t, () => ({ tokA: 1, tokB: 2, reserveA: 1_000_000n, reserveB: 1_000_000n, fee: 30, feeScale: 10000n }));

  const { calculateOptimalSplit } = await importFreshQuotes();
  const result = await calculateOptimalSplit(
    [workingPoolCfg, failingPoolCfg],
    1, 2, 1000n, 0.01, ''
  );

  // No pool errored, so there is nothing to signal - regardless of which
  // pool(s) the optimizer ultimately picked for the best price.
  assert.ok(result.splitDetails.length >= 1);
  assert.deepEqual(result.skippedPools, []);
  const routeDegraded = result.skippedPools.length > 0;
  assert.equal(routeDegraded, false);
});

test('routeDegraded signal: a pool that fails the info pre-fetch but recovers on the full-quote retry is NOT reported as skipped', async (t) => {
  // Reproduces a pool that hiccups on calculateOptimalSplit's initial
  // Promise.all pre-fetch (recordSkip fires there) but whose actual quote
  // then succeeds because calculateQuoteForPool re-fetches internally when
  // the pool-info cache is empty (recordSuccess must cancel the earlier
  // recordSkip - a transient pre-fetch blip that self-heals is not a
  // "route degraded" event).
  let calls = 0;
  mockDeps(t, () => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    return { tokA: 1, tokB: 2, reserveA: 1_000_000n, reserveB: 1_000_000n, fee: 30, feeScale: 10000n };
  });

  const { calculateOptimalSplit } = await importFreshQuotes();
  const result = await calculateOptimalSplit(
    [workingPoolCfg, failingPoolCfg],
    1, 2, 1000n, 0.01, ''
  );

  assert.ok(calls >= 2, 'the failing pool must have been queried more than once (pre-fetch + retry)');
  assert.deepEqual(result.skippedPools, []);
  const routeDegraded = result.skippedPools.length > 0;
  assert.equal(routeDegraded, false);
});
