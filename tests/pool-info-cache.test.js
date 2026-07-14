// TASK-21: request-scoped pool-info cache shared across the quote pipeline.
// Run with: node --experimental-test-module-mocks --test tests/pool-info-cache.test.js
//
// These tests assert the cache CONTRACT that the quote pipeline relies on and
// that TASK-22/TASK-23 will reuse:
//   - within one request each distinct pool's on-chain info is fetched at most
//     once; every later lookup hits the cache (no redundant Info()/simulate),
//   - the cache key uniquely identifies a pool by (dex, poolId) so two distinct
//     pools sharing a numeric poolId across DEXes NEVER collide onto one entry,
//   - a FAILED fetch is not cached, so a transient error can be retried.
//
// Like route-degraded.test.js, the real getPoolInfo implementations talk to
// algod/indexer several layers deep, so we mock lib/nomadex.js / lib/humbleswap.js
// wholesale and import lib/quotes.js with a cache-busting query string so each
// test links a fresh module graph against its own mocks.
import test from 'node:test';
import assert from 'node:assert/strict';

let importSeq = 0;
async function importFreshQuotes() {
  importSeq += 1;
  return import(`../lib/quotes.js?poolInfoCacheTest=${importSeq}`);
}

// Minimal utils/config mocks shared by every test (only the symbols the code
// path under test actually touches).
function mockCommon(t) {
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
  t.mock.module('../lib/config.js', {
    namedExports: {
      getPoolConfigById: () => null,
      generateRouteCombinations: () => [],
      findMatchingPools: () => [],
      findRoutes: () => [],
      getDiscoveryStatus: () => null,
      getUnderlyingForWrapped: () => null,
      // TASK-26: lib/quotes.js now imports this alongside generateRouteCombinations.
      MAX_ROUTE_COMBINATIONS: 10
    }
  });
}

test('shared cache: a pool is fetched from chain only once across many calculateQuoteForPool calls', async (t) => {
  let nomadexFetches = 0;
  mockCommon(t);
  t.mock.module('../lib/nomadex.js', {
    namedExports: {
      NOMADEX_FEE_SCALE: 10000n,
      getPoolInfo: async () => {
        nomadexFetches += 1;
        return { tokA: 1, tokB: 2, reserveA: 1_000_000n, reserveB: 1_000_000n, fee: 30, feeScale: 10000n };
      },
      calculateOutputAmount: (amountIn) => { const a = BigInt(amountIn); return a > 0n ? a / 2n : 0n; }
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

  const { createPoolInfoCache, calculateQuoteForPool } = await importFreshQuotes();
  const poolCfg = { poolId: 5001, dex: 'nomadex', tokens: { tokA: { id: 1 }, tokB: { id: 2 } } };

  const cache = createPoolInfoCache();
  // Three separate quote calls for the SAME pool, none passing a pre-fetched
  // cachedPoolInfo, all sharing the one cache -> exactly one chain fetch.
  const q1 = await calculateQuoteForPool(poolCfg, 1, 2, 1000n, 0.01, '', null, cache);
  const q2 = await calculateQuoteForPool(poolCfg, 1, 2, 500n, 0.01, '', null, cache);
  const q3 = await calculateQuoteForPool(poolCfg, 1, 2, 250n, 0.01, '', null, cache);

  assert.equal(nomadexFetches, 1, 'pool info must be fetched from chain exactly once');
  // Amount math is unchanged (out = in/2 per the mocked curve).
  assert.equal(q1.outputAmount, '500');
  assert.equal(q2.outputAmount, '250');
  assert.equal(q3.outputAmount, '125');

  // peek returns the same cached object; get is a cache hit (still one fetch).
  assert.ok(cache.peek(poolCfg) !== null);
  await cache.get(poolCfg);
  assert.equal(nomadexFetches, 1);
});

test('cache key includes DEX: same poolId on different DEXes does NOT collide', async (t) => {
  let nomadexFetches = 0;
  let humbleFetches = 0;
  mockCommon(t);
  t.mock.module('../lib/nomadex.js', {
    namedExports: {
      NOMADEX_FEE_SCALE: 10000n,
      getPoolInfo: async () => { nomadexFetches += 1; return { tokA: 1, tokB: 2, reserveA: 10n, reserveB: 10n, fee: 30, feeScale: 10000n }; },
      calculateOutputAmount: () => 1n
    }
  });
  t.mock.module('../lib/humbleswap.js', {
    namedExports: {
      getPoolInfo: async () => { humbleFetches += 1; return { tokA: 1, tokB: 2, poolBals: { A: 10n, B: 10n }, protoInfo: { totFee: 30 } }; },
      calculateOutputAmount: () => 1n,
      resolveWrappedTokens: () => ({ inputWrapped: 1, outputWrapped: 2 }),
      validateWrappedPair: () => true
    }
  });

  const { createPoolInfoCache } = await importFreshQuotes();
  const cache = createPoolInfoCache();

  const nomadexPool = { poolId: 7000, dex: 'nomadex' };
  const humblePool = { poolId: 7000, dex: 'humbleswap' }; // same numeric id, different DEX

  const nInfo = await cache.get(nomadexPool);
  const hInfo = await cache.get(humblePool);

  assert.equal(nomadexFetches, 1, 'nomadex pool fetched');
  assert.equal(humbleFetches, 1, 'humbleswap pool fetched separately (no collision)');
  assert.notEqual(nInfo, hInfo, 'distinct pools resolve to distinct info objects');
  // Each is independently a cache hit on re-get.
  await cache.get(nomadexPool);
  await cache.get(humblePool);
  assert.equal(nomadexFetches, 1);
  assert.equal(humbleFetches, 1);
});

test('a failed fetch is not cached: the next get retries', async (t) => {
  let attempts = 0;
  mockCommon(t);
  t.mock.module('../lib/nomadex.js', {
    namedExports: {
      NOMADEX_FEE_SCALE: 10000n,
      getPoolInfo: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient failure');
        return { tokA: 1, tokB: 2, reserveA: 10n, reserveB: 10n, fee: 30, feeScale: 10000n };
      },
      calculateOutputAmount: () => 1n
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

  const { createPoolInfoCache } = await importFreshQuotes();
  const cache = createPoolInfoCache();
  const poolCfg = { poolId: 8000, dex: 'nomadex' };

  await assert.rejects(() => cache.get(poolCfg), /transient failure/);
  assert.equal(cache.peek(poolCfg), null, 'a failed fetch must not be cached');

  const info = await cache.get(poolCfg); // retry succeeds
  assert.ok(info && info.reserveA === 10n);
  assert.equal(attempts, 2, 'the failed pool must have been retried');
});

test('concurrent get() for the same pool dedupes to a single in-flight fetch', async (t) => {
  let fetches = 0;
  mockCommon(t);
  t.mock.module('../lib/nomadex.js', {
    namedExports: {
      NOMADEX_FEE_SCALE: 10000n,
      getPoolInfo: async () => {
        fetches += 1;
        // Resolve on a later tick so all concurrent callers observe the same
        // in-flight promise before it settles.
        await new Promise((r) => setTimeout(r, 10));
        return { tokA: 1, tokB: 2, reserveA: 10n, reserveB: 10n, fee: 30, feeScale: 10000n };
      },
      calculateOutputAmount: () => 1n
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

  const { createPoolInfoCache } = await importFreshQuotes();
  const cache = createPoolInfoCache();
  const poolCfg = { poolId: 9500, dex: 'nomadex' };

  const [a, b, c] = await Promise.all([cache.get(poolCfg), cache.get(poolCfg), cache.get(poolCfg)]);
  assert.equal(fetches, 1, 'three concurrent gets must share one in-flight fetch');
  assert.equal(a, b);
  assert.equal(b, c);
});

test('regression: a split over two pools that share a numeric poolId across DEXes quotes each via its OWN dex (no collision)', async (t) => {
  let nomadexFetches = 0;
  let humbleFetches = 0;
  mockCommon(t);
  t.mock.module('../lib/nomadex.js', {
    namedExports: {
      NOMADEX_FEE_SCALE: 10000n,
      getPoolInfo: async () => { nomadexFetches += 1; return { tokA: 1, tokB: 2, reserveA: 1_000_000n, reserveB: 1_000_000n, fee: 30, feeScale: 10000n }; },
      calculateOutputAmount: (amountIn) => { const a = BigInt(amountIn); return a > 0n ? a / 2n : 0n; }
    }
  });
  t.mock.module('../lib/humbleswap.js', {
    namedExports: {
      getPoolInfo: async () => { humbleFetches += 1; return { tokA: 1, tokB: 2, poolBals: { A: 1_000_000n, B: 1_000_000n }, protoInfo: { totFee: 30 } }; },
      calculateOutputAmount: (amountIn) => { const a = BigInt(amountIn); return a > 0n ? a / 3n : 0n; },
      resolveWrappedTokens: () => ({ inputWrapped: 1, outputWrapped: 2 }),
      validateWrappedPair: () => true
    }
  });

  const { createPoolInfoCache, calculateOptimalSplit } = await importFreshQuotes();
  const cache = createPoolInfoCache();

  // Same numeric poolId (9000) on two different DEXes.
  const nomadexPool = { poolId: 9000, dex: 'nomadex', tokens: { tokA: { id: 1 }, tokB: { id: 2 } } };
  const humblePool = { poolId: 9000, dex: 'humbleswap' };

  const result = await calculateOptimalSplit([nomadexPool, humblePool], 1, 2, 1000n, 0.01, '', cache);

  // Each DEX's pool was fetched exactly once through the shared cache -- proof
  // both legs used their OWN config/dex rather than collapsing onto one.
  assert.equal(nomadexFetches, 1, 'nomadex pool fetched once');
  assert.equal(humbleFetches, 1, 'humbleswap pool fetched once (not collided with nomadex)');

  // Every returned leg references a real config with a valid dex, never a
  // wrong-dex substitute.
  assert.ok(result.splitDetails.length >= 1);
  for (const leg of result.splitDetails) {
    assert.ok(leg.poolCfg.dex === 'nomadex' || leg.poolCfg.dex === 'humbleswap');
  }
  assert.deepEqual(result.skippedPools, []);
});
