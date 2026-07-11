import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

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

// POST /quote endpoint
app.post('/quote', async (req, res) => {
  try {
    const {
      address,
      inputToken,
      outputToken,
      amount,
      slippageTolerance,
      poolId,
      dex
    } = req.body;

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
    console.error('Error generating quote:', error);
    // Surfaces discovery status on this outer catch too (not just inside
    // handleQuote), using the same discoveryWarning shape as every other
    // /quote exit for a consistent response contract - the most likely cause
    // landing here is ensureConfigInitialized() itself throwing (e.g. a
    // below-threshold discovery failure), which is exactly a
    // discovery-status-relevant error, not a generic bug (TASK-19, CONVE-35).
    res.status(500).json(withDiscoveryWarning({
      error: 'Internal server error',
      message: error.message
    }, getDiscoveryStatus()));
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
    console.error('Error handling unwrap request:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
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
        console.error('Error fetching Nomadex pool info:', error);
        return res.status(500).json({
          error: 'Failed to fetch pool information',
          details: error.message
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
        console.error('Error fetching HumbleSwap pool info:', error);
        return res.status(500).json({
          error: 'Failed to fetch pool information',
          details: error.message
        });
      }
    }

  } catch (error) {
    console.error('Error fetching pool info:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
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
    res.status(500).json({ error: 'Failed to load pools config', message: e.message });
  }
});

// Optional: GET /config/tokens - return discovered tokens with metadata
app.get('/config/tokens', async (req, res) => {
  try {
    await ensureConfigInitialized();
    const tokens = getAllTokens();
    res.json({ tokens: tokens });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load tokens config', message: e.message });
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
  console.error('Unhandled error:', err);
  res.status(err.status || err.statusCode || 500).json({
    error: 'Internal server error',
    message: err.message
  });
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

// Named export for unit testing (TASK-45); default export below is unchanged.
export { isValidAssetId };

// Export app for Vercel serverless function
export default app;
