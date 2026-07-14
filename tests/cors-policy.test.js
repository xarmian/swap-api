// TASK-26: CORS policy is now env-driven (CORS_ORIGINS, comma-separated)
// instead of the previous unconditional `cors()` (allow-all). This pins the
// documented, intentional public-API default:
//   - CORS_ORIGINS unset/empty -> origin: '*' (today's wide-open behavior,
//     preserved byte-for-byte).
//   - CORS_ORIGINS set -> ONLY the listed origins get reflected back in
//     Access-Control-Allow-Origin; anything else gets no CORS header at all
//     (browser enforces same-origin, request itself is not blocked
//     server-side — that's the `cors` package's standard behavior).
//
// index.js computes its CORS config ONCE at module-load time from
// process.env.CORS_ORIGINS, so each scenario sets the env var BEFORE a fresh
// dynamic import using a cache-busting query string — re-importing the bare
// specifier would otherwise resolve to an already-cached module instance
// carrying a DIFFERENT test's env value. process.env.VERCEL is set first so
// importing index.js never calls app.listen()/initializeConfig() itself (see
// tests/id-validation.test.js for the same pattern).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.VERCEL = '1';

let importCounter = 0;
async function importFreshIndex() {
  importCounter += 1;
  const mod = await import(`../index.js?corsTest=${importCounter}`);
  return mod.default;
}

function withCorsOrigins(value, fn) {
  const prev = process.env.CORS_ORIGINS;
  if (value === undefined) delete process.env.CORS_ORIGINS;
  else process.env.CORS_ORIGINS = value;
  return (async () => {
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.CORS_ORIGINS;
      else process.env.CORS_ORIGINS = prev;
    }
  })();
}

test('CORS_ORIGINS unset: Access-Control-Allow-Origin is "*" (preserves the pre-existing wide-open default)', async (t) => {
  const app = await withCorsOrigins(undefined, () => importFreshIndex());
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://localhost:${server.address().port}`;

  const res = await fetch(`${baseUrl}/health`, {
    headers: { Origin: 'https://totally-random-site.example' }
  });
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('CORS_ORIGINS set: an allowed origin is reflected back exactly', async (t) => {
  const allowed = 'https://app.snowballswap.example';
  const app = await withCorsOrigins(`${allowed}, https://other-allowed.example`, () => importFreshIndex());
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://localhost:${server.address().port}`;

  const res = await fetch(`${baseUrl}/health`, {
    headers: { Origin: allowed }
  });
  assert.equal(res.headers.get('access-control-allow-origin'), allowed);
});

test('CORS_ORIGINS="*" behaves as wide-open, not as a single literal origin', async (t) => {
  // A literal '*' entry must map back to origin: '*' (allow-all), NOT be
  // treated as one exact origin string that no real Origin header equals —
  // otherwise the natural "open it back up" value would silently block every
  // browser origin.
  const app = await withCorsOrigins('*', () => importFreshIndex());
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://localhost:${server.address().port}`;

  const res = await fetch(`${baseUrl}/health`, {
    headers: { Origin: 'https://anything.example' }
  });
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('CORS_ORIGINS set: an origin NOT in the allowlist gets no Access-Control-Allow-Origin header', async (t) => {
  const app = await withCorsOrigins('https://app.snowballswap.example', () => importFreshIndex());
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://localhost:${server.address().port}`;

  const res = await fetch(`${baseUrl}/health`, {
    headers: { Origin: 'https://evil.example' }
  });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  // The request itself still succeeds server-side (CORS is a browser-side
  // enforcement mechanism, not a server-side auth gate) — only the header
  // that would let a BROWSER read the response cross-origin is withheld.
  assert.equal(res.status, 200);
});
