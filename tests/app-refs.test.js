import test from 'node:test';
import assert from 'node:assert/strict';
import algosdk from 'algosdk';
import {
  MAX_APP_TOTAL_TXN_REFERENCES, MAX_APP_TXN_ACCOUNTS,
  refKey, includesRef, addRefOnce, dedupeRefs, dedupeAppCallReferences,
  countReferences, normalizeGroupReferences, assertWithinReferenceLimits,
  addBoxAppsToForeignApps
} from '../lib/appRefs.js';

const sender = algosdk.generateAccount().addr;
const suggestedParams = {
  fee: 1000, flatFee: true, firstValid: 1, lastValid: 1000,
  genesisHash: new Uint8Array(32)
};
const boxesFor = ids => ids.map((appIndex, i) => ({ appIndex, name: new Uint8Array([i + 1]) }));
const makeCall = (foreignApps, boxes) => algosdk.makeApplicationCallTxnFromObject({
  sender, appIndex: 390001, onComplete: algosdk.OnApplicationComplete.NoOpOC,
  accounts: [algosdk.generateAccount().addr], foreignApps, boxes, suggestedParams
});
const resolvedBoxes = call => call.boxes.map(box => ({
  appIndex: box.appIndex === 0n ? call.appIndex : box.appIndex,
  name: box.name
}));

test('Dave group is refused at 10 references and normalized to 7 without changing boxes', () => {
  const txn = makeCall([395614, 390001, 395614, 390001], boxesFor([395614, 395614, 390001, 395614, 395614]));
  const before = resolvedBoxes(txn.applicationCall);
  assert.equal(countReferences(txn.applicationCall), 10);
  assert.throws(() => assertWithinReferenceLimits([txn]), /txn 0 \(app 390001\) has 10 references/);
  assert.deepEqual(normalizeGroupReferences([txn]), [{ index: 0, apps: 2, assets: 0, accounts: 0, selfApp: 1 }]);
  assert.deepEqual(txn.applicationCall.foreignApps, [395614n]);
  assert.equal(countReferences(txn.applicationCall), 7);
  assert.doesNotThrow(() => assertWithinReferenceLimits([txn]));
  const decoded = algosdk.decodeUnsignedTransaction(algosdk.encodeUnsignedTransaction(txn));
  assert.deepEqual(resolvedBoxes(decoded.applicationCall), before);
});

test('foreign app deduplication preserves first occurrence order and encoded box targets', () => {
  const txn = makeCall([100, 200, 100, 300, 200], boxesFor([100, 200, 300]));
  const before = resolvedBoxes(txn.applicationCall);
  normalizeGroupReferences([txn]);
  assert.deepEqual(txn.applicationCall.foreignApps, [100n, 200n, 300n]);
  const decoded = algosdk.decodeUnsignedTransaction(algosdk.encodeUnsignedTransaction(txn));
  assert.deepEqual(resolvedBoxes(decoded.applicationCall), before);
});

test('reference helpers compare numeric types and preserve original entries', () => {
  assert.equal(MAX_APP_TOTAL_TXN_REFERENCES, 8);
  assert.equal(MAX_APP_TXN_ACCOUNTS, 4);
  for (const value of [42, 42n, '042']) {
    assert.equal(refKey(value), '42');
    assert.equal(includesRef([42n], value), true);
    const refs = [42n];
    assert.equal(addRefOnce(refs, value), refs);
    assert.deepEqual(refs, [42n]);
  }
  assert.equal(includesRef(undefined, 42), false);
  assert.deepEqual(addRefOnce(undefined, 42), [42]);
  assert.deepEqual(addRefOnce(null, 42n), [42n]);
  const refs = [42, '7', 42n, 8n, 7];
  const unique = dedupeRefs(refs);
  assert.deepEqual(unique, [42, '7', 8n]);
  assert.notEqual(unique, refs);
  assert.equal(refs.length, 5);
  assert.deepEqual(dedupeRefs(undefined), []);
});

test('account helpers compare Address objects and strings', () => {
  assert.equal(refKey(sender, 'account'), sender.toString());
  assert.equal(includesRef([sender], sender.toString(), 'account'), true);
  const refs = [sender];
  assert.equal(addRefOnce(refs, sender.toString(), 'account'), refs);
  assert.deepEqual(refs, [sender]);
  assert.deepEqual(dedupeRefs([sender, sender.toString()], 'account'), [sender]);
});

test('app call normalization reports removals, replaces arrays and never touches boxes', () => {
  const boxes = boxesFor([10, 10]);
  const foreignApps = [20n, 10, '20', 30, 10n];
  const foreignAssets = [2, 2n, '3'];
  const accounts = [sender, sender.toString()];
  const call = { appIndex: 10n, foreignApps, foreignAssets, accounts, boxes };
  assert.deepEqual(dedupeAppCallReferences(call), { apps: 2, assets: 1, accounts: 1, selfApp: 1 });
  assert.deepEqual(call.foreignApps, [20n, 30]);
  assert.deepEqual(call.foreignAssets, [2, '3']);
  assert.deepEqual(call.accounts, [sender]);
  for (const [key, original] of Object.entries({ foreignApps, foreignAssets, accounts })) {
    assert.notEqual(call[key], original);
  }
  assert.equal(call.boxes, boxes);
  assert.equal(boxes.length, 2);
  assert.deepEqual(dedupeAppCallReferences(call), { apps: 0, assets: 0, accounts: 0, selfApp: 0 });
  assert.equal(countReferences({}), 0);
});

test('box app rebuild preserves array identity and adds BigInt ids only once', () => {
  const apps = [395614n, 390001n];
  assert.equal(addBoxAppsToForeignApps(apps, boxesFor([395614, 390001])), apps);
  assert.deepEqual(apps, [395614n, 390001n]);
  addBoxAppsToForeignApps(apps, boxesFor([777, 777]));
  assert.deepEqual(apps, [395614n, 390001n, 777n]);
});

test('group normalization skips payments, supports flat calls and reports only changes', () => {
  const pay = { type: 'pay', foreignApps: [1, 1n] };
  const before = structuredClone(pay);
  const group = [pay,
    { type: 'appl', applicationCall: { appIndex: 10, foreignApps: [2, 2n] } },
    { type: 'appl', appIndex: 20, foreignAssets: [3n, '3'] }
  ];
  assert.deepEqual(normalizeGroupReferences(group), [
    { index: 1, apps: 1, assets: 0, accounts: 0, selfApp: 0 },
    { index: 2, apps: 0, assets: 1, accounts: 0, selfApp: 0 }
  ]);
  assert.deepEqual(pay, before);
  assert.deepEqual(normalizeGroupReferences(group), []);
});

test('reference limits reject nine references and five accounts but allow exactly eight', () => {
  const call = { appIndex: 390001, accounts: [sender], foreignApps: [100, 200], boxes: boxesFor([100, 100, 100, 200, 200, 200]) };
  const group = [{ type: 'pay' }, { type: 'appl', applicationCall: call }];
  assert.throws(() => assertWithinReferenceLimits(group), /txn 1 \(app 390001\) has 9 references \(apps 2, assets 0, accounts 1, boxes 6\)/);
  call.boxes.pop();
  assert.doesNotThrow(() => assertWithinReferenceLimits(group));
  assert.throws(() => assertWithinReferenceLimits([{ type: 'appl', appIndex: 123, accounts: Array.from({ length: 5 }, () => algosdk.generateAccount().addr) }]), /app 123.*accounts 5/);
  for (const key of ['foreignApps', 'foreignAssets']) {
    assert.throws(() => assertWithinReferenceLimits([{ type: 'appl', appIndex: 123, [key]: Array.from({ length: 9 }, (_, i) => i + 1) }]), /has 9 references/);
  }
});
