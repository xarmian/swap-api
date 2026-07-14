// TASK-22: findOptimalMultiHopRoute must not evaluate single-pool-per-hop routes
// twice. Before this change every route was priced BOTH via the per-hop-splitting
// (poolOptions) pass AND via the concrete cartesian combination(s) -- and for a
// route whose every hop has exactly one pool the concrete combination is
// identical to the split pass, so it was pure duplicated work. These tests assert
// that:
//   - the concrete enumeration (generateRouteCombinations) is NEVER invoked for a
//     single-pool-per-hop route, and each pool is priced exactly once per request,
//   - the selected quote's amounts are exactly what a single evaluation produces,
//   - multi-pool-per-hop routes still enumerate concrete combinations (the split
//     applies a platform fee that a concrete single-pool leg does not, so the
//     concrete pass can legitimately win and must NOT be skipped),
//   - every candidate reuses the ONE shared request-scoped poolInfoCache (each
//     distinct pool fetched at most once even across concurrent candidates).
//
// Like pool-info-cache.test.js, the real getPoolInfo implementations talk to
// algod/indexer several layers deep, so we mock lib/nomadex.js / lib/humbleswap.js
// / lib/config.js wholesale and import lib/quotes.js with a cache-busting query
// string so each test links a fresh module graph against its own mocks.
import test from 'node:test';
import assert from 'node:assert/strict';

let importSeq = 0;
async function importFreshQuotes() {
  importSeq += 1;
  return import(`../lib/quotes.js?routeDedupTest=${importSeq}`);
}

// utils mock: identity-ish math so outputs are exact and predictable.
function mockUtils(t) {
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

test('single-pool-per-hop route: concrete enumeration is skipped and each pool priced once', async (t) => {
  let humbleFetches = 0;
  let humbleQuotes = 0;
  let genCombosCalls = 0;
  mockUtils(t);

  t.mock.module('../lib/humbleswap.js', {
    namedExports: {
      getPoolInfo: async () => { humbleFetches += 1; return { tokA: 100, tokB: 200, poolBals: { A: 1_000_000n, B: 1_000_000n }, protoInfo: { totFee: 30 } }; },
      calculateOutputAmount: (amountIn) => { humbleQuotes += 1; const a = BigInt(amountIn); return a > 0n ? a / 2n : 0n; },
      resolveWrappedTokens: () => ({ inputWrapped: 100, outputWrapped: 200 }),
      validateWrappedPair: () => true
    }
  });
  t.mock.module('../lib/nomadex.js', {
    namedExports: {
      NOMADEX_FEE_SCALE: 10000n,
      getPoolInfo: async () => { throw new Error('nomadex not used in this test'); },
      calculateOutputAmount: () => 0n
    }
  });
  t.mock.module('../lib/config.js', {
    namedExports: {
      getPoolConfigById: () => null,
      // Spy: this MUST NOT be called for a single-pool-per-hop route. If it ever
      // is, the concrete-combination pass was not skipped.
      generateRouteCombinations: (route) => {
        genCombosCalls += 1;
        return [{ pools: route.poolOptions.map(opts => opts[0]), intermediateTokens: route.intermediateTokens, hops: route.hops }];
      },
      findMatchingPools: () => [],
      findRoutes: () => [],
      getDiscoveryStatus: () => null,
      getUnderlyingForWrapped: () => null,
      // TASK-26: lib/quotes.js now imports this alongside generateRouteCombinations.
      MAX_ROUTE_COMBINATIONS: 10
    }
  });

  const { findOptimalMultiHopRoute, createPoolInfoCache } = await importFreshQuotes();
  const cache = createPoolInfoCache();

  // A 2-hop route (1 -> 2 -> 3) with exactly one pool per hop.
  const poolA = { poolId: 111, dex: 'humbleswap' };
  const poolB = { poolId: 222, dex: 'humbleswap' };
  const route = {
    poolOptions: [[poolA], [poolB]],
    intermediateTokens: [2],
    hops: 2,
    tokenSequence: [1, 2, 3]
  };

  const result = await findOptimalMultiHopRoute([route], 1, 3, '1000', 0.01, '', undefined, cache);

  assert.ok(result, 'a route was selected');
  // 1000 -> /2 = 500 (hop1) -> /2 = 250 (hop2).
  assert.equal(result.quote.outputAmount, '250', 'output equals a single evaluation pass');

  // The core TASK-22 assertion: no concrete enumeration for single-pool-per-hop.
  assert.equal(genCombosCalls, 0, 'generateRouteCombinations must not be called for a single-pool-per-hop route');
  // Each pool priced exactly once (would be twice if the concrete pass ran).
  assert.equal(humbleQuotes, 2, 'each hop priced exactly once (no duplicate evaluation)');
  // Shared cache: each distinct pool fetched at most once for the whole request.
  assert.equal(humbleFetches, 2, 'each distinct pool fetched once via the shared cache');
});

test('single-pool-per-hop route: concrete fallback runs when the split pass fails transiently', async (t) => {
  // The split (poolOptions) pass makes a bounded number of pool-info fetch
  // attempts and throws if they all fail (a failed fetch is never cached). The
  // old code always ran the concrete pass afterward, which -- via a fresh fetch
  // -- could still recover. This asserts we preserve that recovery: fail every
  // attempt the split pass makes, then succeed, and confirm a quote is still
  // returned via the concrete fallback (generateRouteCombinations invoked once).
  let humbleAttempts = 0;
  let genCombosCalls = 0;
  const FAIL_UNTIL = 3; // number of fetch attempts the split pass makes for a 1-hop single pool
  mockUtils(t);

  t.mock.module('../lib/humbleswap.js', {
    namedExports: {
      getPoolInfo: async () => {
        humbleAttempts += 1;
        if (humbleAttempts <= FAIL_UNTIL) throw new Error('transient pool-info failure');
        return { tokA: 100, tokB: 200, poolBals: { A: 1_000_000n, B: 1_000_000n }, protoInfo: { totFee: 30 } };
      },
      calculateOutputAmount: (amountIn) => { const a = BigInt(amountIn); return a > 0n ? a / 2n : 0n; },
      resolveWrappedTokens: () => ({ inputWrapped: 100, outputWrapped: 200 }),
      validateWrappedPair: () => true
    }
  });
  t.mock.module('../lib/nomadex.js', {
    namedExports: {
      NOMADEX_FEE_SCALE: 10000n,
      getPoolInfo: async () => { throw new Error('nomadex not used'); },
      calculateOutputAmount: () => 0n
    }
  });
  t.mock.module('../lib/config.js', {
    namedExports: {
      getPoolConfigById: () => null,
      generateRouteCombinations: (route) => {
        genCombosCalls += 1;
        return [{ pools: route.poolOptions.map(opts => opts[0]), intermediateTokens: route.intermediateTokens, hops: route.hops }];
      },
      findMatchingPools: () => [],
      findRoutes: () => [],
      getDiscoveryStatus: () => null,
      getUnderlyingForWrapped: () => null,
      // TASK-26: lib/quotes.js now imports this alongside generateRouteCombinations.
      MAX_ROUTE_COMBINATIONS: 10
    }
  });

  const { findOptimalMultiHopRoute, createPoolInfoCache } = await importFreshQuotes();
  const cache = createPoolInfoCache();

  // A 1-hop single-pool route (1 -> 2).
  const poolA = { poolId: 111, dex: 'humbleswap' };
  const route = { poolOptions: [[poolA]], intermediateTokens: [], hops: 1, tokenSequence: [1, 2] };

  const result = await findOptimalMultiHopRoute([route], 1, 2, '1000', 0.01, '', undefined, cache);

  assert.ok(result, 'the concrete fallback recovered a quote after the split pass failed transiently');
  assert.equal(result.quote.outputAmount, '500', '1000 / 2 via the recovered pool');
  assert.equal(genCombosCalls, 1, 'the concrete fallback (generateRouteCombinations) ran exactly once');
  assert.ok(humbleAttempts > FAIL_UNTIL, 'the pool was retried past the failing window');
});

test('multi-pool-per-hop route: concrete combinations ARE still enumerated', async (t) => {
  let genCombosCalls = 0;
  mockUtils(t);

  t.mock.module('../lib/humbleswap.js', {
    namedExports: {
      getPoolInfo: async () => ({ tokA: 100, tokB: 200, poolBals: { A: 1_000_000n, B: 1_000_000n }, protoInfo: { totFee: 30 } }),
      calculateOutputAmount: (amountIn) => { const a = BigInt(amountIn); return a > 0n ? a / 2n : 0n; },
      resolveWrappedTokens: () => ({ inputWrapped: 100, outputWrapped: 200 }),
      validateWrappedPair: () => true
    }
  });
  t.mock.module('../lib/nomadex.js', {
    namedExports: {
      NOMADEX_FEE_SCALE: 10000n,
      getPoolInfo: async () => ({ tokA: 1, tokB: 2, reserveA: 1_000_000n, reserveB: 1_000_000n, fee: 30, feeScale: 10000n }),
      calculateOutputAmount: (amountIn) => { const a = BigInt(amountIn); return a > 0n ? a / 2n : 0n; }
    }
  });
  t.mock.module('../lib/config.js', {
    namedExports: {
      getPoolConfigById: () => null,
      generateRouteCombinations: (route) => {
        genCombosCalls += 1;
        // Return a plausible concrete combination (first pool of each hop).
        return [{ pools: route.poolOptions.map(opts => opts[0]), intermediateTokens: route.intermediateTokens, hops: route.hops }];
      },
      findMatchingPools: () => [],
      findRoutes: () => [],
      getDiscoveryStatus: () => null,
      getUnderlyingForWrapped: () => null,
      // TASK-26: lib/quotes.js now imports this alongside generateRouteCombinations.
      MAX_ROUTE_COMBINATIONS: 10
    }
  });

  const { findOptimalMultiHopRoute, createPoolInfoCache } = await importFreshQuotes();
  const cache = createPoolInfoCache();

  // Hop 1 has TWO pools -> not single-pool-per-hop, so the concrete pass must run.
  const poolA1 = { poolId: 111, dex: 'humbleswap' };
  const poolA2 = { poolId: 112, dex: 'humbleswap' };
  const poolB = { poolId: 222, dex: 'humbleswap' };
  const route = {
    poolOptions: [[poolA1, poolA2], [poolB]],
    intermediateTokens: [2],
    hops: 2,
    tokenSequence: [1, 2, 3]
  };

  const result = await findOptimalMultiHopRoute([route], 1, 3, '1000', 0.01, '', undefined, cache);

  assert.ok(result, 'a route was selected');
  assert.equal(genCombosCalls, 1, 'generateRouteCombinations IS called for a multi-pool-per-hop route');
});

// TASK-26: the fan-out cap is a PER-REQUEST budget shared across every route,
// not per-route. These two tests mock generateRouteCombinations to record the
// (shrinking) maxCombinations budget it is handed per route and to return a
// controllable number of concrete combinations, proving the total concrete
// candidates across all routes can never exceed the cap.
function makeMultiPoolRoute(hop1Ids, hop2Id) {
  return {
    poolOptions: [hop1Ids.map((id) => ({ poolId: id, dex: 'humbleswap' })), [{ poolId: hop2Id, dex: 'humbleswap' }]],
    intermediateTokens: [2],
    hops: 2,
    tokenSequence: [1, 2, 3]
  };
}

function mockHumbleAndNomadexForMultiHop(t) {
  t.mock.module('../lib/humbleswap.js', {
    namedExports: {
      getPoolInfo: async () => ({ tokA: 100, tokB: 200, poolBals: { A: 1_000_000n, B: 1_000_000n }, protoInfo: { totFee: 30 } }),
      calculateOutputAmount: (amountIn) => { const a = BigInt(amountIn); return a > 0n ? a / 2n : 0n; },
      resolveWrappedTokens: () => ({ inputWrapped: 100, outputWrapped: 200 }),
      validateWrappedPair: () => true
    }
  });
  t.mock.module('../lib/nomadex.js', {
    namedExports: {
      NOMADEX_FEE_SCALE: 10000n,
      getPoolInfo: async () => { throw new Error('nomadex not used'); },
      calculateOutputAmount: () => 0n
    }
  });
}

test('per-request budget: a route that consumes the whole cap leaves NO concrete budget for later routes', async (t) => {
  const genCombosArgs = [];
  mockUtils(t);
  mockHumbleAndNomadexForMultiHop(t);
  t.mock.module('../lib/config.js', {
    namedExports: {
      getPoolConfigById: () => null,
      // Returns exactly the budget it is handed (up to 10 available), so the
      // first route swallows the whole MAX_ROUTE_COMBINATIONS budget.
      generateRouteCombinations: (route, maxArg) => {
        genCombosArgs.push(maxArg);
        return Array.from({ length: Math.min(maxArg, 10) }, (_, i) => ({
          pools: [route.poolOptions[0][i % route.poolOptions[0].length], route.poolOptions[1][0]],
          intermediateTokens: route.intermediateTokens,
          hops: route.hops
        }));
      },
      findMatchingPools: () => [],
      findRoutes: () => [],
      getDiscoveryStatus: () => null,
      getUnderlyingForWrapped: () => null,
      MAX_ROUTE_COMBINATIONS: 10
    }
  });

  const { findOptimalMultiHopRoute, createPoolInfoCache } = await importFreshQuotes();
  const cache = createPoolInfoCache();

  const routeA = makeMultiPoolRoute([111, 112], 222);
  const routeB = makeMultiPoolRoute([333, 334], 444);
  const result = await findOptimalMultiHopRoute([routeA, routeB], 1, 3, '1000', 0.01, '', 10, cache);

  assert.ok(result, 'a route was selected');
  // Route A got the full budget (10) and consumed it; route B's concrete pass
  // is skipped entirely (budget exhausted), so generateRouteCombinations runs
  // exactly once. Without the shared budget it would run for BOTH routes.
  assert.deepEqual(genCombosArgs, [10], 'only the first route enumerates concrete combinations; the cap bounds the per-request total');
});

test('per-request budget: the remaining budget shrinks as it is handed to each successive route', async (t) => {
  const genCombosArgs = [];
  mockUtils(t);
  mockHumbleAndNomadexForMultiHop(t);
  t.mock.module('../lib/config.js', {
    namedExports: {
      getPoolConfigById: () => null,
      // Each route returns only 3 concrete combinations, so the budget is NOT
      // exhausted by the first route and the second route runs with a REDUCED
      // budget — pinning that the remaining budget (not the full cap) is threaded.
      generateRouteCombinations: (route, maxArg) => {
        genCombosArgs.push(maxArg);
        return Array.from({ length: Math.min(maxArg, 3) }, (_, i) => ({
          pools: [route.poolOptions[0][i % route.poolOptions[0].length], route.poolOptions[1][0]],
          intermediateTokens: route.intermediateTokens,
          hops: route.hops
        }));
      },
      findMatchingPools: () => [],
      findRoutes: () => [],
      getDiscoveryStatus: () => null,
      getUnderlyingForWrapped: () => null,
      MAX_ROUTE_COMBINATIONS: 10
    }
  });

  const { findOptimalMultiHopRoute, createPoolInfoCache } = await importFreshQuotes();
  const cache = createPoolInfoCache();

  const routeA = makeMultiPoolRoute([111, 112], 222);
  const routeB = makeMultiPoolRoute([333, 334], 444);
  const result = await findOptimalMultiHopRoute([routeA, routeB], 1, 3, '1000', 0.01, '', 10, cache);

  assert.ok(result, 'a route was selected');
  // Route A: budget 10 -> returns 3 -> budget 7. Route B: budget 7 -> returns 3.
  assert.deepEqual(genCombosArgs, [10, 7], 'the shared budget decreases by the concrete count consumed by each prior route');
});

test('per-request budget: the failure-only single-pool fallback is skipped once the budget is exhausted (does not bypass the cap)', async (t) => {
  let genCombosCalls = 0;
  mockUtils(t);

  // humbleswap: routeB's single pools (555/666) always throw, forcing routeB's
  // split (poolOptions) candidate to fail and reach the concrete FALLBACK path;
  // routeA's pools (111/112/222) succeed.
  t.mock.module('../lib/humbleswap.js', {
    namedExports: {
      getPoolInfo: async (poolId) => {
        if (Number(poolId) === 555 || Number(poolId) === 666) throw new Error('transient failure (routeB)');
        return { tokA: 100, tokB: 200, poolBals: { A: 1_000_000n, B: 1_000_000n }, protoInfo: { totFee: 30 } };
      },
      calculateOutputAmount: (amountIn) => { const a = BigInt(amountIn); return a > 0n ? a / 2n : 0n; },
      resolveWrappedTokens: () => ({ inputWrapped: 100, outputWrapped: 200 }),
      validateWrappedPair: () => true
    }
  });
  t.mock.module('../lib/nomadex.js', {
    namedExports: {
      NOMADEX_FEE_SCALE: 10000n,
      getPoolInfo: async () => { throw new Error('nomadex not used'); },
      calculateOutputAmount: () => 0n
    }
  });
  t.mock.module('../lib/config.js', {
    namedExports: {
      getPoolConfigById: () => null,
      generateRouteCombinations: (route, maxArg) => {
        genCombosCalls += 1;
        return Array.from({ length: Math.min(maxArg, 10) }, (_, i) => ({
          pools: [route.poolOptions[0][i % route.poolOptions[0].length], route.poolOptions[1][0]],
          intermediateTokens: route.intermediateTokens,
          hops: route.hops
        }));
      },
      findMatchingPools: () => [],
      findRoutes: () => [],
      getDiscoveryStatus: () => null,
      getUnderlyingForWrapped: () => null,
      MAX_ROUTE_COMBINATIONS: 10
    }
  });

  const { findOptimalMultiHopRoute, createPoolInfoCache } = await importFreshQuotes();
  const cache = createPoolInfoCache();

  // routeA is multi-pool-per-hop: its up-front concrete enumeration returns 10
  // combinations and exhausts the whole budget. routeB is single-pool-per-hop
  // (deferred), and its split pass fails transiently, so WITHOUT the budget
  // guard the fallback would call generateRouteCombinations a SECOND time and
  // add concrete retries beyond the cap.
  const routeA = makeMultiPoolRoute([111, 112], 222);
  const routeB = {
    poolOptions: [[{ poolId: 555, dex: 'humbleswap' }], [{ poolId: 666, dex: 'humbleswap' }]],
    intermediateTokens: [2],
    hops: 2,
    tokenSequence: [1, 2, 3]
  };
  const result = await findOptimalMultiHopRoute([routeA, routeB], 1, 3, '1000', 0.01, '', 10, cache);

  assert.ok(result, 'routeA still produced a valid quote');
  // generateRouteCombinations runs exactly ONCE (routeA). The budget-exhausted
  // routeB fallback is skipped rather than adding uncapped concrete retries.
  assert.equal(genCombosCalls, 1, 'the fallback respects the exhausted shared budget and does not re-enumerate');
});
