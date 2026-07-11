// Regression tests for the process-lifetime app-creator cache
// (lib/transactions.js: getAppCreatorAddress). Run with:
//   node --test tests/creator-cache.test.js
//
// App creators are immutable, so once resolved they are cached for the life of
// the process to avoid a sequential indexer lookup per app on every request.
// These tests mock indexerClient.lookupApplications (no network) and assert:
//   - a repeat lookup for the same app id is served from cache (no re-fetch),
//   - Number and BigInt app ids normalize to the same key (no double fetch),
//   - distinct app ids do not collide,
//   - a failed lookup returns null and is NOT cached (retries later).
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAppCreatorAddress } from '../lib/transactions.js';
import { indexerClient } from '../lib/clients.js';

// App ids chosen to be unused by other tests (the cache is process-wide and has
// no reset hook, so each test uses a distinct id).
const APP_A = 987650001;
const APP_B = 987650002;
const APP_C = 987650003;

test('getAppCreatorAddress: repeat + BigInt/Number lookups hit the cache once', async (t) => {
  let calls = 0;
  t.mock.method(indexerClient, 'lookupApplications', () => {
    calls++;
    return { do: async () => ({ application: { params: { creator: 'CREATOR_A' } } }) };
  });

  const first = await getAppCreatorAddress(APP_A);
  assert.equal(first, 'CREATOR_A');
  assert.equal(calls, 1);

  // Same app id (Number) -> served from cache, no new indexer call.
  const second = await getAppCreatorAddress(APP_A);
  assert.equal(second, 'CREATOR_A');
  assert.equal(calls, 1);

  // Same app id as a BigInt -> normalizes to the same numeric key, still cached.
  const third = await getAppCreatorAddress(BigInt(APP_A));
  assert.equal(third, 'CREATOR_A');
  assert.equal(calls, 1);
});

test('getAppCreatorAddress: distinct uint64 ids beyond MAX_SAFE_INTEGER do not collide', async (t) => {
  // String(appId) keys avoid the precision loss that Number(appId) would suffer
  // above 2^53 (9007199254740992n and 9007199254740993n would both -> 2^53).
  const APP_HI_1 = 9007199254740993n;
  const APP_HI_2 = 9007199254740995n;
  t.mock.method(indexerClient, 'lookupApplications', (id) => ({
    do: async () => ({ application: { params: { creator: `CREATOR_${String(id)}` } } })
  }));

  const c1 = await getAppCreatorAddress(APP_HI_1);
  const c2 = await getAppCreatorAddress(APP_HI_2);
  assert.equal(c1, `CREATOR_${String(APP_HI_1)}`);
  assert.equal(c2, `CREATOR_${String(APP_HI_2)}`);
  assert.notEqual(c1, c2); // no cross-key collision
});

test('getAppCreatorAddress: normalizes an Address-object creator to a string', async (t) => {
  t.mock.method(indexerClient, 'lookupApplications', () => ({
    do: async () => ({
      application: { params: { creator: { toString: () => 'CREATOR_OBJ_B' } } }
    })
  }));

  const creator = await getAppCreatorAddress(APP_B);
  assert.equal(creator, 'CREATOR_OBJ_B');
  assert.equal(typeof creator, 'string');
});

test('getAppCreatorAddress: a failed lookup returns null and is NOT cached (retries)', async (t) => {
  let calls = 0;
  t.mock.method(indexerClient, 'lookupApplications', () => {
    calls++;
    return { do: async () => { throw new Error('simulated indexer failure'); } };
  });

  const first = await getAppCreatorAddress(APP_C);
  assert.equal(first, null);
  const second = await getAppCreatorAddress(APP_C);
  assert.equal(second, null);
  assert.equal(calls, 2); // not cached -> retried
});
