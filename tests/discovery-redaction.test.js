// TASK-60: unit test of the REAL redaction logic in lib/config.js — the pure
// projectFailedPools projection that getDiscoveryStatus() delegates to. This
// exercises the actual code path (not a stand-in), so a regression that started
// leaking the raw `error` publicly — or that stopped surfacing it to operators —
// fails here. Importing lib/config.js has no boot side effects (it's a lib).
// Run with: node --test tests/discovery-redaction.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectFailedPools } from '../lib/config.js';

const RAW_ERROR = 'ECONNREFUSED https://secret-node-provider.internal:8080/v2/status';
const entries = [
  [9999, { attempts: 3, lastAttempt: 1_700_000_000_000, error: RAW_ERROR }]
];

test('includeErrors=false (public): keeps poolId/attempts/lastAttempt, drops raw error', () => {
  const [p] = projectFailedPools(entries, false);
  assert.equal(p.poolId, 9999);
  assert.equal(p.attempts, 3);
  assert.equal(p.lastAttempt, new Date(1_700_000_000_000).toISOString());
  assert.equal('error' in p, false, 'raw error must be absent for public callers');
});

test('default arg (no includeErrors) redacts, matching getDiscoveryStatus() default', () => {
  const [p] = projectFailedPools(entries);
  assert.equal('error' in p, false);
});

test('includeErrors=true (operator): includes the raw error verbatim', () => {
  const [p] = projectFailedPools(entries, true);
  assert.equal(p.error, RAW_ERROR);
});

test('empty failed-pool set: empty projection regardless of includeErrors', () => {
  assert.deepEqual(projectFailedPools([], false), []);
  assert.deepEqual(projectFailedPools([], true), []);
});
