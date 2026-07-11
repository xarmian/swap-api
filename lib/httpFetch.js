// Shared fetch() wrapper for the raw (non-algosdk) upstream calls in this
// codebase (Mimir pool/token/price API). Without a timeout a single hung TCP
// connection stalls a request until the platform kills it (Vercel
// maxDuration -> 504; local: Node's 5-minute default) - see TASK-18.
const DEFAULT_TIMEOUT_MS = 8000;

function isRetryableError(err) {
  if (!err) return false;
  // fetch() rejects with a DOMException named AbortError/TimeoutError when
  // the AbortSignal.timeout() below fires.
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  // Low-level network failures: fetch() rejects with a TypeError whose
  // `.cause` carries the underlying errno (ECONNRESET, ECONNREFUSED, etc.).
  if (err.cause?.code || err.code) return true;
  return false;
}

/**
 * fetch() with a bounded timeout, always applied. A bounded retry is applied
 * ONLY for idempotent GET/HEAD reads - never for POST/PUT/PATCH/DELETE, so
 * this helper can't be misused later to retry a state-changing call (e.g. a
 * transaction submission) into a double-submit. Retries on: request
 * timeout, low-level network failure, or a 5xx response (treated as
 * transient). Non-5xx error responses (4xx) are returned as-is on the first
 * attempt - retrying them would not change the outcome. Callers are
 * responsible for checking `response.ok`, exactly as before; this never
 * swallows a failure into a fabricated success.
 *
 * @param {string} url
 * @param {{timeoutMs?: number, retries?: number} & RequestInit} [options]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1, ...fetchOptions } = options;
  const method = (fetchOptions.method || 'GET').toUpperCase();
  const maxAttempts = method === 'GET' || method === 'HEAD' ? retries : 0;
  let lastErr;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok && response.status >= 500 && attempt < maxAttempts) {
        lastErr = new Error(`Upstream request to ${url} failed: ${response.status} ${response.statusText}`);
        continue;
      }
      return response;
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !isRetryableError(err)) {
        throw err;
      }
    }
  }
  throw lastErr;
}
