import { getWrappedId } from './config.js';

/**
 * Fetch USD values for a list of tokens from Mimir API
 * @param {Array<string|number>} tokenIds - Array of token IDs (underlying or wrapped)
 * @returns {Promise<Object>} Map of token ID to USD value
 */
export async function fetchTokenPrices(tokenIds) {
  if (!tokenIds || tokenIds.length === 0) {
    return {};
  }

  // Unique list of original IDs
  const uniqueIds = [...new Set(tokenIds.map(id => String(id)))];
  
  // Map original ID to wrapped ID
  const idMapping = new Map();
  const wrappedIds = new Set();

  for (const id of uniqueIds) {
    const wrappedId = getWrappedId(id);
    // Ensure wrappedId is valid before adding
    if (wrappedId !== null && wrappedId !== undefined) {
        idMapping.set(id, String(wrappedId));
        wrappedIds.add(String(wrappedId));
    }
  }

  if (wrappedIds.size === 0) {
    return {};
  }

  try {
    const url = `https://voi-mainnet-mimirapi.nftnavigator.xyz/arc200/values?tokenIds=${Array.from(wrappedIds).join(',')}`;
    
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`Failed to fetch token prices: ${response.status} ${response.statusText}`);
      return {};
    }

    const data = await response.json();
    
    // Map back to original IDs
    const result = {};
    for (const [originalId, wrappedId] of idMapping.entries()) {
      if (data[wrappedId] !== undefined) {
        result[originalId] = data[wrappedId];
      }
    }

    return result;
  } catch (error) {
    console.error('Error fetching token prices:', error);
    return {};
  }
}
