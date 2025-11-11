import { getPoolInfo as getHumbleswapPoolInfo } from './humbleswap.js';
import { getPoolInfo as getNomadexPoolInfo } from './nomadex.js';

const API_BASE_URL = 'https://voi-mainnet-mimirapi.nftnavigator.xyz';

// Cache for token metadata to avoid redundant API calls
const tokenMetadataCache = new Map();

/**
 * Fetch pool information from API endpoint
 * @param {number} poolId - Pool ID
 * @returns {Promise<Object>} Pool data from API
 */
async function fetchPoolInfo(poolId) {
  const url = `${API_BASE_URL}/dex/pools?poolId=${poolId}`;
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`Failed to fetch pool info for ${poolId}: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  
  if (!data.pools || data.pools.length === 0) {
    throw new Error(`No pool found for poolId ${poolId}`);
  }
  
  return data.pools[0];
}

/**
 * Fetch token metadata from API endpoint
 * @param {number} contractId - Token contract ID
 * @returns {Promise<Object>} Token metadata from API
 */
async function fetchTokenInfo(contractId) {
  // Check cache first
  const cacheKey = String(contractId);
  if (tokenMetadataCache.has(cacheKey)) {
    return tokenMetadataCache.get(cacheKey);
  }
  
  const url = `${API_BASE_URL}/arc200/tokens?contractId=${contractId}`;
  const response = await fetch(url);
  
  if (!response.ok) {
    // If token not found, return null (might be native token or ASA)
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch token info for ${contractId}: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  
  if (!data.tokens || data.tokens.length === 0) {
    return null;
  }
  
  const tokenInfo = data.tokens[0];
  tokenMetadataCache.set(cacheKey, tokenInfo);
  return tokenInfo;
}

/**
 * Determine token type for Nomadex pools
 * Maps API type to config type format
 * @param {number} tokenId - Token ID
 * @param {string|undefined} apiType - Type from API (e.g., "VOI", "ASA", "ARC200")
 * @param {Object} tokenInfo - Token info from API (if available)
 * @returns {string} Token type: 'native', 'ASA', or 'ARC200'
 */
function determineTokenType(tokenId, apiType, tokenInfo) {
  if (tokenId === 0) {
    return 'native';
  }
  
  // Use API type if available
  if (apiType) {
    const apiTypeLower = apiType.toLowerCase();
    if (apiTypeLower === 'voi' || apiTypeLower === 'native') {
      return 'native';
    } else if (apiTypeLower === 'asa') {
      return 'ASA';
    } else if (apiTypeLower === 'arc200') {
      return 'ARC200';
    }
  }
  
  // Fallback: If we have token info from API, it's ARC200
  if (tokenInfo) {
    return 'ARC200';
  }
  
  // Default to ASA if we can't determine
  return 'ASA';
}

/**
 * Discover a single pool and build its configuration
 * @param {number} poolId - Pool ID
 * @param {Algodv2} algodClient - Algod client
 * @param {Indexer} indexerClient - Indexer client
 * @returns {Promise<Object>} Pool configuration object
 */
export async function discoverPool(poolId, algodClient, indexerClient) {
  try {
    // Fetch pool info from API
    const apiPoolInfo = await fetchPoolInfo(poolId);
    
    // Determine DEX type from exchange field
    const exchange = apiPoolInfo.exchange?.toLowerCase();
    let dex = 'humbleswap'; // default
    
    if (exchange === 'nomadex') {
      dex = 'nomadex';
    } else if (exchange === 'humble' || exchange === 'humbleswap') {
      dex = 'humbleswap';
    }
    
    if (dex === 'humbleswap') {
      // For HumbleSwap, ALWAYS validate using Info() to get actual token IDs
      const poolInfo = await getHumbleswapPoolInfo(poolId, algodClient, indexerClient);
      
      const tokA = Number(poolInfo.tokA);
      const tokB = Number(poolInfo.tokB);
      
      // Fetch token metadata for both tokens
      const tokenAInfo = await fetchTokenInfo(tokA);
      const tokenBInfo = await fetchTokenInfo(tokB);
      
      // Build underlyingToWrapped mapping
      const underlyingToWrapped = {};
      const unwrap = [];
      
      // Check tokenA - if tokenId exists (including "0"), it's a wrapped token
      if (tokenAInfo) {
        const tokenIdValue = tokenAInfo.tokenId;
        // Check if tokenId exists and is not empty (including "0" which means wrapped native VOI)
        if (tokenIdValue !== null && tokenIdValue !== undefined && tokenIdValue !== '') {
          const underlyingId = Number(tokenIdValue);
          // Only add if underlyingId is a valid number (including 0 for native VOI)
          if (!isNaN(underlyingId)) {
            underlyingToWrapped[underlyingId] = tokA;
            unwrap.push(tokA);
            console.log(`[Discovery] Pool ${poolId}: TokenA ${tokA} is wrapped version of underlying ${underlyingId}`);
          }
        }
      }
      
      // Check tokenB - if tokenId exists (including "0"), it's a wrapped token
      if (tokenBInfo) {
        const tokenIdValue = tokenBInfo.tokenId;
        // Check if tokenId exists and is not empty (including "0" which means wrapped native VOI)
        if (tokenIdValue !== null && tokenIdValue !== undefined && tokenIdValue !== '') {
          const underlyingId = Number(tokenIdValue);
          // Only add if underlyingId is a valid number (including 0 for native VOI)
          if (!isNaN(underlyingId)) {
            underlyingToWrapped[underlyingId] = tokB;
            unwrap.push(tokB);
            console.log(`[Discovery] Pool ${poolId}: TokenB ${tokB} is wrapped version of underlying ${underlyingId}`);
          }
        }
      }
      
      // Build pool config
      const poolConfig = {
        poolId: poolId,
        dex: 'humbleswap',
        name: `${tokenAInfo?.symbol || tokA}/${tokenBInfo?.symbol || tokB}`,
        tokens: {
          underlyingToWrapped: underlyingToWrapped,
          wrappedPair: {
            tokA: tokA,
            tokB: tokB
          },
          unwrap: unwrap
        },
        slippageDefault: 0.01,
        fee: 100 // Default HumbleSwap fee (1% = 100 basis points)
      };
      
      // Store token metadata in cache for later use
      // Keep the full token info (including tokenId) in cache, don't overwrite with simplified version
      // The fetchTokenInfo function already caches the full object, so we don't need to cache again here
      // But we ensure it's cached with all necessary fields
      if (tokenAInfo && !tokenMetadataCache.has(String(tokA))) {
        tokenMetadataCache.set(String(tokA), tokenAInfo);
      }
      if (tokenBInfo && !tokenMetadataCache.has(String(tokB))) {
        tokenMetadataCache.set(String(tokB), tokenBInfo);
      }
      
      return poolConfig;
      
    } else if (dex === 'nomadex') {
      // For Nomadex, use API tokenA/tokenB data
      const tokenA = apiPoolInfo.tokenA;
      const tokenB = apiPoolInfo.tokenB;
      
      if (!tokenA || !tokenB) {
        throw new Error(`Missing token information in API response for pool ${poolId}`);
      }
      
      const tokAId = Number(tokenA.id);
      const tokBId = Number(tokenB.id);
      
      // Fetch token metadata
      const tokenAInfo = tokAId === 0 ? null : await fetchTokenInfo(tokAId);
      const tokenBInfo = tokBId === 0 ? null : await fetchTokenInfo(tokBId);
      
      // Determine token types (use API type field if available)
      const tokAType = determineTokenType(tokAId, tokenA?.type, tokenAInfo);
      const tokBType = determineTokenType(tokBId, tokenB?.type, tokenBInfo);
      
      // Get symbols from API or token info
      const tokASymbol = tokenA?.symbol || tokenAInfo?.symbol || (tokAId === 0 ? 'VOI' : String(tokAId));
      const tokBSymbol = tokenB?.symbol || tokenBInfo?.symbol || (tokBId === 0 ? 'VOI' : String(tokBId));
      
      // Build pool config
      const poolConfig = {
        poolId: poolId,
        dex: 'nomadex',
        name: `${tokASymbol}/${tokBSymbol}`,
        tokens: {
          tokA: {
            id: tokAId,
            type: tokAType
          },
          tokB: {
            id: tokBId,
            type: tokBType
          }
        },
        slippageDefault: 0.01,
        fee: 200 // Default Nomadex fee (2% = 200 basis points)
      };
      
      // Store token metadata in cache (use API data if available, otherwise token info)
      if (tokAId === 0) {
        // Native VOI
        tokenMetadataCache.set('0', {
          symbol: tokenA?.symbol || 'VOI',
          name: 'Voi',
          decimals: tokenA?.decimals || 6
        });
      } else if (tokenAInfo) {
        tokenMetadataCache.set(String(tokAId), {
          symbol: tokenA?.symbol || tokenAInfo.symbol,
          name: tokenAInfo.name,
          decimals: tokenA?.decimals || tokenAInfo.decimals
        });
      } else if (tokenA?.symbol) {
        // Use API data if token info not available
        tokenMetadataCache.set(String(tokAId), {
          symbol: tokenA.symbol,
          name: tokenA.symbol,
          decimals: tokenA.decimals || 6
        });
      }
      
      if (tokBId === 0) {
        // Native VOI
        tokenMetadataCache.set('0', {
          symbol: tokenB?.symbol || 'VOI',
          name: 'Voi',
          decimals: tokenB?.decimals || 6
        });
      } else if (tokenBInfo) {
        tokenMetadataCache.set(String(tokBId), {
          symbol: tokenB?.symbol || tokenBInfo.symbol,
          name: tokenBInfo.name,
          decimals: tokenB?.decimals || tokenBInfo.decimals
        });
      } else if (tokenB?.symbol) {
        // Use API data if token info not available
        tokenMetadataCache.set(String(tokBId), {
          symbol: tokenB.symbol,
          name: tokenB.symbol,
          decimals: tokenB.decimals || 6
        });
      }
      
      return poolConfig;
      
    } else {
      throw new Error(`Unknown DEX type: ${exchange} for pool ${poolId}`);
    }
    
  } catch (error) {
    console.error(`Error discovering pool ${poolId}:`, error);
    throw error;
  }
}

/**
 * Discover all pools from a list of pool IDs
 * @param {Array<number>} poolIds - Array of pool IDs
 * @param {Algodv2} algodClient - Algod client
 * @param {Indexer} indexerClient - Indexer client
 * @returns {Promise<Object>} Configuration object with pools array and tokens object
 */
export async function discoverAllPools(poolIds, algodClient, indexerClient) {
  const pools = [];
  const tokens = {};
  
  console.log(`[Discovery] Starting discovery of ${poolIds.length} pools...`);
  
  for (let i = 0; i < poolIds.length; i++) {
    const poolId = poolIds[i];
    try {
      console.log(`[Discovery] Discovering pool ${poolId} (${i + 1}/${poolIds.length})...`);
      const poolConfig = await discoverPool(poolId, algodClient, indexerClient);
      pools.push(poolConfig);
      console.log(`[Discovery] Successfully discovered pool ${poolId}`);
    } catch (error) {
      console.warn(`[Discovery] Failed to discover pool ${poolId}:`, error.message);
      // Continue with other pools
    }
  }
  
  // Build tokens object from cache
  for (const [tokenId, metadata] of tokenMetadataCache.entries()) {
    tokens[tokenId] = metadata;
  }
  
  console.log(`[Discovery] Completed: ${pools.length}/${poolIds.length} pools discovered, ${Object.keys(tokens).length} tokens cached`);
  
  return {
    pools: pools,
    tokens: tokens
  };
}

/**
 * Get token metadata from cache
 * Returns a simplified object with just symbol, name, decimals for backward compatibility
 * @param {string|number} tokenId - Token ID
 * @returns {Object|null} Token metadata or null if not found
 */
export function getTokenMetadata(tokenId) {
  const key = String(tokenId);
  const fullInfo = tokenMetadataCache.get(key);
  if (!fullInfo) {
    return null;
  }
  // Return simplified version for backward compatibility
  return {
    symbol: fullInfo.symbol,
    name: fullInfo.name,
    decimals: fullInfo.decimals
  };
}

/**
 * Get all tokens from cache with full metadata including is_wrapped flag
 * @returns {Array<Object>} Array of token objects with id, symbol, name, decimals, is_wrapped
 */
export function getAllTokens() {
  const tokens = [];
  
  for (const [tokenId, fullInfo] of tokenMetadataCache.entries()) {
    // Determine if token is wrapped by checking if tokenId property exists and is not null/undefined/empty
    const isWrapped = fullInfo.tokenId !== null && 
                     fullInfo.tokenId !== undefined && 
                     fullInfo.tokenId !== '';
    
    tokens.push({
      id: Number(tokenId) || tokenId, // Return as number if possible, otherwise keep as string
      symbol: fullInfo.symbol || null,
      name: fullInfo.name || null,
      decimals: fullInfo.decimals || null,
      is_wrapped: isWrapped
    });
  }
  
  // Sort by token ID for consistent ordering
  tokens.sort((a, b) => {
    const idA = Number(a.id) || 0;
    const idB = Number(b.id) || 0;
    return idA - idB;
  });
  
  return tokens;
}

