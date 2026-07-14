import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import algosdk from 'algosdk';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { handleQuote, handleUnwrap, withDiscoveryWarning } from './lib/handlers.js';
import { getPoolConfigById, loadConfigsOnce, poolsConfig, initializeConfig, getDiscoveryStatus } from './lib/config.js';
import { getAllTokens } from './lib/discovery.js';
import { algodClient, indexerClient } from './lib/clients.js';
import {
  getPoolInfo as getNomadexPoolInfo
} from './lib/nomadex.js';
import {
  getPoolInfo200 as getHumbleswapPoolInfo200
} from './lib/humbleswap.js';
import { getPlatformFeeConfig } from './lib/quotes.js';
import { MAX_UNWRAP_GROUP_SIZE } from './lib/transactions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Validate the platform fee config EAGERLY at module init — before the server
// listens and independent of the on-chain discovery pipeline (TASK-57).
// getPlatformFeeConfig() throws on an invalid PLATFORM_FEE_BPS
// (fractional/non-numeric/negative/>10000, PR #32/#34) but otherwise only runs
// LAZILY on the first multi-pool quote, so a broken fee config would boot and
// fail only later. This bare module-scope call runs on import, covering BOTH
// `node index.js` (uncaught throw → clear error, non-zero exit) and the Vercel
// serverless import (the throw fails the cold start). It's a pure env read (no
// network I/O), so it never triggers initializeConfig()/discovery. The lazy
// check inside getPlatformFeeConfig stays unchanged as defense-in-depth.
getPlatformFeeConfig();

const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS policy (TASK-26) ---
//
// This is a public, unauthenticated quote/unwrap API with no session cookies
// or API keys, so a wide-open CORS default is an intentional public-API
// choice, not an oversight — preserves the pre-existing `cors()` (allow-all)
// behavior. CORS_ORIGINS (comma-separated) lets that be locked down to a
// specific origin list purely via env, without a code change/deploy. No
// `credentials: true` is set, so an allowed origin is only ever REFLECTED for
// simple/anonymous CORS — a wildcard can never be paired with credentials.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Unset/empty OR an explicit '*' entry both mean wide-open. Treating a literal
// '*' in the list as allow-all (rather than as one exact origin string that
// no real Origin header would ever equal) makes the natural
// CORS_ORIGINS=* config preserve the default-open behavior instead of
// silently blocking every browser origin.
const corsOptions = (CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes('*'))
  ? { origin: '*' }
  : {
      // Reflects the request Origin only when it's in the configured
      // allowlist; a request with no Origin header (curl, server-to-server)
      // has no browser same-origin policy to enforce and is allowed through.
      origin(origin, callback) {
        if (!origin || CORS_ORIGINS.includes(origin)) {
          return callback(null, true);
        }
        return callback(null, false);
      }
    };

// Vercel puts the real client IP in X-Forwarded-For, added by exactly one
// hop (Vercel's own edge) in front of the serverless function. Trusting only
// that one hop (not `true`/the whole chain) means req.ip - and therefore the
// per-IP rate limiter's key below - resolves to the real client IP, while a
// client can't evade the limiter by appending its own fake XFF entries.
app.set('trust proxy', 1);

// --- Best-effort per-IP rate limiting (TASK-26) ---
//
// BEST-EFFORT ONLY on serverless: this uses express-rate-limit's default
// in-memory MemoryStore, which is per-instance. Vercel cold-starts multiple
// concurrent instances that each get their own counters (not shared, and
// reset on every cold start), so this does NOT enforce a global per-IP cap -
// it only raises the cost of abuse hitting a single warm instance. The
// primary DoS lever is the route-combination fan-out cap
// (MAX_ROUTE_COMBINATIONS, lib/config.js), which bounds the work ONE request
// can do regardless of how many requests get through. A robust
// cross-instance limiter (Vercel WAF / an Upstash-backed store) was
// considered and deliberately deferred — it needs new infra/credentials,
// which this task avoids (human decision, TASK-26). Documented limitation,
// not a silent shim (CONVE-33).
// Both knobs validate to an INTEGER within an operationally MEANINGFUL range
// and fall back to the documented default otherwise (never silently
// neutralize the limiter, in either direction):
//   - windowMs must be in [1000, 2^31-1]. Below ~1s the window resets faster
//     than any realistic burst, making the limit useless; above Node's max
//     timer delay (2^31-1) it overflows setTimeout and fires immediately.
//   - limit must be in [1, 1_000_000]. A finite ceiling so an absurd but
//     "valid safe integer" value (e.g. 9007199254740991) can't effectively
//     disable the cap; the floor rejects 0/negative.
const MIN_RATE_LIMIT_WINDOW_MS = 1000;           // 1s — smaller windows are meaningless
const MAX_RATE_LIMIT_WINDOW_MS = 2_147_483_647;  // 2^31 - 1, Node's setTimeout ceiling
const MAX_RATE_LIMIT_MAX = 1_000_000;            // generous but finite request ceiling
const RATE_LIMIT_WINDOW_MS = (() => {
  const fromEnv = Number(process.env.RATE_LIMIT_WINDOW_MS);
  return Number.isInteger(fromEnv) && fromEnv >= MIN_RATE_LIMIT_WINDOW_MS && fromEnv <= MAX_RATE_LIMIT_WINDOW_MS
    ? fromEnv
    : 60 * 1000; // 1 minute
})();
const RATE_LIMIT_MAX = (() => {
  const fromEnv = Number(process.env.RATE_LIMIT_MAX);
  return Number.isInteger(fromEnv) && fromEnv >= 1 && fromEnv <= MAX_RATE_LIMIT_MAX
    ? fromEnv
    : 60; // 60 req/window
})();
const apiRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  limit: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// Middleware
app.use(cors(corsOptions));
app.use(express.json());
// Applied to the fan-out-heavy endpoints specifically (see cap above for why
// these two are the ones that matter); a global limiter would also be fine
// but these are the actual amplification surface.
app.use(['/quote', '/unwrap'], apiRateLimiter);

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve documentation page at root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize config on startup (for serverless, this will be called on first request).
// initializeConfig() is itself cheap once the initial discovery has completed (an
// in-memory state check), and calling it on every request - rather than gating
// behind a local "already initialized" flag - is what drives the request-triggered
// failed-pool retry sweep in lib/config.js (see maybeRetryFailedPools, TASK-19).
async function ensureConfigInitialized() {
  await initializeConfig();
}

// Upper bound enforced on every asset/app id (inputToken, outputToken,
// poolId, wrappedTokenId) accepted at the API boundary. Internally, ids are
// converted via Number() throughout lib/ (lib/quotes.js, lib/humbleswap.js,
// lib/nomadex.js, lib/discovery.js, lib/utils.js decimals cache key,
// lib/config.js wrapped-token cache, etc. — TASK-45). A numeric id above
// Number.MAX_SAFE_INTEGER (2^53-1) would silently round to a DIFFERENT
// integer there, which could route/quote the wrong asset. Migrating that
// internal handling to BigInt/string end-to-end was evaluated and rejected
// (too large/risky a change for no realistic benefit — Algorand/Voi asset
// and app ids are currently in the tens of millions). Instead, reject any
// out-of-range id here, before it ever reaches a Number() call (CONVE-35:
// reject, never coerce/clamp to a plausible-but-wrong id).
//
// Only STRING ids are accepted (like `amount` above, and like poolId's
// existing URL-param contract) — deliberately NOT a bare JSON `number`.
// express.json() runs JSON.parse on the request body before this function
// ever sees a value: a numeric wire literal has already been rounded to the
// nearest IEEE-754 double by then, so a malformed/fractional id right at the
// Number.MAX_SAFE_INTEGER boundary (e.g. wire text `9007199254740991.1`)
// would silently arrive here already collapsed into a clean-looking integer,
// with no way to tell it was malformed. Requiring a digit STRING sidesteps
// that class of precision loss entirely, exactly as the amount validation
// above already does for the identical reason.
function isValidAssetId(value) {
  if (typeof value !== 'string') return false;
  // Deliberately NOT trimmed (unlike `amount` above): isValidAssetId only
  // returns a boolean, not a sanitized value, so every call site downstream
  // (String(inputToken), handleQuote, handleUnwrap, etc.) keeps using the
  // ORIGINAL, unmodified string. Validating a trimmed copy here while
  // downstream code forwards the untrimmed original would let a
  // whitespace-padded id (e.g. " 12345") pass validation but reach lib/ in a
  // form that may not match a clean id string used elsewhere (map keys,
  // strict equality against config ids), so padding is rejected outright.
  if (!/^[0-9]+$/.test(value)) return false;
  // Compare in BigInt, not Number: `Number(value) <= Number.MAX_SAFE_INTEGER`
  // would first round a huge numeric string, which is exactly the precision
  // loss this check exists to catch.
  return BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
}

// Build and send a client-safe internal-error response: NEVER echoes
// error.message/stack to the caller (it can contain node internals,
// third-party SDK payloads, or upstream response bodies - an information
// disclosure risk on a money-handling API). Instead logs the full error
// server-side tagged with a short random ID and returns only that ID to the
// client, so a bug report can be correlated back to the matching server log
// line without ever exposing internals over the wire (TASK-27).
function internalError(res, error, context, { label = 'Internal server error', discoveryStatus, status = 500 } = {}) {
  const errorId = randomUUID();
  console.error(`[${errorId}] ${context}:`, error);
  const body = { error: label, errorId };
  return res.status(status).json(discoveryStatus ? withDiscoveryWarning(body, discoveryStatus) : body);
}

// POST /quote endpoint
app.post('/quote', async (req, res) => {
  try {
    // req.body is undefined (not {}) for a request with no body or a
    // non-JSON content-type — express.json() only populates it when the
    // content-type matches. Falling back to {} here (adjacent defect, folded
    // in per CONVE-32) makes that hit the normal "Missing required fields"
    // 400 below instead of a raw destructuring TypeError surfacing as a 500.
    const {
      address,
      inputToken,
      outputToken,
      amount,
      slippageTolerance,
      poolId,
      dex
    } = req.body || {};

    // Validate required fields (address and poolId are now optional). Wrapped
    // with withDiscoveryWarning for a consistent response contract across
    // every /quote exit (TASK-19, CONVE-35) even though these particular 400s
    // are pure input-validation failures unrelated to pool discovery.
    if (inputToken === undefined || outputToken === undefined || !amount) {
      return res.status(400).json(withDiscoveryWarning({
        error: 'Missing required fields: inputToken, outputToken, amount'
      }, getDiscoveryStatus()));
    }

    // Validate inputToken/outputToken/poolId are digit-string ids within
    // Number.MAX_SAFE_INTEGER before anything downstream calls Number() on
    // them (TASK-45, CONVE-35 — see isValidAssetId doc comment above).
    if (!isValidAssetId(inputToken) || !isValidAssetId(outputToken)) {
      return res.status(400).json(withDiscoveryWarning({
        error: `Invalid inputToken/outputToken: must be a string of digits (asset/app id) <= ${Number.MAX_SAFE_INTEGER}`
      }, getDiscoveryStatus()));
    }
    if (poolId !== undefined && poolId !== null && !isValidAssetId(poolId)) {
      return res.status(400).json(withDiscoveryWarning({
        error: `Invalid poolId: must be a string of digits (asset/app id) <= ${Number.MAX_SAFE_INTEGER}`
      }, getDiscoveryStatus()));
    }

    // address is optional (see comment above) — only skip validation when the
    // field is truly omitted (undefined). Any other provided value, including
    // an explicit null or empty string, is a provided value and must be a
    // valid address — reject it outright rather than silently treating it as
    // "no address" (CONVE-35: never coerce ambiguous input into something
    // that only looks like the absent case). Unlike poolId (which treats
    // null the same as undefined), address deliberately does NOT extend that
    // leniency to null: a caller has no legitimate reason to send an explicit
    // null address instead of just omitting the key.
    if (address !== undefined && !algosdk.isValidAddress(address)) {
      return res.status(400).json(withDiscoveryWarning({
        error: 'Invalid address: must be a valid Algorand/Voi address'
      }, getDiscoveryStatus()));
    }

    // Validate amount is a well-formed positive integer STRING in base units,
    // matching the documented API contract (README: `amount` is a string),
    // before it reaches BigInt() deep in the quote engine. A malformed value
    // ("abc", "1.5", "-5", scientific notation) previously threw a raw BigInt
    // SyntaxError there, which surfaced as a 500 and got logged to Supabase as
    // a server error. Requiring a string (rather than accepting a JSON number)
    // also rules out silent precision loss: a JS/JSON number above 2^53 is
    // already rounded before this code runs, so a plausible-but-wrong number
    // could otherwise sail through validation (CONVE-35 — never coerce
    // ambiguous money input into a value that only looks valid).
    if (typeof amount !== 'string') {
      return res.status(400).json({
        error: 'Invalid amount: must be a string of digits (base units), e.g. "1000000"'
      });
    }
    const amountStr = amount.trim();
    if (!/^[0-9]+$/.test(amountStr) || BigInt(amountStr) <= 0n) {
      return res.status(400).json({
        error: 'Invalid amount: must be a positive integer expressed in base units'
      });
    }

    // Default slippage tolerance to 1% only when omitted; honor an explicit 0.
    // Any provided value (including null) is validated as a finite number in
    // [0, 0.5) so a caller cannot sign an unbounded- or negative-loss tx.
    const slippage = slippageTolerance === undefined ? 0.01 : slippageTolerance;
    if (
      typeof slippage !== 'number' ||
      !Number.isFinite(slippage) ||
      slippage < 0 ||
      slippage >= 0.5
    ) {
      return res.status(400).json(withDiscoveryWarning({
        error: 'Invalid slippageTolerance: must be a finite number in [0, 0.5)'
      }, getDiscoveryStatus()));
    }
    const inputTokenStr = String(inputToken);
    const outputTokenStr = String(outputToken);

    // All request validation above is pure/synchronous (no I/O), so a
    // malformed request 400s without depending on config initialization.
    await ensureConfigInitialized();

    // Use unified handler for both single-pool and multi-pool scenarios
    return await handleQuote(req, res, {
      inputToken: inputTokenStr,
      outputToken: outputTokenStr,
      amount: amountStr,
      slippage,
      address,
      poolId,
      dex
    });
  } catch (error) {
    // Surfaces discovery status on this outer catch too (not just inside
    // handleQuote), using the same discoveryWarning shape as every other
    // /quote exit for a consistent response contract - the most likely cause
    // landing here is ensureConfigInitialized() itself throwing (e.g. a
    // below-threshold discovery failure), which is exactly a
    // discovery-status-relevant error, not a generic bug (TASK-19, CONVE-35).
    return internalError(res, error, 'Error generating quote', {
      discoveryStatus: getDiscoveryStatus()
    });
  }
});

// POST /unwrap endpoint
app.post('/unwrap', async (req, res) => {
  try {
    // Validate items and every item's wrappedTokenId before
    // ensureConfigInitialized() so a malformed request fails fast without
    // network I/O (TASK-45). The `items` array-shape check mirrors
    // handleUnwrap's own check byte-for-byte (same message) purely to move
    // it ahead of the network call for a request that's already known to be
    // malformed — handleUnwrap's check is unchanged and still runs as a
    // backstop for any caller that reaches it directly. wrappedTokenId
    // PRESENCE is required here (not just format-when-present): downstream,
    // buildBatchUnwrapTransactions (lib/transactions.js) throws a generic
    // "Each item must include wrappedTokenId and amount" Error for a missing
    // id, whose message doesn't match handleUnwrap's isClientError substring
    // list — so without this check a missing wrappedTokenId would 500
    // instead of 400 (adjacent defect, folded in per CONVE-32). Full item
    // shape/`amount` validation otherwise stays with handleUnwrap, unchanged.
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required and must be non-empty' });
    }
    // Cap items before any per-item validation/chain calls — an unbounded
    // array would otherwise fan out N chain calls before hitting the same
    // MAX_UNWRAP_GROUP_SIZE check that buildBatchUnwrapTransactions
    // (lib/transactions.js) enforces downstream. Reuses that exported
    // constant rather than a separate local number so the two limits can
    // never drift apart.
    if (items.length > MAX_UNWRAP_GROUP_SIZE) {
      return res.status(400).json({
        error: `Too many items: at most ${MAX_UNWRAP_GROUP_SIZE} per unwrap request`
      });
    }
    const badItemIndex = items.findIndex(
      (item) => !item || !isValidAssetId(item.wrappedTokenId)
    );
    if (badItemIndex !== -1) {
      return res.status(400).json({
        error: `Invalid items[${badItemIndex}].wrappedTokenId: required, must be a string of digits (asset id) <= ${Number.MAX_SAFE_INTEGER}`
      });
    }

    await ensureConfigInitialized();
    return await handleUnwrap(req, res);
  } catch (error) {
    return internalError(res, error, 'Error handling unwrap request');
  }
});

// GET /pool/:poolId - Get pool information
app.get('/pool/:poolId', async (req, res) => {
  try {
    const { poolId } = req.params;

    if (!poolId) {
      return res.status(400).json({ error: 'Pool ID is required' });
    }
    // Validated before ensureConfigInitialized() so an out-of-range id fails
    // fast without network I/O (TASK-45; matches the /quote id/amount checks).
    if (!isValidAssetId(poolId)) {
      return res.status(400).json({
        error: `Invalid poolId: must be a string of digits (asset/app id) <= ${Number.MAX_SAFE_INTEGER}`
      });
    }

    await ensureConfigInitialized();

    // Get pool config to determine DEX type
    const poolCfg = getPoolConfigById(poolId);
    const dex = poolCfg?.dex || 'humbleswap';

    if (dex === 'nomadex') {
      // Handle Nomadex pool
      try {
        const poolInfo = await getNomadexPoolInfo(Number(poolId), algodClient, indexerClient, poolCfg);
        
        res.json({
          poolId: poolId,
          dex: 'nomadex',
          tokA: poolInfo.tokA,
          tokB: poolInfo.tokB,
          reserves: {
            A: poolInfo.reserveA,
            B: poolInfo.reserveB
          },
          fees: {
            totFee: poolInfo.fee
          }
        });
      } catch (error) {
        return internalError(res, error, 'Error fetching Nomadex pool info', {
          label: 'Failed to fetch pool information'
        });
      }
    } else {
      // Handle HumbleSwap pool using humbleswap module
      try {
        const poolInfo = await getHumbleswapPoolInfo200(Number(poolId), algodClient, indexerClient);

        res.json({
          poolId: poolId,
          dex: 'humbleswap',
          tokA: poolInfo.tokA,
          tokB: poolInfo.tokB,
          reserves: {
            A: poolInfo.poolBals.A,
            B: poolInfo.poolBals.B
          },
          fees: {
            protoFee: poolInfo.protoInfo.protoFee,
            lpFee: poolInfo.protoInfo.lpFee,
            totFee: poolInfo.protoInfo.totFee
          },
          liquidity: {
            lpHeld: poolInfo.lptBals.lpHeld,
            lpMinted: poolInfo.lptBals.lpMinted
          },
          locked: poolInfo.protoInfo.locked
        });
      } catch (error) {
        return internalError(res, error, 'Error fetching HumbleSwap pool info', {
          label: 'Failed to fetch pool information'
        });
      }
    }

  } catch (error) {
    return internalError(res, error, 'Error fetching pool info');
  }
});

// Optional: GET /config/pools - return configured pools for discovery
app.get('/config/pools', async (req, res) => {
  try {
    await ensureConfigInitialized();
    loadConfigsOnce();
    // `discovery` surfaces any pools that failed and are pending TTL retry, so
    // a partial pool set is visible instead of silently serving worse quotes.
    res.json({ ...poolsConfig, discovery: getDiscoveryStatus() });
  } catch (e) {
    internalError(res, e, 'Failed to load pools config', { label: 'Failed to load pools config' });
  }
});

// Optional: GET /config/tokens - return discovered tokens with metadata
app.get('/config/tokens', async (req, res) => {
  try {
    await ensureConfigInitialized();
    const tokens = getAllTokens();
    res.json({ tokens: tokens });
  } catch (e) {
    internalError(res, e, 'Failed to load tokens config', { label: 'Failed to load tokens config' });
  }
});

// Health check endpoint. Reports 'degraded' (still HTTP 200 - the process is up
// and serving) when some configured pools are missing and pending retry, so a
// partial pool set is visible to operators/monitoring rather than looking
// identical to a fully-healthy instance (TASK-19).
app.get('/health', (req, res) => {
  const discovery = getDiscoveryStatus();
  const status = !discovery.initialized
    ? 'initializing'
    : discovery.failedPools.length > 0
      ? 'degraded'
      : 'ok';
  res.json({ status, discovery });
});

// Global JSON error handler. Must be registered after all routes/middleware
// (Express only recognizes a 4-arg function as error-handling middleware).
// Without this, a malformed JSON request body makes express.json() call
// next(err) with a body-parser SyntaxError that Express's default handler
// turns into an HTML error page — wrong content type for a JSON API. Catch
// that case explicitly and fall back to a generic JSON error for anything
// else so no route ever leaks HTML to a client expecting JSON.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON request body' });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Malformed JSON request body' });
  }
  const status = err.status || err.statusCode || 500;
  if (status < 500) {
    // A framework/middleware-level 4xx (e.g. payload-too-large,
    // unsupported-media-type) - err.message here is a controlled, safe
    // description, not an internal/exception leak, so it is left intact.
    // Only internal/500s are genericized (TASK-27).
    return res.status(status).json({ error: err.message || 'Request error' });
  }
  internalError(res, err, 'Unhandled error', { status });
});

// Start server only when running directly (local development)
// When imported as a module (Vercel), export the app instead
// In ESM, check if we're not in a serverless environment
if (!process.env.VERCEL) {
  // Initialize config before starting server
  initializeConfig().then(() => {
    app.listen(PORT, () => {
      console.log(`Swap API server running on port ${PORT}`);
      console.log(`Algod: ${process.env.ALGOD_URL || 'https://mainnet-api.voi.nodely.dev'}`);
      console.log(`Indexer: ${process.env.INDEXER_URL || 'https://mainnet-idx.voi.nodely.dev'}`);
    });
  }).catch((error) => {
    console.error('Failed to initialize config:', error);
    process.exit(1);
  });
}

// Named exports for unit testing (TASK-45, TASK-27); default export below is unchanged.
export { isValidAssetId, internalError };

// Export app for Vercel serverless function
export default app;
