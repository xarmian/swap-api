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

// Encode a big-endian uint256 the way Nomadex stores swap_fee / platform_fee:
// a 32-byte byteslice (type 1), returned as Uint8Array by algosdk 3.x.
function uint256Bytes(value) {
  const hex = BigInt(value).toString(16).padStart(64, '0');
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

// Live fee global-state entries. The pool holds swap_fee + factory id; the
// factory holds platform_fee. The mock indexer returns this same array for both
// the pool and factory lookups, so both reads resolve here. Combined default
// 1e12 + 1e12 over the 1e14 scale = 200 bps.
function feeState({
  swapFee = 1000000000000n,
  platformFee = 1000000000000n,
  factoryId = 411751n
} = {}) {
  return [
    { key: new Uint8Array(Buffer.from('swap_fee')), value: { type: 1, bytes: uint256Bytes(swapFee) } },
    { key: new Uint8Array(Buffer.from('factory')), value: { type: 2, uint: factoryId } },
    { key: new Uint8Array(Buffer.from('platform_fee')), value: { type: 1, bytes: uint256Bytes(platformFee) } }
  ];
}

// Build a mock indexer whose application has the given global-state entries.
// Mirrors the algosdk 3.x response shape: camelCase `globalState`, keys as
// Uint8Array, and uint values as BigInt. Defaults to a valid live fee state so
// reserve-focused tests reach the reserve logic.
function mockIndexer(globalState = feeState()) {
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
  assert.equal(info.fee, 200); // (1e12 swap_fee + 1e12 platform_fee) / 1e14 = 2%
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

const feeAlgod = () => mockAlgod({
  amount: 1000000n,
  minBalance: 100000n,
  assets: [{ assetId: 302190n, amount: 42n }]
});

test('fee = ceil((swap_fee + platform_fee) * 10000 / 1e14) in basis points', async () => {
  // 5e11 + 5e11 = 1e12 over 1e14 => exactly 100 bps.
  const info = await getPoolInfo(
    POOL_ID, feeAlgod(),
    mockIndexer(feeState({ swapFee: 500000000000n, platformFee: 500000000000n })),
    nativeAsaConfig
  );
  assert.equal(info.fee, 100);
});

test('fee conversion rounds UP so the fee is never under-applied', async () => {
  // 2.003e12 / 1e14 = 200.3 bps -> must ceil to 201, never 200.
  const info = await getPoolInfo(
    POOL_ID, feeAlgod(),
    mockIndexer(feeState({ swapFee: 2003000000000n, platformFee: 0n })),
    nativeAsaConfig
  );
  assert.equal(info.fee, 201);
});

test('missing swap_fee fails explicitly (no silent default fee)', async () => {
  const state = feeState().filter(e => Buffer.from(e.key).toString() !== 'swap_fee');
  await assert.rejects(
    () => getPoolInfo(POOL_ID, feeAlgod(), mockIndexer(state), nativeAsaConfig),
    /no readable swap_fee/
  );
});

test('missing platform_fee fails explicitly (no silent default fee)', async () => {
  const state = feeState().filter(e => Buffer.from(e.key).toString() !== 'platform_fee');
  await assert.rejects(
    () => getPoolInfo(POOL_ID, feeAlgod(), mockIndexer(state), nativeAsaConfig),
    /no readable platform_fee/
  );
});
