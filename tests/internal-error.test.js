// Unit tests for internalError (index.js) — the shared helper that stops
// echoing raw internal error messages to clients (TASK-27). Before this
// change, several 500 responses returned `error.message`/`e.message` (or a
// `details: error.message` field) straight to the caller — an information
// disclosure risk on a money-handling API (node internals, third-party SDK
// payloads, or upstream response bodies could leak). Every internal/500
// response must instead return a GENERIC client message plus a random
// `errorId`, while the full error is logged server-side tagged with that
// same id for correlation.
//
// process.env.VERCEL is set before importing index.js so the module's
// top-level `if (!process.env.VERCEL) { initializeConfig().then(...) }`
// block is skipped — no network I/O and no app.listen() just to reach the
// pure `internalError` helper (mirrors tests/id-validation.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.VERCEL = '1';
const { internalError } = await import('../index.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Minimal fake Express `res` — just enough surface (status/json chaining) for
// internalError to call, without needing a real server or supertest.
function makeFakeRes() {
  const res = {
    statusCode: undefined,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    }
  };
  return res;
}

test('internalError returns a generic message + errorId, never the raw error.message', () => {
  const res = makeFakeRes();
  const secretMessage = 'ECONNREFUSED 10.0.0.5:443 — internal upstream host unreachable';
  const error = new Error(secretMessage);

  const originalConsoleError = console.error;
  let loggedArgs = null;
  console.error = (...args) => { loggedArgs = args; };
  try {
    internalError(res, error, 'Error generating quote');
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Internal server error');
  assert.match(res.body.errorId, UUID_RE);
  // The raw thrown text must never reach the client-visible body.
  assert.equal(JSON.stringify(res.body).includes(secretMessage), false);
  assert.equal('message' in res.body, false);
  assert.equal('details' in res.body, false);
  assert.equal('stack' in res.body, false);

  // The full error IS logged server-side, tagged with the same errorId, so
  // an incident can be correlated from the client-visible id back to the
  // detailed server log line.
  assert.ok(loggedArgs, 'console.error must be called');
  assert.match(loggedArgs[0], new RegExp(res.body.errorId));
  assert.match(loggedArgs[0], /Error generating quote/);
  assert.equal(loggedArgs[1], error);
});

test('internalError supports a custom top-level error label while still omitting the raw message', () => {
  const res = makeFakeRes();
  const error = new Error('upstream indexer said something sensitive');

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    internalError(res, error, 'Error fetching Nomadex pool info', {
      label: 'Failed to fetch pool information'
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Failed to fetch pool information');
  assert.match(res.body.errorId, UUID_RE);
  assert.equal('message' in res.body, false);
  assert.equal('details' in res.body, false);
});

test('internalError honors an explicit status code (global error handler passthrough)', () => {
  const res = makeFakeRes();
  const error = new Error('boom');

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    internalError(res, error, 'Unhandled error', { status: 503 });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'Internal server error');
  assert.match(res.body.errorId, UUID_RE);
});

test('internalError generates a fresh errorId on every call (never reused across requests)', () => {
  const res1 = makeFakeRes();
  const res2 = makeFakeRes();
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    internalError(res1, new Error('a'), 'ctx');
    internalError(res2, new Error('b'), 'ctx');
  } finally {
    console.error = originalConsoleError;
  }

  assert.notEqual(res1.body.errorId, res2.body.errorId);
});
