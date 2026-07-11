// Unit tests for isValidAssetId (index.js) — the API-boundary guard for
// inputToken/outputToken/poolId/wrappedTokenId (TASK-45).
// Run with: node --test tests/id-validation.test.js
//
// Ids are converted via Number() throughout lib/, which would silently round
// an id above Number.MAX_SAFE_INTEGER (2^53-1) to a DIFFERENT integer,
// potentially routing/quoting the wrong asset. Rather than migrate internal
// id handling to BigInt/string (rejected as too large a change for no
// realistic benefit at current Algorand/Voi id ranges), out-of-range ids are
// rejected with a 400 at the API boundary instead. These tests pin that the
// boundary is drawn exactly at 2^53-1 and that out-of-range/malformed values
// are REJECTED, never coerced or clamped to a plausible-but-wrong id
// (CONVE-35).
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

test('accepts 0 and small positive integer ids (string or number)', () => {
  assert.equal(isValidAssetId(0), true);
  assert.equal(isValidAssetId('0'), true);
  assert.equal(isValidAssetId(12345), true);
  assert.equal(isValidAssetId('12345'), true);
});

test('accepts exactly Number.MAX_SAFE_INTEGER (2^53-1)', () => {
  assert.equal(isValidAssetId(Number.MAX_SAFE_INTEGER), true);
  assert.equal(isValidAssetId(String(Number.MAX_SAFE_INTEGER)), true);
  assert.equal(isValidAssetId('9007199254740991'), true);
});

test('rejects any id above Number.MAX_SAFE_INTEGER, even as a digit string', () => {
  // A JS number literal above 2^53 would already be rounded before this
  // function runs, so the meaningful case is a numeric STRING (as amount
  // validation requires for exactly this reason) one above the boundary.
  assert.equal(isValidAssetId('9007199254740992'), false);
  // Comfortably out of range (e.g. a corrupted/overflowed id).
  assert.equal(isValidAssetId('18014398509481984'), false); // 2^54
});

test('rejects negative, fractional, and non-numeric ids (reject, never coerce)', () => {
  assert.equal(isValidAssetId(-1), false);
  assert.equal(isValidAssetId('-1'), false);
  assert.equal(isValidAssetId(1.5), false);
  assert.equal(isValidAssetId('1.5'), false);
  assert.equal(isValidAssetId('abc'), false);
  assert.equal(isValidAssetId('1e21'), false);
  assert.equal(isValidAssetId(''), false);
  assert.equal(isValidAssetId(' '), false);
});

test('rejects null, undefined, objects, and arrays', () => {
  assert.equal(isValidAssetId(null), false);
  assert.equal(isValidAssetId(undefined), false);
  assert.equal(isValidAssetId({}), false);
  assert.equal(isValidAssetId([]), false);
  assert.equal(isValidAssetId([12345]), false);
});

test('tolerates surrounding whitespace like the existing amount validation does', () => {
  assert.equal(isValidAssetId(' 12345 '), true);
});

test('rejects a fractional JSON number id outright (does not silently truncate)', () => {
  assert.equal(isValidAssetId(12345.6), false);
  assert.equal(isValidAssetId(0.5), false);
});

test('a raw JSON wire number that rounds near the safe-integer boundary never becomes a DIFFERENT, wrong, in-range id', () => {
  // Parses the actual wire TEXT (a JSON body an attacker/buggy client could
  // send), exactly as express.json() would, rather than a JS-computed float
  // — a JS-side computation like `MAX_SAFE_INTEGER + 0.4` is itself already
  // rounded by the JS engine and would not faithfully represent what
  // JSON.parse does with a raw request body, so this deliberately goes
  // through JSON.parse(rawLexemeString) end to end.
  //
  // This pins that a numeric id above Number.MAX_SAFE_INTEGER can only ever
  // round to itself-or-higher, NEVER down into a smaller, different in-range
  // id: doubles have ULP=1 up to and including Number.MAX_SAFE_INTEGER, then
  // jump to ULP=2 starting at Number.MAX_SAFE_INTEGER + 1 (=2^53). So the
  // wrong-asset-routing risk TASK-45 exists to prevent (an out-of-range id
  // silently becoming a DIFFERENT valid-looking id) cannot occur via JSON
  // number rounding — the only residual effect is a fractional wire literal
  // within [MAX_SAFE_INTEGER, MAX_SAFE_INTEGER + 0.5) collapsing to exactly
  // Number.MAX_SAFE_INTEGER itself (a real, valid id — not a distinct wrong
  // one), which is accepted; anything at or past the rounding midpoint
  // becomes Number.MAX_SAFE_INTEGER + 1 or higher and is correctly rejected.
  const MSI = Number.MAX_SAFE_INTEGER; // 9007199254740991

  const collapsesToBoundary = JSON.parse('{"id": 9007199254740991.1}').id;
  assert.equal(collapsesToBoundary, MSI);
  assert.equal(isValidAssetId(collapsesToBoundary), true);

  const roundsUpAndRejected = JSON.parse('{"id": 9007199254740991.6}').id;
  assert.equal(roundsUpAndRejected, MSI + 1);
  assert.equal(isValidAssetId(roundsUpAndRejected), false);

  // A wire literal far past the boundary always rounds to something >= MSI+1,
  // never back down into the safe range as a smaller, different id.
  const wayOutOfRange = JSON.parse('{"id": 9007199254741999.7}').id;
  assert.ok(wayOutOfRange > MSI);
  assert.equal(isValidAssetId(wayOutOfRange), false);
});

// Route-level regression coverage: prove the boundary actually rejects with a
// JSON 400 on the real Express app, not just the pure helper above. Uses the
// exported `app` (default export) with Node's built-in http server/fetch —
// no supertest or other new dependency. Every case here uses an out-of-range
// id, which each route rejects BEFORE ensureConfigInitialized(), so no
// network calls happen and this stays as cheap/offline as the tests above.
test('route-level: out-of-range ids are rejected with 400 on the real routes', async (t) => {
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
});
