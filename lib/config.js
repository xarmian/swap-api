import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config loading (local pools/tokens) ---

let poolsConfig = null;
let tokensConfig = null;

function loadJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function loadConfigsOnce() {
  if (poolsConfig && tokensConfig) return;
  const poolsPath = path.join(__dirname, '..', 'config', 'pools.json');
  const tokensPath = path.join(__dirname, '..', 'config', 'tokens.json');
  poolsConfig = loadJSON(poolsPath);
  tokensConfig = loadJSON(tokensPath) || { tokens: {} };
  if (!poolsConfig || !Array.isArray(poolsConfig.pools)) {
    throw new Error('Invalid or missing config/pools.json');
  }
}

function getPoolConfigById(poolId) {
  loadConfigsOnce();
  const pid = Number(poolId);
  const found = poolsConfig.pools.find(p => Number(p.poolId) === pid);
  return found || null;
}

function getTokenMetaFromConfig(tokenId) {
  loadConfigsOnce();
  const t = tokensConfig.tokens[String(tokenId)];
  return t || null;
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
    console.log(`[findRoutes] Route found: ${tokenSequence.join('->')}, hops: ${route.hops}`);
    route.poolOptions.forEach((pools, idx) => {
      console.log(`  Hop ${idx}: ${tokenSequence[idx]}->${tokenSequence[idx + 1]}, pools: ${pools.map(p => `${p.poolId}(${p.dex || 'humbleswap'})`).join(', ')}`);
    });
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
    
    console.log(`[generateRouteCombinations] Limited to ${totalCombinations} combinations (max ${maxCombinations})`);
    const combinations = generateCombinationsRecursive(limitedPoolOptions, intermediateTokens, hops);
    console.log(`[generateRouteCombinations] Generated ${combinations.length} combinations`);
    return combinations;
  }
  
  console.log(`[generateRouteCombinations] Generating ${totalCombinations} combinations`);
  const combinations = generateCombinationsRecursive(poolOptions, intermediateTokens, hops);
  console.log(`[generateRouteCombinations] Generated ${combinations.length} combinations`);
  combinations.forEach((combo, idx) => {
    console.log(`  Combination ${idx + 1}: ${combo.pools.map(p => `${p.poolId}(${p.dex || 'humbleswap'})`).join(' -> ')}`);
  });
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
  loadConfigsOnce,
  getPoolConfigById,
  getTokenMetaFromConfig,
  findMatchingPools,
  buildPoolGraph,
  findRoutes,
  generateRouteCombinations,
  poolsConfig,
  tokensConfig
};

