// TASK-26: best-effort per-IP rate limiting (express-rate-limit, in-memory
// MemoryStore — explicitly best-effort on serverless, see index.js). This is
// NOT the primary DoS lever (that's MAX_ROUTE_COMBINATIONS) so this suite
// only proves the limiter is actually wired onto /quote and /unwrap and
// honors its env knobs, rather than trying to pin exact serverless behavior.
//
// index.js reads RATE_LIMIT_WINDOW_MS/RATE_LIMIT_MAX ONCE at module-load
// time, so each scenario sets env vars BEFORE a fresh dynamic import using a
// cache-busting query string (same pattern as tests/cors-policy.test.js).
// All requests below use a malformed/empty body, which every route rejects
// with a 400 BEFORE any network I/O (ensureConfigInitialized) — the limiter
// middleware itself runs even earlier, ahead of that validation, so it still
// counts and can still 429 these requests without any real quote/unwrap work.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.VERCEL = '1';

let importCounter = 0;
async function importFreshIndex() {
  importCounter += 1;
  const mod = await import(`../index.js?rateLimitTest=${importCounter}`);
  return mod.default;
}

function withEnv(vars, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return (async () => {
    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  })();
}

test('rate limiter is wired onto /quote and /unwrap: default config does not throw and exposes standard RateLimit headers', async (t) => {
  const app = await withEnv({ RATE_LIMIT_WINDOW_MS: undefined, RATE_LIMIT_MAX: undefined }, () => importFreshIndex());
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://localhost:${server.address().port}`;

  const quoteRes = await fetch(`${baseUrl}/quote`, { method: 'POST' });
  assert.equal(quoteRes.status, 400); // missing fields, but not a 500/throw
  assert.equal(quoteRes.headers.get('ratelimit-limit'), '60', 'default RATE_LIMIT_MAX is 60');

  const unwrapRes = await fetch(`${baseUrl}/unwrap`, { method: 'POST' });
  assert.equal(unwrapRes.status, 400);
  assert.equal(unwrapRes.headers.get('ratelimit-limit'), '60', 'limiter is also wired onto /unwrap');

  // A route outside the limiter's path list is unaffected (no RateLimit header).
  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.headers.get('ratelimit-limit'), null);
});

test('rate limiter honors RATE_LIMIT_MAX/RATE_LIMIT_WINDOW_MS and returns 429 once the cap is exceeded', async (t) => {
  const app = await withEnv({ RATE_LIMIT_WINDOW_MS: '60000', RATE_LIMIT_MAX: '2' }, () => importFreshIndex());
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://localhost:${server.address().port}`;

  const first = await fetch(`${baseUrl}/quote`, { method: 'POST' });
  assert.equal(first.status, 400); // under the cap: normal validation 400
  const second = await fetch(`${baseUrl}/quote`, { method: 'POST' });
  assert.equal(second.status, 400);
  const third = await fetch(`${baseUrl}/quote`, { method: 'POST' });
  assert.equal(third.status, 429, 'the 3rd request within the window exceeds RATE_LIMIT_MAX=2');
});

test('an invalid RATE_LIMIT_MAX/RATE_LIMIT_WINDOW_MS falls back to the documented defaults rather than disabling the limiter', async (t) => {
  const app = await withEnv({ RATE_LIMIT_WINDOW_MS: 'garbage', RATE_LIMIT_MAX: '-1' }, () => importFreshIndex());
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://localhost:${server.address().port}`;

  const res = await fetch(`${baseUrl}/quote`, { method: 'POST' });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('ratelimit-limit'), '60', 'garbage RATE_LIMIT_MAX falls back to the default of 60, not 0/unbounded');
});
