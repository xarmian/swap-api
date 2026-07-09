// Unit tests for Nomadex reserve derivation (getPoolInfo).
// Run with: node --test tests/nomadex-reserves.test.js
//
// These tests mock the algod/indexer clients so they exercise the native + ASA
// reserve paths without any network access. The ARC200 path is covered by the
// live smoke test, since it depends on ulujs contract simulation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getPoolInfo } from '../lib/nomadex.js';

const POOL_ID = 411756; // any valid app id; address is derived from it

// Build a mock indexer whose application has the given global-state entries.
// Mirrors the algosdk 3.x response shape: camelCase `globalState`, keys as
// Uint8Array, and uint values as BigInt.
function mockIndexer(globalState = []) {
  return {
    lookupApplications() {
      return {
        do: async () => ({
          application: { params: { globalState } }
        })
      };
    }
  };
}

// Build a mock algod returning the given account information.
function mockAlgod(accountInfo) {
  return {
    accountInformation() {
      return { do: async () => accountInfo };
    }
  };
}

const nativeAsaConfig = {
  tokens: {
    tokA: { id: 0, type: 'native' },
    tokB: { id: 302190, type: 'ASA' }
  }
};

test('native reserve subtracts account min-balance; ASA reserve is the holding', async () => {
  const algod = mockAlgod({
    amount: 25733853342n,
    minBalance: 621500n,
    assets: [{ assetId: 302190n, amount: 3429352n }]
  });
  const info = await getPoolInfo(POOL_ID, algod, mockIndexer(), nativeAsaConfig);
  assert.equal(info.reserveA, (25733853342n - 621500n).toString());
  assert.equal(info.reserveB, '3429352');
  assert.equal(info.tokA, 0);
  assert.equal(info.tokB, 302190);
});

test('reserves map to the correct side when native is tokB', async () => {
  const algod = mockAlgod({
    amount: 1000000n,
    minBalance: 100000n,
    assets: [{ assetId: 302190n, amount: 42n }]
  });
  const config = {
    tokens: {
      tokA: { id: 302190, type: 'ASA' },
      tokB: { id: 0, type: 'native' }
    }
  };
  const info = await getPoolInfo(POOL_ID, algod, mockIndexer(), config);
  assert.equal(info.reserveA, '42'); // ASA holding
  assert.equal(info.reserveB, (1000000n - 100000n).toString()); // native spendable
});

test('missing min-balance fails explicitly (no raw-balance fallback)', async () => {
  const algod = mockAlgod({ amount: 1000000n, assets: [{ assetId: 302190n, amount: 42n }] });
  await assert.rejects(
    () => getPoolInfo(POOL_ID, algod, mockIndexer(), nativeAsaConfig),
    /min-balance unavailable/
  );
});

test('native balance below min-balance fails explicitly', async () => {
  const algod = mockAlgod({
    amount: 500n,
    minBalance: 621500n,
    assets: [{ assetId: 302190n, amount: 42n }]
  });
  await assert.rejects(
    () => getPoolInfo(POOL_ID, algod, mockIndexer(), nativeAsaConfig),
    /below min-balance/
  );
});

test('non-positive reserve fails explicitly (no zero-reserve quotes)', async () => {
  const algod = mockAlgod({
    amount: 1000000n,
    minBalance: 100000n,
    assets: [{ assetId: 302190n, amount: 0n }] // drained ASA side
  });
  await assert.rejects(
    () => getPoolInfo(POOL_ID, algod, mockIndexer(), nativeAsaConfig),
    /non-positive reserves/
  );
});

test('identical token IDs fail explicitly', async () => {
  const algod = mockAlgod({ amount: 1000000n, minBalance: 100000n, assets: [] });
  const config = { tokens: { tokA: { id: 0 }, tokB: { id: 0 } } };
  await assert.rejects(
    () => getPoolInfo(POOL_ID, algod, mockIndexer(), config),
    /identical token IDs/
  );
});

test('fee decodes from uint (type 2) state and ignores byteslice (type 1)', async () => {
  const algod = mockAlgod({
    amount: 1000000n,
    minBalance: 100000n,
    assets: [{ assetId: 302190n, amount: 42n }]
  });
  const globalState = [
    // fee = 50 stored as uint (type 2), BigInt value per algosdk 3.x
    { key: new Uint8Array(Buffer.from('fee')), value: { type: 2, uint: 50n } },
    // a byteslice entry (type 1) must never be read as a number
    { key: new Uint8Array(Buffer.from('symbol')), value: { type: 1, bytes: new Uint8Array(Buffer.from('UNIT')) } }
  ];
  const info = await getPoolInfo(POOL_ID, algod, mockIndexer(globalState), nativeAsaConfig);
  assert.equal(info.fee, 50);
});
