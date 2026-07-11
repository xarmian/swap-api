import { URLTokenBaseHTTPClient } from 'algosdk/client';

// Bound every algod/indexer REST call so a hung upstream connection can
// never stall a quote request until the platform kills it (Vercel maxDuration
// -> 504; local Node's 5-minute default). algosdk 3.x's default HTTP client
// has no timeout at all (see algosdk/dist/esm/client/urlTokenBaseHTTPClient.js).
const DEFAULT_TIMEOUT_MS = 8000;

function isRetryableError(err) {
  if (!err) return false;
  // fetch() rejects with a DOMException named AbortError/TimeoutError when
  // the AbortSignal.timeout() we attach below fires.
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const status = err.status ?? err.response?.status;
  if (typeof status === 'number' && status >= 500) return true;
  // Low-level network failures: fetch() rejects with a TypeError whose
  // `.cause` carries the underlying errno (ECONNRESET, ECONNREFUSED, etc.).
  if (err.cause?.code || err.code) return true;
  return false;
}

function withTimeout(customOptions, timeoutMs) {
  return { ...(customOptions ?? {}), signal: AbortSignal.timeout(timeoutMs) };
}

/**
 * Wraps algosdk's default URLTokenBaseHTTPClient (the thing that actually
 * calls fetch()) so that:
 *  - every request is bounded by a timeout, and
 *  - idempotent GET reads (accountInformation, suggestedParams,
 *    lookupApplications, lookupAssetByID, ...) get ONE bounded retry on a
 *    transient failure (timeout, network error, 5xx).
 *
 * POST/DELETE are intentionally never retried here: algod's
 * sendRawTransaction is a POST, and retrying a transaction submission risks
 * a double-submit. This class has no way to tell "read" POSTs (there are
 * none in this API's usage) apart from "write" POSTs, so it plays it safe
 * and retries GET only.
 *
 * Implements algosdk's BaseHTTPClient duck-typed interface (get/post/delete)
 * so it can be passed directly as the first constructor argument to
 * `algosdk.Algodv2` / `algosdk.Indexer` in place of a token string.
 */
export class TimeoutRetryHTTPClient {
  constructor(tokenHeader, baseServer, port, defaultHeaders = {}, options = {}) {
    this.inner = new URLTokenBaseHTTPClient(tokenHeader, baseServer, port, defaultHeaders);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? 1;
  }

  async get(relativePath, query, requestHeaders, customOptions) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.inner.get(relativePath, query, requestHeaders, withTimeout(customOptions, this.timeoutMs));
      } catch (err) {
        lastErr = err;
        if (attempt === this.retries || !isRetryableError(err)) {
          throw err;
        }
      }
    }
    // Unreachable, but keeps control flow explicit.
    throw lastErr;
  }

  async post(relativePath, data, query, requestHeaders, customOptions) {
    return this.inner.post(relativePath, data, query, requestHeaders, withTimeout(customOptions, this.timeoutMs));
  }

  async delete(relativePath, data, query, requestHeaders, customOptions) {
    return this.inner.delete(relativePath, data, query, requestHeaders, withTimeout(customOptions, this.timeoutMs));
  }
}
