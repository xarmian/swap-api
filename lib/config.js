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
  poolsConfig,
  tokensConfig
};

