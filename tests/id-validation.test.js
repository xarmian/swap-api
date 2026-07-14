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

test('rejects whitespace-padded digit strings (no sanitized value is returned to forward downstream)', () => {
  // Unlike `amount` (which validates a trimmed copy AND forwards that same
  // trimmed copy downstream), isValidAssetId only returns a boolean — every
  // call site keeps using the original, unmodified string it was given. If
  // padding were tolerated here, a caller could pass validation with
  // " 12345" while the untrimmed, padded string still flows downstream to
  // handleQuote/handleUnwrap and any strict (non-Number()) comparisons
  // there, so padding must be rejected outright instead.
  assert.equal(isValidAssetId(' 12345 '), false);
  assert.equal(isValidAssetId('12345 '), false);
  assert.equal(isValidAssetId(' 12345'), false);
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

  // A missing/malformed `items` array itself (no ids to even check) must
  // also 400 before ensureConfigInitialized() network I/O, not just once it
  // reaches handleUnwrap's own downstream check.
  const unwrapNoItemsRes = await fetch(`${baseUrl}/unwrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: 'FAKEADDR' })
  });
  assert.equal(unwrapNoItemsRes.status, 400);
  const unwrapNoItemsBody = await unwrapNoItemsRes.json();
  assert.match(unwrapNoItemsBody.error, /items/);
});

test('route-level: POST /quote with no request body returns a clean 400, not a 500', async (t) => {
  // req.body is `undefined` (not `{}`) for a request with no body/non-JSON
  // content-type, since express.json() only populates it when the
  // content-type matches. Destructuring req.body directly used to throw a
  // raw TypeError here, surfacing as a 500 instead of the normal "Missing
  // required fields" 400 (adjacent defect folded in per CONVE-32).
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://localhost:${server.address().port}`;

  const noBodyRes = await fetch(`${baseUrl}/quote`, { method: 'POST' });
  assert.equal(noBodyRes.status, 400);
  const noBodyJson = await noBodyRes.json();
  assert.match(noBodyJson.error, /Missing required fields/);

  const emptyJsonRes = await fetch(`${baseUrl}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  assert.equal(emptyJsonRes.status, 400);
  const emptyJsonBody = await emptyJsonRes.json();
  assert.match(emptyJsonBody.error, /Missing required fields/);
});

// Remaining TASK-25 gaps: POST /quote's optional `address` must be validated
// with algosdk.isValidAddress ONLY when provided, and POST /unwrap's `items`
// must be capped at MAX_UNWRAP_ITEMS (8) before any per-item/network work.
test('route-level: POST /quote rejects a malformed address, but only when one is actually provided', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://localhost:${server.address().port}`;

  // A well-formed request with a garbage `address` must 400 specifically on
  // the address, before ensureConfigInitialized() network I/O.
  const badAddressRes = await fetch(`${baseUrl}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputToken: '0',
      outputToken: '1',
      amount: '1000000',
      address: 'not-a-valid-address'
    })
  });
  assert.equal(badAddressRes.status, 400);
  const badAddressBody = await badAddressRes.json();
  assert.match(badAddressBody.error, /Invalid address/);

  // Omitting `address` entirely must NOT trip the address check — the
  // request should fall through to the NEXT validation step (an invalid
  // slippageTolerance here) rather than 400 on address.
  const noAddressRes = await fetch(`${baseUrl}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputToken: '0',
      outputToken: '1',
      amount: '1000000',
      slippageTolerance: 999
    })
  });
  assert.equal(noAddressRes.status, 400);
  const noAddressBody = await noAddressRes.json();
  assert.match(noAddressBody.error, /slippageTolerance/);
  assert.doesNotMatch(noAddressBody.error, /address/);

  // An explicit empty-string `address` is a PROVIDED value, not an omission —
  // it must be rejected as invalid, not silently treated as "no address".
  const emptyAddressRes = await fetch(`${baseUrl}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputToken: '0',
      outputToken: '1',
      amount: '1000000',
      address: '',
      slippageTolerance: 999
    })
  });
  assert.equal(emptyAddressRes.status, 400);
  const emptyAddressBody = await emptyAddressRes.json();
  assert.match(emptyAddressBody.error, /Invalid address/);

  // An explicit `address: null` is a PROVIDED value, not an omission (only
  // an actually-missing key skips validation) — it must be rejected too,
  // unlike poolId's undefined/null leniency which address deliberately does
  // not copy (a caller has no legitimate reason to send an explicit null
  // address instead of just omitting the key).
  const nullAddressRes = await fetch(`${baseUrl}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputToken: '0',
      outputToken: '1',
      amount: '1000000',
      address: null,
      slippageTolerance: 999
    })
  });
  assert.equal(nullAddressRes.status, 400);
  const nullAddressBody = await nullAddressRes.json();
  assert.match(nullAddressBody.error, /Invalid address/);

  // A syntactically valid Algorand/Voi address must pass the address check
  // and fall through the same way (proving valid addresses aren't rejected).
  const validAddress = 'AHEUDLMXNBMH3Y6WH5YWREIRJLN5S7SBANXJG24UESC3GT7LEXQ53P5GGA';
  const validAddressRes = await fetch(`${baseUrl}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputToken: '0',
      outputToken: '1',
      amount: '1000000',
      address: validAddress,
      slippageTolerance: 999
    })
  });
  assert.equal(validAddressRes.status, 400);
  const validAddressBody = await validAddressRes.json();
  assert.match(validAddressBody.error, /slippageTolerance/);
});

test('route-level: POST /unwrap rejects more than MAX_UNWRAP_ITEMS items, but accepts exactly that many', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://localhost:${server.address().port}`;
  const MAX_UNWRAP_ITEMS = 8;
  const validItem = { wrappedTokenId: '123', amount: '1' };

  const tooManyRes = await fetch(`${baseUrl}/unwrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: 'FAKEADDR',
      items: Array.from({ length: MAX_UNWRAP_ITEMS + 1 }, () => validItem)
    })
  });
  assert.equal(tooManyRes.status, 400);
  const tooManyBody = await tooManyRes.json();
  assert.match(tooManyBody.error, /Too many items/);
  assert.match(tooManyBody.error, /8/);

  // Exactly MAX_UNWRAP_ITEMS must NOT be rejected as "too many" — it should
  // fall through to the next check (an invalid wrappedTokenId planted in the
  // last item) instead.
  const OVER_LIMIT = '18014398509481984'; // 2^54, well above Number.MAX_SAFE_INTEGER
  const exactlyMaxItems = Array.from({ length: MAX_UNWRAP_ITEMS }, () => validItem);
  exactlyMaxItems[MAX_UNWRAP_ITEMS - 1] = { wrappedTokenId: OVER_LIMIT, amount: '1' };
  const exactlyMaxRes = await fetch(`${baseUrl}/unwrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: 'FAKEADDR', items: exactlyMaxItems })
  });
  assert.equal(exactlyMaxRes.status, 400);
  const exactlyMaxBody = await exactlyMaxRes.json();
  assert.match(exactlyMaxBody.error, /wrappedTokenId/);
  assert.doesNotMatch(exactlyMaxBody.error, /Too many/);
});
