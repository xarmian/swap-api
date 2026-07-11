// Unit tests for isValidAssetId (index.js) — the API-boundary guard for
// inputToken/outputToken/poolId/wrappedTokenId (TASK-45).
// Run with: node --test tests/id-validation.test.js
//
// Ids are converted via Number() throughout lib/, which would silently round
// an id above Number.MAX_SAFE_INTEGER (2^53-1) to a DIFFERENT integer,
// potentially routing/quoting the wrong asset. Rather than migrate internal
// id handling to BigInt/string (rejected as too large a change for no
// realistic benefit at current Algorand/Voi id ranges), out-of-range ids are
// rejected with a 400 at the API boundary instead. isValidAssetId only
// accepts a digit STRING (like `amount`, and like poolId's existing
// contract) — a bare JSON `number` is rejected outright, because
// express.json() already rounds a numeric wire literal via JSON.parse before
// this function ever sees it, so a malformed/fractional id near the boundary
// (e.g. wire text `9007199254740991.1`) would otherwise arrive pre-collapsed
// into a clean-looking integer with no way to detect it was malformed. These
// tests pin that the boundary is drawn exactly at 2^53-1 and that
// out-of-range/malformed/wrong-typed values are REJECTED, never coerced or
// clamped to a plausible-but-wrong id (CONVE-35).
//
// process.env.VERCEL is set before importing index.js so the module's
// top-level `if (!process.env.VERCEL) { initializeConfig().then(...) }`
// block is skipped: no network I/O and no app.listen() from just importing
// the module to reach the pure isValidAssetId helper. node --test runs each
// test file in its own process, so this does not leak into other test files.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.VERCEL = '1';
const indexModule = await import('../index.js');
const { isValidAssetId } = indexModule;
const app = indexModule.default;

test('accepts 0 and small positive integer ids as digit strings', () => {
  assert.equal(isValidAssetId('0'), true);
  assert.equal(isValidAssetId('12345'), true);
});

test('accepts exactly Number.MAX_SAFE_INTEGER (2^53-1) as a digit string', () => {
  assert.equal(isValidAssetId(String(Number.MAX_SAFE_INTEGER)), true);
  assert.equal(isValidAssetId('9007199254740991'), true);
});

test('rejects any digit string above Number.MAX_SAFE_INTEGER', () => {
  assert.equal(isValidAssetId('9007199254740992'), false);
  // Comfortably out of range (e.g. a corrupted/overflowed id).
  assert.equal(isValidAssetId('18014398509481984'), false); // 2^54
});

test('rejects negative, fractional, and non-numeric digit strings (reject, never coerce)', () => {
  assert.equal(isValidAssetId('-1'), false);
  assert.equal(isValidAssetId('1.5'), false);
  assert.equal(isValidAssetId('abc'), false);
  assert.equal(isValidAssetId('1e21'), false);
  assert.equal(isValidAssetId(''), false);
  assert.equal(isValidAssetId(' '), false);
});

test('rejects a bare JSON number outright, even a perfectly valid in-range integer value', () => {
  // This is the whole point of requiring a STRING: a JS `number` has already
  // been through IEEE-754 rounding by the time isValidAssetId sees it, so it
  // is never trusted here regardless of its value — see the module-level
  // doc comment in index.js and the wire-level test below for why.
  assert.equal(isValidAssetId(0), false);
  assert.equal(isValidAssetId(12345), false);
  assert.equal(isValidAssetId(Number.MAX_SAFE_INTEGER), false);
  assert.equal(isValidAssetId(12345.6), false);
});

test('rejects null, undefined, objects, and arrays', () => {
  assert.equal(isValidAssetId(null), false);
  assert.equal(isValidAssetId(undefined), false);
  assert.equal(isValidAssetId({}), false);
  assert.equal(isValidAssetId([]), false);
  assert.equal(isValidAssetId(['12345']), false);
});

test('tolerates surrounding whitespace like the existing amount validation does', () => {
  assert.equal(isValidAssetId(' 12345 '), true);
});

test('a raw JSON wire number near the safe-integer boundary can never become a DIFFERENT, wrong, in-range id (why number is rejected outright, not just range-checked)', () => {
  // Demonstrates the exact failure mode requiring string-only ids closes.
  // Parses the actual wire TEXT (what a buggy/malicious client could send),
  // exactly as express.json() would.
  //
  // IEEE-754 doubles have ULP=1 up to and including Number.MAX_SAFE_INTEGER,
  // then jump to ULP=2 starting at Number.MAX_SAFE_INTEGER + 1 (=2^53). So a
  // wire number strictly greater than Number.MAX_SAFE_INTEGER can only round
  // to itself-or-higher — NEVER down into a smaller, different in-range id
  // (the actual wrong-asset-routing risk TASK-45 exists to prevent). The
  // only rounding "loss" possible is a fractional literal within 0.5 of the
  // boundary collapsing to exactly Number.MAX_SAFE_INTEGER itself (a real,
  // valid id, not a distinct wrong one) — but since isValidAssetId now
  // rejects the `number` type unconditionally, none of this ever reaches the
  // range check in the first place; a caller MUST send the id as a string.
  const MSI = Number.MAX_SAFE_INTEGER; // 9007199254740991

  const collapsesToBoundary = JSON.parse('{"id": 9007199254740991.1}').id;
  assert.equal(collapsesToBoundary, MSI);
  assert.equal(isValidAssetId(collapsesToBoundary), false); // number type: rejected outright

  const wayOutOfRange = JSON.parse('{"id": 9007199254741999.7}').id;
  assert.ok(wayOutOfRange > MSI);
  assert.equal(isValidAssetId(wayOutOfRange), false);
});

// Route-level regression coverage: prove the boundary actually rejects with a
// JSON 400 on the real Express app, not just the pure helper above. Uses the
// exported `app` (default export) with Node's built-in http server/fetch —
// no supertest or other new dependency. Every case here uses an out-of-range,
// missing, or wrongly-typed id, which each route rejects BEFORE
// ensureConfigInitialized(), so no network calls happen and this stays as
// cheap/offline as the tests above.
test('route-level: out-of-range/malformed ids are rejected with 400 on the real routes', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://localhost:${server.address().port}`;
  const OVER_LIMIT = '18014398509481984'; // 2^54, well above Number.MAX_SAFE_INTEGER

  const quoteRes = await fetch(`${baseUrl}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputToken: OVER_LIMIT, outputToken: '0', amount: '1000000' })
  });
  assert.equal(quoteRes.status, 400);
  const quoteBody = await quoteRes.json();
  assert.match(quoteBody.error, /inputToken\/outputToken/);

  // A VALID inputToken with an over-limit outputToken must also 400 — proves
  // the outputToken guard isn't just dead code shadowed by the inputToken
  // check above (both operands of `!isValidAssetId(a) || !isValidAssetId(b)`
  // are exercised).
  const quoteOutputRes = await fetch(`${baseUrl}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputToken: '0', outputToken: OVER_LIMIT, amount: '1000000' })
  });
  assert.equal(quoteOutputRes.status, 400);
  const quoteOutputBody = await quoteOutputRes.json();
  assert.match(quoteOutputBody.error, /inputToken\/outputToken/);

  // A bare JSON number for inputToken/outputToken (previously accepted) must
  // now also 400 — the wire contract requires digit strings.
  const quoteNumberRes = await fetch(`${baseUrl}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputToken: 0, outputToken: 1, amount: '1000000' })
  });
  assert.equal(quoteNumberRes.status, 400);
  const quoteNumberBody = await quoteNumberRes.json();
  assert.match(quoteNumberBody.error, /inputToken\/outputToken/);

  const quotePoolIdRes = await fetch(`${baseUrl}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputToken: '0', outputToken: '1', amount: '1000000', poolId: OVER_LIMIT })
  });
  assert.equal(quotePoolIdRes.status, 400);
  const quotePoolIdBody = await quotePoolIdRes.json();
  assert.match(quotePoolIdBody.error, /poolId/);

  const poolRes = await fetch(`${baseUrl}/pool/${OVER_LIMIT}`);
  assert.equal(poolRes.status, 400);
  const poolBody = await poolRes.json();
  assert.match(poolBody.error, /poolId/);

  const unwrapRes = await fetch(`${baseUrl}/unwrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: 'FAKEADDR', items: [{ wrappedTokenId: OVER_LIMIT, amount: '1' }] })
  });
  assert.equal(unwrapRes.status, 400);
  const unwrapBody = await unwrapRes.json();
  assert.match(unwrapBody.error, /wrappedTokenId/);

  // A missing wrappedTokenId per item must also 400 fast, before
  // ensureConfigInitialized() network I/O — not fall through to a 500 from
  // handleUnwrap's downstream shape check (the folded-in P2 fix).
  const unwrapMissingIdRes = await fetch(`${baseUrl}/unwrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: 'FAKEADDR', items: [{ amount: '1' }] })
  });
  assert.equal(unwrapMissingIdRes.status, 400);
  const unwrapMissingIdBody = await unwrapMissingIdRes.json();
  assert.match(unwrapMissingIdBody.error, /wrappedTokenId/);
});
