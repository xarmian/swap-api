import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import algosdk from 'algosdk';
import {
  finalizeGroupReferences,
  assertWithinReferenceLimits,
  countReferences
} from '../lib/appRefs.js';

const suggestedParams = {
  fee: 1000, flatFee: true, firstValid: 1, lastValid: 1000,
  genesisHash: new Uint8Array(32), genesisID: 'test-net'
};

function appCall({ appIndex, foreignApps = [], accounts = 0, boxes = [] }) {
  const sender = algosdk.generateAccount().addr.toString();
  const accountAddrs = Array.from({ length: accounts }, () => algosdk.generateAccount().addr.toString());
  const txn = algosdk.makeApplicationCallTxnFromObject({
    sender,
    appIndex,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    foreignApps,
    accounts: accountAddrs,
    suggestedParams
  });
  txn.applicationCall.boxes = boxes.map(({ app, name }) => ({ appIndex: BigInt(app), name: Buffer.from(name) }));
  return txn;
}

// The unwrap rebuild adds each box's app to foreignApps without checking the called app, so a
// box that belongs to the called app lists the called app in its own foreignApps. Near the limit
// that self entry is the difference between a group the node accepts and one it refuses.
function unwrapShapedTxn() {
  return appCall({
    appIndex: 395614,
    foreignApps: [395614, 390001, 47138068, 395642],
    accounts: 1,
    boxes: [
      { app: 395614, name: 'a' }, { app: 395614, name: 'b' },
      { app: 390001, name: 'c' }, { app: 390001, name: 'd' }
    ]
  });
}

test('an unwrap-shaped group with a self box is over the limit before normalization', () => {
  const txn = unwrapShapedTxn();
  assert.equal(countReferences(txn.applicationCall), 9);
  assert.throws(() => assertWithinReferenceLimits([txn]), /395614.*9 references/);
});

test('finalizeGroupReferences drops the self entry, keeps the group within the limit and the boxes intact', () => {
  const pay = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: algosdk.generateAccount().addr.toString(),
    receiver: algosdk.generateAccount().addr.toString(),
    amount: 1,
    suggestedParams
  });
  const txn = unwrapShapedTxn();
  const boxesBefore = txn.applicationCall.boxes.map(b => `${b.appIndex}:${Buffer.from(b.name).toString('hex')}`);

  const summary = finalizeGroupReferences([pay, txn]);

  assert.deepEqual(txn.applicationCall.foreignApps, [390001n, 47138068n, 395642n]);
  assert.equal(countReferences(txn.applicationCall), 8);
  assert.deepEqual(txn.applicationCall.boxes.map(b => `${b.appIndex}:${Buffer.from(b.name).toString('hex')}`), boxesBefore);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].index, 1);
  assert.equal(summary[0].selfApp, 1);

  // Encoding then decoding keeps every box on the app it referenced, including the self boxes.
  const decoded = algosdk.decodeUnsignedTransaction(algosdk.encodeUnsignedTransaction(txn));
  assert.deepEqual(
    decoded.applicationCall.boxes.map(b => `${b.appIndex === 0n ? 395614n : b.appIndex}:${Buffer.from(b.name).toString('hex')}`),
    boxesBefore
  );
});

test('finalizeGroupReferences refuses a group that is still over the limit after normalization', () => {
  const txn = appCall({
    appIndex: 1,
    foreignApps: [2, 3, 4, 5, 6],
    accounts: 2,
    boxes: [{ app: 2, name: 'a' }, { app: 3, name: 'b' }]
  });
  assert.throws(() => finalizeGroupReferences([txn]), /9 references/);
});

test('finalizeGroupReferences passes a group that is exactly at the limit', () => {
  const txn = appCall({ appIndex: 1, foreignApps: [2, 3], accounts: 1, boxes: [{ app: 2, name: 'a' }, { app: 3, name: 'b' }, { app: 3, name: 'c' }, { app: 2, name: 'd' }, { app: 2, name: 'e' }] });
  assert.equal(countReferences(txn.applicationCall), 8);
  assert.doesNotThrow(() => finalizeGroupReferences([txn]));
});

// Wiring: deleting a call site must turn a test red. These read the source because the builders
// need the network to run.
const source = readFileSync(new URL('../lib/transactions.js', import.meta.url), 'utf8');

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing marker: ${endMarker}`);
  return source.slice(start, end);
}

test('the unwrap builder normalizes and asserts before its group reassignment and final strict verification', () => {
  const unwrap = between('async function buildBatchUnwrapTransactions', '// Aggregate fees');
  const finalize = unwrap.indexOf('finalizeGroupReferences(txns)');
  assert.notEqual(finalize, -1, 'the unwrap builder must call finalizeGroupReferences(txns)');
  const verification = unwrap.indexOf('FINAL STRICT VERIFICATION');
  assert.notEqual(verification, -1);
  const lastRegroup = unwrap.lastIndexOf('algosdk.assignGroupID(txns)', verification);
  assert.notEqual(lastRegroup, -1);
  assert.ok(finalize < lastRegroup, 'must run before the last group ID reassignment ahead of the final verification');
  assert.ok(finalize < verification, 'must run before the final strict verification');
});

test('the swap builder normalizes before strict verification and normalizes and asserts before the final encode', () => {
  const beforeVerification = between('async function buildSwapTransactions', 'VERIFICATION SIMULATION: Run a strict simulation');
  assert.ok(beforeVerification.includes('normalizeGroupReferences(allTransactions)'), 'normalize before the strict loop');
  const loop = between('const MAX_VERIFY_ITERATIONS = 8;', '// Clear and reassign group IDs');
  assert.ok(loop.includes('normalizeGroupReferences(allTransactions)'), 'normalize at the top of each verify iteration');
  const beforeEncode = between('const removedBeforeEncoding', 'FINAL: Clear and reassign group IDs right before encoding');
  assert.ok(beforeEncode.includes('assertWithinReferenceLimits(allTransactions)'), 'assert right before the final encode');
});
