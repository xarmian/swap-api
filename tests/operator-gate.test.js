// TASK-60: GET /health and GET /config/pools redact the RAW per-pool discovery
// error (which can leak node-provider internals) from public callers, exposing
// it only to an operator. isOperatorRequest is the gate that decides "operator".
// These tests exercise it directly (env-derived thresholds are injected, so no
// app boot is needed). Run with: node --test tests/operator-gate.test.js
//
// VERCEL is set before importing index.js so the module doesn't start its own
// HTTP listener / on-chain discovery pipeline on import (index.js only listens
// when VERCEL is unset) — the import here is purely to reach the exported gate.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.VERCEL = '1';
const { isOperatorRequest } = await import('../index.js');

// Minimal express-req stand-in: only .get(headerName) is used by the gate.
function reqWithToken(token) {
  return { get: (name) => (name === 'x-operator-token' && token != null ? token : undefined) };
}

test('no OPERATOR_TOKEN configured: never an operator, even with a header present', () => {
  assert.equal(
    isOperatorRequest(reqWithToken('anything'), { operatorToken: '', discoveryDebug: false }),
    false
  );
});

test('matching token: is an operator', () => {
  assert.equal(
    isOperatorRequest(reqWithToken('s3cret'), { operatorToken: 's3cret', discoveryDebug: false }),
    true
  );
});

test('wrong token: not an operator', () => {
  assert.equal(
    isOperatorRequest(reqWithToken('nope'), { operatorToken: 's3cret', discoveryDebug: false }),
    false
  );
});

test('token of a different length: not an operator (no crash on unequal-length compare)', () => {
  assert.equal(
    isOperatorRequest(reqWithToken('s3'), { operatorToken: 's3cret', discoveryDebug: false }),
    false
  );
});

test('missing header when a token IS configured: not an operator', () => {
  assert.equal(
    isOperatorRequest(reqWithToken(null), { operatorToken: 's3cret', discoveryDebug: false }),
    false
  );
});

test('DISCOVERY_DEBUG=true: operator regardless of token/header', () => {
  assert.equal(
    isOperatorRequest(reqWithToken(null), { operatorToken: '', discoveryDebug: true }),
    true
  );
});
