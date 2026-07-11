import { getWrappedId } from './config.js';
import { fetchWithRetry } from './httpFetch.js';

// Short-TTL cache of USD values keyed by ORIGINAL token id. USD prices move
// slowly relative to a quote's lifetime, so serving a value up to PRICE_TTL_MS
// old avoids an external API round-trip on every quote without meaningfully
// staling the displayed price. Only successful lookups are cached (misses are
// retried), so a transient API failure can't poison the cache. Keying by the
// original id (not the wrapped id) means different original tokens never collide.
const PRICE_TTL_MS = 20_000;
const priceCache = new Map(); // originalId(String) -> { value, expiresAt }

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

  const now = Date.now();
  const result = {};

  // Serve fresh cache hits directly; only the rest need an API call.
  const idsToFetch = [];
  for (const id of uniqueIds) {
    const cached = priceCache.get(id);
    if (cached && cached.expiresAt > now) {
      result[id] = cached.value;
    } else {
      idsToFetch.push(id);
    }
  }

  if (idsToFetch.length === 0) {
    return result;
  }

  // Map original ID to wrapped ID (only for the ids we still need)
  const idMapping = new Map();
  const wrappedIds = new Set();

  for (const id of idsToFetch) {
    const wrappedId = getWrappedId(id);
    // Ensure wrappedId is valid before adding
    if (wrappedId !== null && wrappedId !== undefined) {
        idMapping.set(id, String(wrappedId));
        wrappedIds.add(String(wrappedId));
    }
  }

  if (wrappedIds.size === 0) {
    return result;
  }

  try {
    const url = `https://voi-mainnet-mimirapi.nftnavigator.xyz/arc200/values?tokenIds=${Array.from(wrappedIds).join(',')}`;

    const response = await fetchWithRetry(url);
    if (!response.ok) {
      console.warn(`Failed to fetch token prices: ${response.status} ${response.statusText}`);
      return result;
    }

    const data = await response.json();

    // Map back to original IDs and cache successful lookups.
    const expiresAt = Date.now() + PRICE_TTL_MS;
    for (const [originalId, wrappedId] of idMapping.entries()) {
      if (data[wrappedId] !== undefined) {
        result[originalId] = data[wrappedId];
        priceCache.set(originalId, { value: data[wrappedId], expiresAt });
      }
    }

    return result;
  } catch (error) {
    console.error('Error fetching token prices:', error);
    return result;
  }
}
