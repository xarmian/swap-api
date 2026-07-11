// TASK-23: when direct pools already match, handleQuote must NOT re-evaluate
// those same direct pairs through the multi-hop machinery. findRoutes' BFS
// re-emits every direct pair as a 1-hop route (path length > 0), and those
// 1-hop routes are priced through the very same calculateOptimalSplit that the
// direct path already runs over the identical pool set -- so a 1-hop route can
// only ever TIE the direct split and never wins the strict-greater comparison.
// handleQuote now filters findRoutes' output to genuinely-multi-hop (hops > 1)
// routes before handing them to findOptimalMultiHopRoute, and skips that pass
// entirely when none remain.
//
// These tests assert:
//   - findOptimalMultiHopRoute is only ever handed hops > 1 routes when a direct
//     match exists (the 1-hop duplicates are dropped),
//   - it is NOT called at all when the only routes are 1-hop duplicates,
//   - the selected route + amounts are exactly the direct-split result
//     (selection unchanged).
//
// The quote engine and its transport talk to algod/indexer several layers deep,
// so every handler dependency is mocked wholesale and lib/handlers.js is
// imported with a cache-busting query string so each test links a fresh module
// graph against its own mocks.
import test from 'node:test';
import assert from 'node:assert/strict';

let importSeq = 0;
async function importFreshHandlers() {
  importSeq += 1;
  return import(`../lib/handlers.js?skipDirectMultiHopTest=${importSeq}`);
}

// A minimal Express-style res that captures status + body.
function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  return res;
}

// Direct-split result shape handleQuote consumes: splitDetails[].{poolCfg,
// amount, expectedOutput, minOutput, quote.priceImpact} plus a platformFee.
function directSplitResult(poolId, output) {
  return {
    splitDetails: [{
      poolCfg: { poolId, dex: 'humbleswap' },
      amount: '1000',
      expectedOutput: String(output),
      minOutput: String(output),
      quote: { priceImpact: 0 }
    }],
    platformFee: { gain: '0', feeAmount: '0', feeBps: 0, feeAddress: null, applied: false },
    skippedPools: [],
    succeededPoolIds: [String(poolId)]
  };
}

function mockUtilsPricesSupabaseTxns(t) {
  t.mock.module('../lib/utils.js', {
    namedExports: {
      getTokenDecimals: async () => 6,
      calculateRate: () => 1
    }
  });
  t.mock.module('../lib/prices.js', {
    namedExports: { fetchTokenPrices: async () => ({}) }
  });
  t.mock.module('../lib/supabase.js', {
    namedExports: { logQuoteRequest: () => {}, logUnwrapRequest: () => {} }
  });
  t.mock.module('../lib/transactions.js', {
    namedExports: {
      buildSwapTransactions: async () => { throw new Error('transactions must not be built (no address)'); },
      buildBatchUnwrapTransactions: async () => { throw new Error('not used'); }
    }
  });
}

test('direct match: only hops>1 routes reach findOptimalMultiHopRoute; 1-hop duplicates dropped', async (t) => {
  const findOptimalCalls = [];
  mockUtilsPricesSupabaseTxns(t);

  t.mock.module('../lib/quotes.js', {
    namedExports: {
      calculateOptimalSplit: async () => directSplitResult(111, 500),
      findOptimalMultiHopRoute: async (routes) => {
        findOptimalCalls.push(routes);
        // Return a genuinely worse multi-hop quote so the direct split still wins
        // the strict-greater comparison -- selection must stay on the direct route.
        return { quote: { outputAmount: '400', minimumOutputAmount: '400', priceImpact: 0, hopQuotes: [], skippedPools: [] } };
      },
      createPoolInfoCache: () => ({ get: async () => null, peek: () => null })
    }
  });

  const oneHop = { poolOptions: [[{ poolId: 111, dex: 'humbleswap' }]], intermediateTokens: [], hops: 1, tokenSequence: [1, 2] };
  const twoHop = { poolOptions: [[{ poolId: 222, dex: 'humbleswap' }], [{ poolId: 333, dex: 'humbleswap' }]], intermediateTokens: [9], hops: 2, tokenSequence: [1, 9, 2] };

  t.mock.module('../lib/config.js', {
    namedExports: {
      getPoolConfigById: () => null,
      findMatchingPools: () => [{ poolId: 111, dex: 'humbleswap' }],
      findRoutes: () => [oneHop, twoHop],
      getDiscoveryStatus: () => null,
      getUnderlyingForWrapped: () => null
    }
  });

  const { handleQuote } = await importFreshHandlers();
  const res = mockRes();
  await handleQuote({}, res, { inputToken: 1, outputToken: 2, amount: '1000', slippage: 0.01, address: undefined, poolId: undefined, dex: undefined });

  assert.equal(findOptimalCalls.length, 1, 'findOptimalMultiHopRoute called exactly once');
  const routesPassed = findOptimalCalls[0];
  assert.ok(Array.isArray(routesPassed), 'routes passed as an array');
  assert.equal(routesPassed.length, 1, 'only the genuinely multi-hop route is passed');
  assert.ok(routesPassed.every(r => r.hops > 1), 'no 1-hop (direct-duplicate) route reaches the multi-hop machinery');
  assert.equal(routesPassed[0], twoHop, 'the 2-hop route is the one evaluated');

  // Selection unchanged: the direct split (500) beats the worse multi-hop (400).
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.quote.outputAmount, '500', 'direct-split output selected');
  assert.equal(res.body.route.type, 'direct', 'direct route selected');
  assert.equal(res.body.poolId, '111', 'direct pool reported');
});

test('direct match with only 1-hop routes: findOptimalMultiHopRoute is never called', async (t) => {
  let findOptimalCallCount = 0;
  mockUtilsPricesSupabaseTxns(t);

  t.mock.module('../lib/quotes.js', {
    namedExports: {
      calculateOptimalSplit: async () => directSplitResult(111, 500),
      findOptimalMultiHopRoute: async () => { findOptimalCallCount += 1; return null; },
      createPoolInfoCache: () => ({ get: async () => null, peek: () => null })
    }
  });

  const oneHopA = { poolOptions: [[{ poolId: 111, dex: 'humbleswap' }]], intermediateTokens: [], hops: 1, tokenSequence: [1, 2] };
  const oneHopB = { poolOptions: [[{ poolId: 112, dex: 'nomadex' }]], intermediateTokens: [], hops: 1, tokenSequence: [1, 2] };

  t.mock.module('../lib/config.js', {
    namedExports: {
      getPoolConfigById: () => null,
      findMatchingPools: () => [{ poolId: 111, dex: 'humbleswap' }],
      findRoutes: () => [oneHopA, oneHopB],
      getDiscoveryStatus: () => null,
      getUnderlyingForWrapped: () => null
    }
  });

  const { handleQuote } = await importFreshHandlers();
  const res = mockRes();
  await handleQuote({}, res, { inputToken: 1, outputToken: 2, amount: '1000', slippage: 0.01, address: undefined, poolId: undefined, dex: undefined });

  assert.equal(findOptimalCallCount, 0, 'multi-hop machinery skipped entirely when only 1-hop duplicates exist');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.quote.outputAmount, '500', 'direct-split output selected unchanged');
  assert.equal(res.body.route.type, 'direct');
  assert.equal(res.body.poolId, '111');
});

test('broken platform fee (BPS > 10000): 1-hop routes are STILL pruned (fee now capped at gain)', async (t) => {
  // TASK-51: calculateOptimalSplit now caps the platform fee at the realized
  // gain, so even under a misconfigured PLATFORM_FEE_BPS > 10000 the fee-adjusted
  // split can never fall below the best single pool -- at worst it TIES the
  // baseline. A fee-free 1-hop concrete single-pool route can therefore no longer
  // legitimately beat the direct split, so handleQuote prunes the 1-hop
  // duplicates UNCONDITIONALLY. With only a 1-hop route present, the multi-hop
  // pass is skipped entirely and the direct split is selected. This replaces the
  // pre-cap PR #26 behavior (which fell back to evaluating all routes here).
  let findOptimalCallCount = 0;
  mockUtilsPricesSupabaseTxns(t);

  t.mock.module('../lib/quotes.js', {
    namedExports: {
      // Direct split: raw split 1010 minus a >100% fee CAPPED at the gain (10)
      // ties the best single pool at 1000 -- never below it.
      calculateOptimalSplit: async () => directSplitResult(111, 1000),
      findOptimalMultiHopRoute: async () => { findOptimalCallCount += 1; return null; },
      createPoolInfoCache: () => ({ get: async () => null, peek: () => null })
    }
  });

  const oneHop = { poolOptions: [[{ poolId: 111, dex: 'humbleswap' }]], intermediateTokens: [], hops: 1, tokenSequence: [1, 2] };

  t.mock.module('../lib/config.js', {
    namedExports: {
      getPoolConfigById: () => null,
      findMatchingPools: () => [{ poolId: 111, dex: 'humbleswap' }],
      findRoutes: () => [oneHop],
      getDiscoveryStatus: () => null,
      getUnderlyingForWrapped: () => null
    }
  });

  const { handleQuote } = await importFreshHandlers();
  const res = mockRes();
  await handleQuote({}, res, { inputToken: 1, outputToken: 2, amount: '1000', slippage: 0.01, address: undefined, poolId: undefined, dex: undefined });

  assert.equal(findOptimalCallCount, 0, 'multi-hop machinery skipped: the 1-hop duplicate is pruned even under a broken fee config');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.quote.outputAmount, '1000', 'the capped direct split is selected (never below baseline)');
  assert.equal(res.body.route.type, 'direct');
  assert.equal(res.body.poolId, '111');
});
