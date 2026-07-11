import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { discoverAllPools, getTokenMetadata, hydrateTokenMetadataCache } from './discovery.js';
import { algodClient, indexerClient } from './clients.js';

// Debug flag for verbose logging
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config loading (auto-discovered pools/tokens) ---

let poolsConfig = null;
let tokensConfig = null;
let discoveryPromise = null;
let lastDiscoveryAt = null;
const wrappedToUnderlyingCache = new Map();
const underlyingToWrappedCache = new Map();
let wrappedCacheBuilt = false;

// --- Discovery lifecycle: success threshold, failed-pool retry, disk cache (TASK-19) ---
//
// discoverAllPools() no longer throws on a per-pool failure - it returns a
// partial result plus a `failedPools` list. What happens with that partial
// result is decided entirely here:
//   - below MIN_SUCCESS_RATIO: initializeConfig() rejects. Nothing is cached.
//     The Docker boot path (index.js) exits; the Vercel/per-request path
//     surfaces a 500 on every route until a later attempt clears the bar.
//     A partial-but-broken pool set is never silently served as complete.
//   - at/above the threshold: the successfully-discovered pools are served
//     immediately and the failed pool IDs are tracked in `failedPoolIds` for
//     a background retry, checked lazily on each request (see
//     maybeRetryFailedPools) rather than a timer - timers don't reliably fire
//     between invocations on serverless, so a request is the only guaranteed
//     wake-up point.
const MIN_SUCCESS_RATIO = (() => {
  const fromEnv = Number(process.env.DISCOVERY_MIN_SUCCESS_RATIO);
  return Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv <= 1 ? fromEnv : 0.7;
})();
const FAILED_POOL_RETRY_TTL_MS = (() => {
  const fromEnv = Number(process.env.DISCOVERY_RETRY_TTL_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 2 * 60 * 1000; // 2 minutes
})();

// poolId -> { lastAttempt: number (ms epoch), attempts: number, error: string }
const failedPoolIds = new Map();
let retryInProgress = false;

// A below-threshold init failure is rate-limited using the same TTL: without
// this, EVERY request during an upstream outage would kick off its own full
// (all-poolIds) discovery sweep instead of just failing fast with the last
// known error, hammering Mimir/algod repeatedly instead of backing off.
let lastFailedInitAt = null;
let lastInitError = null;

// Instance-local disk cache: speeds up a warm restart (e.g. `docker compose
// restart` without a rebuild, or a local dev reload) by skipping discovery
// entirely when a COMPLETE prior snapshot is on disk. This is deliberately
// NOT a shared/cross-instance store (no new infra dependency) - each
// container or lambda instance has its own tmpdir, so it never masks a
// genuinely different pool-ids.json across instances (see poolIdsKey below).
// Only pool *topology* (which tokens a pool pairs, dex, decimals/symbol) is
// cached here; reserves/fees are always re-read live per quote, so a stale
// cache can't produce a wrong price.
const DISCOVERY_CACHE_PATH = path.join(os.tmpdir(), 'swap-api-discovery-cache.json');
// Even though cached topology is normally immutable on-chain (a pool's token
// pair/dex/decimals don't change after creation), cap how long a snapshot can
// be trusted without a live re-check - e.g. so a bug fix to discoverPool()
// itself can't be masked indefinitely by an old container's cache surviving
// restart after restart. Deliberately generous (this is a boot-speed
// optimization, not a source of truth) and reuses the same env-override
// pattern as the other discovery knobs.
const DISCOVERY_CACHE_MAX_AGE_MS = (() => {
  const fromEnv = Number(process.env.DISCOVERY_CACHE_MAX_AGE_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 24 * 60 * 60 * 1000; // 24 hours
})();

function computePoolIdsKey(poolIds) {
  return poolIds.slice().sort((a, b) => a - b).join(',');
}

/**
 * Read the on-disk cache, but only trust it if it matches the CURRENT
 * pool-ids.json exactly, captured a fully successful discovery, and is
 * within DISCOVERY_CACHE_MAX_AGE_MS. A partial snapshot must never be
 * replayed as if it were complete (CONVE-35) - if the last run before a
 * restart had failures, or the snapshot is simply too old to trust blindly,
 * we deliberately re-discover everything from scratch instead.
 */
function readDiscoveryCache(poolIdsKey) {
  try {
    const raw = fs.readFileSync(DISCOVERY_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.poolIdsKey !== poolIdsKey) return null;
    if (!Array.isArray(parsed.pools) || !parsed.tokens) return null;
    if (!Array.isArray(parsed.failedPoolIds) || parsed.failedPoolIds.length > 0) return null;
    const generatedAtMs = Date.parse(parsed.generatedAt);
    if (!Number.isFinite(generatedAtMs) || Date.now() - generatedAtMs > DISCOVERY_CACHE_MAX_AGE_MS) {
      return null;
    }
    return parsed;
  } catch (e) {
    return null;
  }
}

/**
 * Best-effort write of a fully-successful discovery snapshot. Never throws -
 * a read-only filesystem (or any other write failure) must not fail
 * discovery itself, it just means the next cold start won't get the fast
 * path.
 */
function writeDiscoveryCache(poolIdsKey, pools, tokens) {
  try {
    const payload = {
      poolIdsKey,
      generatedAt: new Date().toISOString(),
      pools,
      tokens,
      failedPoolIds: []
    };
    fs.writeFileSync(DISCOVERY_CACHE_PATH, JSON.stringify(payload), 'utf8');
  } catch (e) {
    if (DEBUG) console.warn('[Config] Could not write discovery cache:', e.message);
  }
}

/**
 * Publish a discovery result as the live config (atomic: readers only ever
 * see the fully-old or fully-new object, never a torn in-between state) and
 * update failed-pool bookkeeping. Throws (without publishing poolsConfig/
 * tokensConfig) if the success ratio is below MIN_SUCCESS_RATIO - but
 * failedPoolIds is still updated either way, so a below-threshold outage
 * remains visible via getDiscoveryStatus()/GET /health instead of looking
 * like "no failures recorded" just because nothing was ever published.
 */
function applyDiscoveryResult(poolIds, poolIdsKey, discovered, { enforceThreshold }) {
  const successRatio = poolIds.length === 0 ? 1 : discovered.pools.length / poolIds.length;

  // This is always a full-coverage discovery run (over ALL of poolIds, not a
  // subset), so it's authoritative for the whole failedPoolIds set: pools
  // that succeeded this round are no longer failing, pools that failed are
  // recorded/updated. Done before the threshold check so a below-threshold
  // rejection still leaves diagnostics behind.
  for (const pool of discovered.pools) {
    failedPoolIds.delete(Number(pool.poolId));
  }
  for (const { poolId, error } of discovered.failedPools) {
    const prev = failedPoolIds.get(poolId);
    failedPoolIds.set(poolId, { lastAttempt: Date.now(), attempts: (prev?.attempts || 0) + 1, error });
  }

  if (enforceThreshold && successRatio < MIN_SUCCESS_RATIO) {
    const failedIds = discovered.failedPools.map(f => f.poolId).join(', ');
    throw new Error(
      `Discovery success ratio ${(successRatio * 100).toFixed(1)}% is below the required ` +
      `${(MIN_SUCCESS_RATIO * 100).toFixed(0)}% threshold (${discovered.pools.length}/${poolIds.length} pools). ` +
      `Failed pool IDs: ${failedIds}`
    );
  }

  poolsConfig = { pools: discovered.pools };
  tokensConfig = { tokens: discovered.tokens };
  wrappedToUnderlyingCache.clear();
  underlyingToWrappedCache.clear();
  wrappedCacheBuilt = false;
  lastDiscoveryAt = new Date();

  if (discovered.failedPools.length > 0) {
    // Visible alert, not a silent partial cache: below-threshold failures never
    // get here (they throw above); at/above threshold we still log loudly so a
    // missing pool is diagnosable instead of just quietly serving worse quotes.
    console.error(
      `[Config] ${discovered.failedPools.length}/${poolIds.length} pool(s) failed discovery and will be ` +
      `retried every ${Math.round(FAILED_POOL_RETRY_TTL_MS / 1000)}s: ${discovered.failedPools.map(f => f.poolId).join(', ')}`
    );
  } else {
    console.log(`[Config] Successfully discovered all ${discovered.pools.length} pools and ${Object.keys(discovered.tokens).length} tokens`);
  }

  // Only a fully-successful snapshot is worth persisting - see readDiscoveryCache.
  if (discovered.failedPools.length === 0) {
    writeDiscoveryCache(poolIdsKey, discovered.pools, discovered.tokens);
  }
}

/**
 * Lazily retry pools that previously failed discovery, at most once per
 * FAILED_POOL_RETRY_TTL_MS, triggered by request traffic rather than a timer
 * (see the comment above MIN_SUCCESS_RATIO for why). Fire-and-forget: never
 * awaited by the request path, so a slow retry can't add latency to an
 * unrelated /quote call. Newly-recovered pools are merged into the live
 * config via a single atomic reassignment so concurrent readers never see a
 * torn pools array.
 */
function maybeRetryFailedPools() {
  if (retryInProgress || failedPoolIds.size === 0 || !poolsConfig || !tokensConfig) {
    return;
  }

  const now = Date.now();
  const due = [];
  for (const [poolId, info] of failedPoolIds.entries()) {
    if (now - info.lastAttempt >= FAILED_POOL_RETRY_TTL_MS) {
      due.push(poolId);
    }
  }
  if (due.length === 0) {
    return;
  }

  retryInProgress = true;
  (async () => {
    try {
      console.log(`[Config] Retrying ${due.length} previously-failed pool(s): ${due.join(', ')}`);
      const retryResult = await discoverAllPools(due, algodClient, indexerClient);

      if (retryResult.pools.length > 0) {
        const existingIds = new Set(poolsConfig.pools.map(p => Number(p.poolId)));
        const recovered = retryResult.pools.filter(p => !existingIds.has(Number(p.poolId)));

        if (recovered.length > 0) {
          // Build the next snapshot off to the side, then publish it in one
          // assignment - findMatchingPools/buildPoolGraph/etc. only ever see
          // the fully-old or fully-new pools array, never a half-updated one.
          const mergedPools = [...poolsConfig.pools, ...recovered];
          const mergedTokens = { ...tokensConfig.tokens, ...retryResult.tokens };

          poolsConfig = { pools: mergedPools };
          tokensConfig = { tokens: mergedTokens };
          wrappedToUnderlyingCache.clear();
          underlyingToWrappedCache.clear();
          wrappedCacheBuilt = false;

          for (const pool of recovered) {
            failedPoolIds.delete(Number(pool.poolId));
          }
          console.log(`[Config] Recovered ${recovered.length}/${due.length} previously-failed pool(s)`);
        }
      }

      for (const { poolId, error } of retryResult.failedPools) {
        const prev = failedPoolIds.get(poolId);
        failedPoolIds.set(poolId, {
          lastAttempt: Date.now(),
          attempts: (prev?.attempts || 0) + 1,
          error
        });
      }

      if (failedPoolIds.size === 0) {
        const poolIds = loadPoolIds();
        writeDiscoveryCache(computePoolIdsKey(poolIds), poolsConfig.pools, tokensConfig.tokens);
        console.log('[Config] All configured pools now discovered; refreshed on-disk cache');
      }
    } catch (error) {
      // A thrown retry (e.g. loadPoolIds() failing) just means we try again
      // next TTL window - failedPoolIds keeps its previous (still-failed) state.
      console.error('[Config] Background retry of failed pools threw:', error);
    } finally {
      retryInProgress = false;
    }
  })();
}

/**
 * Discovery-status snapshot for observability (wired into GET /health and
 * GET /config/pools) so a partial pool set is visible to operators instead of
 * silently degrading quote quality.
 */
function getDiscoveryStatus() {
  return {
    initialized: Boolean(poolsConfig && tokensConfig),
    totalPools: poolsConfig ? poolsConfig.pools.length : 0,
    lastDiscoveryAt: lastDiscoveryAt ? lastDiscoveryAt.toISOString() : null,
    failedPools: Array.from(failedPoolIds.entries()).map(([poolId, info]) => ({
      poolId,
      attempts: info.attempts,
      lastAttempt: new Date(info.lastAttempt).toISOString(),
      error: info.error
    }))
  };
}

function loadJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * Load pool IDs from config file
 * @returns {Array<number>} Array of pool IDs
 */
function loadPoolIds() {
  const poolIdsPath = path.join(__dirname, '..', 'config', 'pool-ids.json');
  const poolIds = loadJSON(poolIdsPath);
  
  if (!poolIds || !Array.isArray(poolIds)) {
    throw new Error('Invalid or missing config/pool-ids.json');
  }

  // Dedupe pool IDs (order-preserving) so a duplicate entry can't cause a pool
  // to be discovered/processed twice, which would double-count it in routing/splits.
  // Normalize to Number so mixed 429995 / "429995" entries collapse to one.
  const seen = new Set();
  const deduped = [];
  for (const rawId of poolIds) {
    const id = Number(rawId);
    if (!Number.isFinite(id)) {
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    deduped.push(id);
  }

  return deduped;
}

/**
 * Initialize and discover all pools and tokens.
 * This function is async and MUST be called at startup before using any config functions.
 * It is cheap to call again after the first successful load (an in-memory
 * state check plus, at most, a TTL comparison per failed pool) - callers
 * should call it on every request rather than gating behind their own
 * "already initialized" flag, since that's what drives the failed-pool retry
 * sweep (see maybeRetryFailedPools).
 * @returns {Promise<void>}
 */
async function initializeConfig() {
  // If already loaded, return immediately - but still give previously-failed
  // pools a chance to be retried in the background.
  if (poolsConfig && tokensConfig) {
    maybeRetryFailedPools();
    return;
  }

  // If discovery is in progress, wait for it
  if (discoveryPromise) {
    await discoveryPromise;
    return;
  }

  // Rate-limit repeated full-discovery sweeps after a below-threshold
  // failure (see the comment above lastFailedInitAt): fail fast with the
  // last known error instead of re-running discovery for every request
  // during an outage.
  if (lastFailedInitAt !== null && Date.now() - lastFailedInitAt < FAILED_POOL_RETRY_TTL_MS) {
    throw lastInitError || new Error('Pool discovery previously failed and is cooling down before retrying.');
  }

  // Start discovery
  discoveryPromise = (async () => {
    try {
      const poolIds = loadPoolIds();
      const poolIdsKey = computePoolIdsKey(poolIds);
      console.log(`[Config] Loading ${poolIds.length} pools from discovery...`);

      const cached = readDiscoveryCache(poolIdsKey);
      if (cached) {
        console.log(`[Config] Hydrating from on-disk discovery cache (generated ${cached.generatedAt})`);
        hydrateTokenMetadataCache(cached.tokens);
        poolsConfig = { pools: cached.pools };
        tokensConfig = { tokens: cached.tokens };
        wrappedToUnderlyingCache.clear();
        underlyingToWrappedCache.clear();
        wrappedCacheBuilt = false;
        lastDiscoveryAt = new Date(cached.generatedAt);
        failedPoolIds.clear();
        console.log(`[Config] Loaded ${cached.pools.length} pools and ${Object.keys(cached.tokens).length} tokens from cache`);
      } else {
        const discovered = await discoverAllPools(poolIds, algodClient, indexerClient);
        applyDiscoveryResult(poolIds, poolIdsKey, discovered, { enforceThreshold: true });
      }
      lastFailedInitAt = null;
      lastInitError = null;
    } catch (error) {
      console.error('[Config] Failed to discover pools:', error);
      lastFailedInitAt = Date.now();
      lastInitError = error;
      throw error;
    } finally {
      discoveryPromise = null;
    }
  })();

  await discoveryPromise;
}

/**
 * Synchronous check to ensure config is loaded
 * This should only be called after initializeConfig() has completed
 */
function loadConfigsOnce() {
  if (!poolsConfig || !tokensConfig) {
    throw new Error('Config not initialized. Call initializeConfig() at startup first.');
  }
}

function getPoolConfigById(poolId) {
  loadConfigsOnce();
  const pid = Number(poolId);
  const found = poolsConfig.pools.find(p => Number(p.poolId) === pid);
  return found || null;
}

function getTokenMetaFromConfig(tokenId) {
  // Try to get from discovered tokens cache first
  const discovered = getTokenMetadata(tokenId);
  if (discovered) {
    return discovered;
  }
  
  // Fallback to tokensConfig if available (for backward compatibility during migration)
  if (tokensConfig && tokensConfig.tokens) {
    const t = tokensConfig.tokens[String(tokenId)];
    if (t) {
      return t;
    }
  }
  
  return null;
}

function buildWrappedCache() {
  if (wrappedCacheBuilt) {
    return;
  }

  loadConfigsOnce();
  wrappedToUnderlyingCache.clear();
  underlyingToWrappedCache.clear();

  for (const pool of poolsConfig.pools) {
    const poolDex = (pool.dex || 'humbleswap').toLowerCase();
    if (poolDex !== 'humbleswap') {
      continue;
    }

    const poolIdNum = Number(pool.poolId);
    const u2w = pool.tokens?.underlyingToWrapped || {};
    const unwrapListRaw = Array.isArray(pool.tokens?.unwrap) ? pool.tokens.unwrap : [];
    const unwrapSet = new Set(
      unwrapListRaw
        .map(value => Number(value))
        .filter(value => Number.isFinite(value))
    );

    for (const [underlying, wrapped] of Object.entries(u2w)) {
      const underlyingNum = Number(underlying);
      const wrappedNum = Number(wrapped);

      if (!Number.isFinite(underlyingNum) || !Number.isFinite(wrappedNum)) {
        continue;
      }

      underlyingToWrappedCache.set(underlyingNum, wrappedNum);

      let entry = wrappedToUnderlyingCache.get(wrappedNum);
      if (!entry) {
        entry = {
          wrappedId: wrappedNum,
          underlyingId: underlyingNum,
          pools: new Set(),
          unwrapSupported: unwrapSet.has(wrappedNum),
          underlyingType: null
        };
        wrappedToUnderlyingCache.set(wrappedNum, entry);
      }

      entry.underlyingId = underlyingNum;
      entry.pools.add(poolIdNum);
      entry.unwrapSupported = entry.unwrapSupported || unwrapSet.has(wrappedNum);
      if (entry.underlyingType === null) {
        if (underlyingNum === 0) {
          entry.underlyingType = 'native';
        } else if (underlyingNum > 0) {
          entry.underlyingType = 'ASA';
        } else {
          entry.underlyingType = 'unknown';
        }
      }
    }

    for (const wrappedToken of unwrapSet) {
      if (!wrappedToUnderlyingCache.has(wrappedToken)) {
        wrappedToUnderlyingCache.set(wrappedToken, {
          wrappedId: wrappedToken,
          underlyingId: null,
          pools: new Set([poolIdNum]),
          unwrapSupported: true,
          underlyingType: null
        });
      } else {
        const entry = wrappedToUnderlyingCache.get(wrappedToken);
        entry.unwrapSupported = true;
        entry.pools.add(poolIdNum);
      }
    }
  }

  wrappedCacheBuilt = true;
}

function getUnderlyingForWrapped(wrappedTokenId) {
  const wrappedNum = Number(wrappedTokenId);
  if (!Number.isFinite(wrappedNum)) {
    return null;
  }

  buildWrappedCache();
  const cacheEntry = wrappedToUnderlyingCache.get(wrappedNum);

  if (!cacheEntry) {
    return null;
  }

  const metadata = cacheEntry.underlyingId !== null && cacheEntry.underlyingId !== undefined
    ? getTokenMetaFromConfig(cacheEntry.underlyingId)
    : null;

  return {
    wrappedId: cacheEntry.wrappedId,
    underlyingId: cacheEntry.underlyingId,
    underlyingType: cacheEntry.underlyingType,
    unwrapSupported: cacheEntry.unwrapSupported,
    pools: Array.from(cacheEntry.pools),
    metadata
  };
}

function getWrappedId(tokenId) {
  const id = Number(tokenId);
  if (!Number.isFinite(id)) return id;

  buildWrappedCache();
  
  // If mapped to a wrapped token, return that
  if (underlyingToWrappedCache.has(id)) {
    return underlyingToWrappedCache.get(id);
  }
  
  // If it IS a wrapped token (exists in wrappedToUnderlyingCache), return itself
  if (wrappedToUnderlyingCache.has(id)) {
    return id;
  }
  
  // Otherwise return as is
  return id;
}

/**
 * Build a graph of all pools where each token maps to pools it's connected to
 * @param {Array<string>|undefined} dexFilter - Optional array of DEX names to filter by
 * @returns {Map<number, Set<Object>>} Map from token ID to set of {poolId, otherToken, dex, poolCfg}
 */
function buildPoolGraph(dexFilter) {
  loadConfigsOnce();
  
  const graph = new Map();
  
  // Default to all DEXes if no filter provided
  const allowedDexes = dexFilter && Array.isArray(dexFilter) && dexFilter.length > 0
    ? dexFilter.map(d => String(d).toLowerCase())
    : ['humbleswap', 'nomadex'];
  
  for (const pool of poolsConfig.pools) {
    const poolDex = (pool.dex || 'humbleswap').toLowerCase();
    
    // Filter by DEX if specified
    if (!allowedDexes.includes(poolDex)) {
      continue;
    }
    
    let tokenA, tokenB;
    
    if (poolDex === 'humbleswap') {
      // For HumbleSwap, we need to map underlying tokens to wrapped tokens
      // The graph should use underlying tokens for routing
      const u2w = pool.tokens?.underlyingToWrapped || {};
      const wrappedPair = pool.tokens?.wrappedPair || {};
      const wrappedTokA = Number(wrappedPair.tokA);
      const wrappedTokB = Number(wrappedPair.tokB);
      
      // Find underlying tokens for wrapped tokens (reverse lookup)
      // If a wrapped token is not in the unwrap list, it's already an underlying token
      const unwrapList = pool.tokens?.unwrap || [];
      
      // Build reverse mapping: wrapped -> underlying
      const w2u = new Map();
      for (const [underlying, wrapped] of Object.entries(u2w)) {
        w2u.set(Number(wrapped), Number(underlying));
      }
      
      // Determine underlying tokens
      // If wrapped token is in unwrap list, it means it can be unwrapped to underlying
      // Otherwise, the wrapped token itself is the underlying (ARC200 tokens)
      tokenA = w2u.get(wrappedTokA) ?? (unwrapList.includes(wrappedTokA) ? null : wrappedTokA);
      tokenB = w2u.get(wrappedTokB) ?? (unwrapList.includes(wrappedTokB) ? null : wrappedTokB);
      
      // If we can't determine underlying tokens, use wrapped tokens
      if (tokenA === null || tokenA === undefined) tokenA = wrappedTokA;
      if (tokenB === null || tokenB === undefined) tokenB = wrappedTokB;
    } else if (poolDex === 'nomadex') {
      // For Nomadex, use direct token IDs from config
      const tokA = pool.tokens?.tokA;
      const tokB = pool.tokens?.tokB;
      
      if (tokA && tokB) {
        tokenA = Number(tokA.id);
        tokenB = Number(tokB.id);
      } else {
        continue; // Skip invalid pool
      }
    } else {
      continue; // Unknown DEX type
    }
    
    if (tokenA === undefined || tokenB === undefined) {
      continue; // Skip invalid pool
    }
    
    // Add edge from tokenA to tokenB
    if (!graph.has(tokenA)) {
      graph.set(tokenA, new Set());
    }
    graph.get(tokenA).add({
      poolId: Number(pool.poolId),
      otherToken: tokenB,
      dex: poolDex,
      poolCfg: pool
    });
    
    // Add edge from tokenB to tokenA (bidirectional)
    if (!graph.has(tokenB)) {
      graph.set(tokenB, new Set());
    }
    graph.get(tokenB).add({
      poolId: Number(pool.poolId),
      otherToken: tokenA,
      dex: poolDex,
      poolCfg: pool
    });
  }
  
  return graph;
}

/**
 * Find multi-hop routes between two tokens using BFS
 * Returns routes grouped by token path with all available pools for each hop
 * @param {string|number} inputToken - Input token ID (underlying token)
 * @param {string|number} outputToken - Output token ID (underlying token)
 * @param {number} maxHops - Maximum number of hops (default: 2)
 * @param {Array<string>|undefined} dexFilter - Optional array of DEX names to filter by
 * @returns {Array<Object>} Array of route objects with poolOptions: [{poolOptions: [[pool1, pool2], [pool3]], intermediateTokens: [...], hops: 2}]
 */
function findRoutes(inputToken, outputToken, maxHops = 2, dexFilter) {
  loadConfigsOnce();
  
  const inputTokenNum = Number(inputToken);
  const outputTokenNum = Number(outputToken);
  
  // If same token, return empty routes
  if (inputTokenNum === outputTokenNum) {
    return [];
  }
  
  const graph = buildPoolGraph(dexFilter);
  
  // Map to store routes by token path (key: token sequence as string)
  const routesByPath = new Map();
  
  // BFS to find all paths up to maxHops
  const queue = [{
    token: inputTokenNum,
    path: [],
    visitedTokens: new Set([inputTokenNum])
  }];
  
  while (queue.length > 0) {
    const current = queue.shift();
    const currentToken = current.token;
    const path = current.path;
    const visitedTokens = current.visitedTokens;
    
    // If we've reached the output token, record this path
    if (currentToken === outputTokenNum) {
      if (path.length > 0) {
        // Build token sequence: [inputToken, intermediateToken1, ..., outputToken]
        const tokenSequence = [inputTokenNum, ...path.map(hop => hop.otherToken)];
        const pathKey = tokenSequence.join(',');
        
        // Initialize route for this path if not exists
        if (!routesByPath.has(pathKey)) {
          const intermediateTokens = path.slice(0, -1).map(hop => hop.otherToken);
          routesByPath.set(pathKey, {
            poolOptions: Array(path.length).fill(null).map(() => []),
            intermediateTokens: intermediateTokens,
            hops: path.length,
            tokenSequence: tokenSequence
          });
        }
        
        // Add this pool to the appropriate hop
        const route = routesByPath.get(pathKey);
        for (let i = 0; i < path.length; i++) {
          const poolCfg = path[i].poolCfg;
          // Check if pool already added (avoid duplicates)
          if (!route.poolOptions[i].some(p => p.poolId === poolCfg.poolId)) {
            route.poolOptions[i].push(poolCfg);
          }
        }
      }
      continue;
    }
    
    // If we've exceeded max hops, skip
    if (path.length >= maxHops) {
      continue;
    }
    
    // Explore neighbors
    const neighbors = graph.get(currentToken);
    if (neighbors) {
      for (const neighbor of neighbors) {
        // Skip if we've already visited this token (avoid cycles)
        if (visitedTokens.has(neighbor.otherToken)) {
          continue;
        }
        
        // Skip if this would exceed max hops
        if (path.length + 1 > maxHops) {
          continue;
        }
        
        queue.push({
          token: neighbor.otherToken,
          path: [...path, neighbor],
          visitedTokens: new Set([...visitedTokens, neighbor.otherToken])
        });
      }
    }
  }
  
  // Now, for each route found, collect ALL pools for each hop (not just from paths)
  // This ensures we get all pools (e.g., both HumbleSwap and Nomadex) for each token pair
  for (const route of routesByPath.values()) {
    const tokenSequence = route.tokenSequence;
    
    // For each hop, find all pools that can be used
    for (let hopIndex = 0; hopIndex < route.hops; hopIndex++) {
      const hopInputToken = tokenSequence[hopIndex];
      const hopOutputToken = tokenSequence[hopIndex + 1];
      
      // Get all neighbors (pools) for this token pair
      const neighbors = graph.get(hopInputToken);
      if (neighbors) {
        for (const neighbor of neighbors) {
          // Check if this neighbor connects to the output token for this hop
          if (neighbor.otherToken === hopOutputToken) {
            const poolCfg = neighbor.poolCfg;
            // Check if pool already added (avoid duplicates)
            if (!route.poolOptions[hopIndex].some(p => p.poolId === poolCfg.poolId)) {
              route.poolOptions[hopIndex].push(poolCfg);
            }
          }
        }
      }
    }
    
    // Debug: Log route with pool options
    if (DEBUG) {
      console.log(`[findRoutes] Route found: ${tokenSequence.join('->')}, hops: ${route.hops}`);
      route.poolOptions.forEach((pools, idx) => {
        console.log(`  Hop ${idx}: ${tokenSequence[idx]}->${tokenSequence[idx + 1]}, pools: ${pools.map(p => `${p.poolId}(${p.dex || 'humbleswap'})`).join(', ')}`);
      });
    }
  }
  
  // Convert map to array and sort by number of hops (shorter routes first)
  const routes = Array.from(routesByPath.values());
  routes.sort((a, b) => a.hops - b.hops);
  
  return routes;
}

/**
 * Generate all pool combinations from a route with pool options
 * Uses cartesian product to generate all possible combinations
 * @param {Object} routeWithOptions - Route object with poolOptions: {poolOptions: [[pool1, pool2], [pool3, pool4]], intermediateTokens: [...], hops: 2}
 * @param {number} maxCombinations - Maximum number of combinations to generate (default: 100)
 * @returns {Array<Object>} Array of concrete routes: [{pools: [pool1, pool3], intermediateTokens: [...], hops: 2}, ...]
 */
function generateRouteCombinations(routeWithOptions, maxCombinations = 100) {
  const { poolOptions, intermediateTokens, hops } = routeWithOptions;
  
  if (!poolOptions || poolOptions.length === 0) {
    return [];
  }
  
  // Calculate total combinations (cartesian product size)
  let totalCombinations = 1;
  for (const pools of poolOptions) {
    totalCombinations *= pools.length;
    if (totalCombinations > maxCombinations) {
      // Limit to avoid excessive computation
      break;
    }
  }
  
  // If too many combinations, limit pools per hop
  if (totalCombinations > maxCombinations) {
    // Limit each hop to reasonable number of pools
    const maxPoolsPerHop = Math.ceil(Math.pow(maxCombinations, 1 / poolOptions.length));
    const limitedPoolOptions = poolOptions.map(pools => 
      pools.slice(0, maxPoolsPerHop)
    );
    
    // Recalculate
    totalCombinations = 1;
    for (const pools of limitedPoolOptions) {
      totalCombinations *= pools.length;
    }
    
    if (DEBUG) console.log(`[generateRouteCombinations] Limited to ${totalCombinations} combinations (max ${maxCombinations})`);
    const combinations = generateCombinationsRecursive(limitedPoolOptions, intermediateTokens, hops);
    if (DEBUG) console.log(`[generateRouteCombinations] Generated ${combinations.length} combinations`);
    return combinations;
  }

  if (DEBUG) console.log(`[generateRouteCombinations] Generating ${totalCombinations} combinations`);
  const combinations = generateCombinationsRecursive(poolOptions, intermediateTokens, hops);
  if (DEBUG) {
    console.log(`[generateRouteCombinations] Generated ${combinations.length} combinations`);
    combinations.forEach((combo, idx) => {
      console.log(`  Combination ${idx + 1}: ${combo.pools.map(p => `${p.poolId}(${p.dex || 'humbleswap'})`).join(' -> ')}`);
    });
  }
  return combinations;
}

/**
 * Recursively generate all combinations using cartesian product
 * @param {Array<Array>} poolOptions - Array of pool arrays for each hop
 * @param {Array} intermediateTokens - Intermediate token IDs
 * @param {number} hops - Number of hops
 * @returns {Array<Object>} Array of concrete routes
 */
function generateCombinationsRecursive(poolOptions, intermediateTokens, hops) {
  const combinations = [];
  
  // Recursive function to generate cartesian product
  function generate(index, currentCombination) {
    if (index === poolOptions.length) {
      // Base case: we've selected a pool for each hop
      combinations.push({
        pools: [...currentCombination],
        intermediateTokens: intermediateTokens,
        hops: hops
      });
      return;
    }
    
    // Try each pool for this hop
    for (const pool of poolOptions[index]) {
      generate(index + 1, [...currentCombination, pool]);
    }
  }
  
  generate(0, []);
  return combinations;
}

/**
 * Find matching pools for a given token pair
 * @param {string|number} inputToken - Input token ID (underlying token, not wrapped)
 * @param {string|number} outputToken - Output token ID (underlying token, not wrapped)
 * @param {Array<string>|undefined} dexFilter - Optional array of DEX names to filter by (e.g., ["humbleswap", "nomadex"])
 * @returns {Array<Object>} Array of matching pool configs
 */
function findMatchingPools(inputToken, outputToken, dexFilter) {
  loadConfigsOnce();
  const inputTokenStr = String(inputToken);
  const outputTokenStr = String(outputToken);
  const inputTokenNum = Number(inputToken);
  const outputTokenNum = Number(outputToken);
  
  const matchingPools = [];
  
  // Default to all DEXes if no filter provided
  const allowedDexes = dexFilter && Array.isArray(dexFilter) && dexFilter.length > 0
    ? dexFilter.map(d => String(d).toLowerCase())
    : ['humbleswap', 'nomadex'];
  
  for (const pool of poolsConfig.pools) {
    const poolDex = (pool.dex || 'humbleswap').toLowerCase();
    
    // Filter by DEX if specified
    if (!allowedDexes.includes(poolDex)) {
      continue;
    }
    
    let matches = false;
    
    if (poolDex === 'humbleswap') {
      // For HumbleSwap, check underlyingToWrapped mappings
      const u2w = pool.tokens?.underlyingToWrapped || {};
      const wrappedPair = pool.tokens?.wrappedPair || {};
      const tokA = Number(wrappedPair.tokA);
      const tokB = Number(wrappedPair.tokB);
      
      // Try both string and number keys (JSON may have either)
      // If token is not in underlyingToWrapped, it's already wrapped (e.g., ARC200 tokens)
      const inputWrapped = u2w[inputTokenStr] ?? u2w[inputTokenNum] ?? inputTokenNum;
      const outputWrapped = u2w[outputTokenStr] ?? u2w[outputTokenNum] ?? outputTokenNum;
      
      const inputWrappedNum = Number(inputWrapped);
      const outputWrappedNum = Number(outputWrapped);
      
      // Check if the wrapped tokens form a valid pair in this pool
      const matchesPair =
        (inputWrappedNum === tokA && outputWrappedNum === tokB) ||
        (inputWrappedNum === tokB && outputWrappedNum === tokA);
      
      if (matchesPair) {
        matches = true;
      }
    } else if (poolDex === 'nomadex') {
      // For Nomadex, check direct token IDs from config
      const tokA = pool.tokens?.tokA;
      const tokB = pool.tokens?.tokB;
      
      if (tokA && tokB) {
        const tokANum = Number(tokA.id);
        const tokBNum = Number(tokB.id);
        
        const matchesPair =
          (inputTokenNum === tokANum && outputTokenNum === tokBNum) ||
          (inputTokenNum === tokBNum && outputTokenNum === tokANum);
        
        if (matchesPair) {
          matches = true;
        }
      }
    }
    
    if (matches) {
      matchingPools.push(pool);
    }
  }
  
  return matchingPools;
}

export {
  initializeConfig,
  loadConfigsOnce,
  getPoolConfigById,
  getTokenMetaFromConfig,
  getUnderlyingForWrapped,
  getWrappedId,
  findMatchingPools,
  buildPoolGraph,
  findRoutes,
  generateRouteCombinations,
  getDiscoveryStatus,
  poolsConfig,
  tokensConfig
};

