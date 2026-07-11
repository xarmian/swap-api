// Regression tests for the token-decimals cache (lib/utils.js: getTokenDecimals).
// Run with: node --test tests/decimals-cache.test.js
//
// Bug: a transient indexer failure used to cache the fallback decimals value
// (6) permanently, silently mispricing every future quote for that token
// (wrong rate forever, even after the indexer recovers). These tests mock
// indexerClient.lookupAssetByID (no network) and assert the fallback is never
// cached: an unknown/uncached token id keeps retrying the indexer on every
// call until a lookup actually succeeds, at which point (and only then) the
// real decimals value sticks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getTokenDecimals } from '../lib/utils.js';
import { indexerClient } from '../lib/clients.js';

// Token id that is guaranteed not to be present in the static/discovered
// token config (so getTokenDecimals always falls through to the indexer
// lookup) and not previously used by another test (the module-level decimals
// cache is process-wide and has no reset hook).
const UNKNOWN_TOKEN_ID = '918273645';

test('getTokenDecimals: a failed indexer lookup does not poison the cache', async (t) => {
  let calls = 0;
  t.mock.method(indexerClient, 'lookupAssetByID', () => {
    calls++;
    return { do: async () => { throw new Error('simulated transient indexer failure'); } };
  });

  const first = await getTokenDecimals(UNKNOWN_TOKEN_ID);
  assert.equal(first, 6); // fallback used for this request only

  const second = await getTokenDecimals(UNKNOWN_TOKEN_ID);
  assert.equal(second, 6);

  // Not cached: the indexer must have been consulted again on the second call,
  // not served from a poisoned cache entry.
  assert.equal(calls, 2);
});

test('getTokenDecimals: a later successful lookup replaces the fallback and IS cached', async (t) => {
  let calls = 0;
  t.mock.method(indexerClient, 'lookupAssetByID', () => {
    calls++;
    return { do: async () => { throw new Error('simulated transient indexer failure'); } };
  });

  const failed = await getTokenDecimals(UNKNOWN_TOKEN_ID);
  assert.equal(failed, 6);
  assert.equal(calls, 1);

  // Indexer recovers and returns the real decimals for this asset.
  t.mock.method(indexerClient, 'lookupAssetByID', () => {
    calls++;
    return { do: async () => ({ asset: { params: { decimals: 8 } } }) };
  });

  const recovered = await getTokenDecimals(UNKNOWN_TOKEN_ID);
  assert.equal(recovered, 8);
  assert.equal(calls, 2);

  // Now cached: a subsequent call must NOT hit the indexer again, and must
  // keep returning the correct (recovered) value, not the stale fallback.
  const cached = await getTokenDecimals(UNKNOWN_TOKEN_ID);
  assert.equal(cached, 8);
  assert.equal(calls, 2); // no additional indexer call
});

test('getTokenDecimals: a response missing the decimals field is treated as a failed lookup (not cached)', async (t) => {
  const tokenId = '918273646'; // distinct id: cache is process-wide/shared across tests
  let calls = 0;
  t.mock.method(indexerClient, 'lookupAssetByID', () => {
    calls++;
    return { do: async () => ({ asset: { params: {} } }) }; // no decimals field
  });

  const first = await getTokenDecimals(tokenId);
  assert.equal(first, 6);
  const second = await getTokenDecimals(tokenId);
  assert.equal(second, 6);

  // Not cached: the malformed response must not have stuck as the answer.
  assert.equal(calls, 2);

  t.mock.method(indexerClient, 'lookupAssetByID', () => {
    calls++;
    return { do: async () => ({ asset: { params: { decimals: 10 } } }) };
  });
  const recovered = await getTokenDecimals(tokenId);
  assert.equal(recovered, 10);
  assert.equal(calls, 3);
});
