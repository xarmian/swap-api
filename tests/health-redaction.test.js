// TASK-60: end-to-end proof that GET /health redacts the RAW per-pool discovery
// error for public callers and exposes it only to an operator (x-operator-token
// matching OPERATOR_TOKEN). Complements operator-gate.test.js, which unit-tests
// the gate in isolation — this exercises the actual endpoint wiring
// (getDiscoveryStatus(isOperatorRequest(req)) + serialized response + cache
// headers), so the suite can't stay green if an endpoint stopped passing the
// operator flag or getDiscoveryStatus stopped honoring it.
//
// Run with: node --experimental-test-module-mocks --test tests/health-redaction.test.js
//
// VERCEL=1 stops index.js from starting its own listener / discovery pipeline on
// import; OPERATOR_TOKEN is set BEFORE import because index.js captures it into a
// module const at load. lib/config.js's getDiscoveryStatus is mocked to a
// controlled implementation that honors the includeErrors arg, so the test
// depends on no live on-chain state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const OP_TOKEN = 'test-operator-token';
const RAW_ERROR = 'ECONNREFUSED https://secret-node-provider.internal:8080/v2/status';

process.env.VERCEL = '1';
process.env.OPERATOR_TOKEN = OP_TOKEN;
delete process.env.DISCOVERY_DEBUG;

// Keep every real config.js export (index.js's module graph — handlers.js,
// transactions.js, quotes.js — imports many of them) and override ONLY
// getDiscoveryStatus so the test needs no live on-chain discovery state. The
// override injects one failed pool but delegates the actual redaction to the
// REAL projectFailedPools (not a reimplementation), so this proves the endpoint
// wiring — getDiscoveryStatus(isOperatorRequest(req)) → serialized response →
// cache headers — carries the real redaction through. The redaction rule itself
// is unit-tested in discovery-redaction.test.js.
const realConfig = await import('../lib/config.js');
const FAILED_ENTRY = [9999, { attempts: 3, lastAttempt: 1_700_000_000_000, error: RAW_ERROR }];
mock.module('../lib/config.js', {
  namedExports: {
    ...realConfig,
    getDiscoveryStatus: (includeErrors = false) => ({
      initialized: true,
      totalPools: 2,
      lastDiscoveryAt: null,
      failedPools: realConfig.projectFailedPools([FAILED_ENTRY], includeErrors)
    })
  }
});

const { default: app } = await import('../index.js');

// Boot the app on an ephemeral port for the duration of the tests.
let baseUrl;
let server;
test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

test('public /health: reports the failed pool + degraded status but NOT the raw error', async () => {
  const res = await fetch(`${baseUrl}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'degraded');                 // operator-visibility signal kept
  assert.equal(body.discovery.failedPools[0].poolId, 9999);
  assert.equal(body.discovery.failedPools[0].attempts, 3);
  assert.equal('error' in body.discovery.failedPools[0], false, 'raw error must be redacted publicly');
  assert.equal(JSON.stringify(body).includes(RAW_ERROR), false);
  // Must not be cached by URL and replayed to an operator/anon mismatch.
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('vary'), 'x-operator-token');
});

test('operator /health: matching x-operator-token gets the raw error', async () => {
  const res = await fetch(`${baseUrl}/health`, { headers: { 'x-operator-token': OP_TOKEN } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.discovery.failedPools[0].error, RAW_ERROR);
});

test('wrong x-operator-token is treated as public (redacted)', async () => {
  const res = await fetch(`${baseUrl}/health`, { headers: { 'x-operator-token': 'wrong-token' } });
  const body = await res.json();
  assert.equal('error' in body.discovery.failedPools[0], false);
});
