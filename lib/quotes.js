import {
  getPoolInfo as getNomadexPoolInfo,
  calculateOutputAmount as calculateNomadexOutput,
  NOMADEX_FEE_SCALE
} from './nomadex.js';
import {
  getPoolInfo as getHumbleswapPoolInfo,
  calculateOutputAmount as calculateHumbleswapOutput,
  resolveWrappedTokens,
  validateWrappedPair
} from './humbleswap.js';
import { getTokenDecimals, calculatePriceImpact, calculateOptimalSplitAmount, refineSplitAmount, calculateRate, applySlippageToOutput } from './utils.js';
import { generateRouteCombinations, MAX_ROUTE_COMBINATIONS } from './config.js';
import { algodClient, indexerClient } from './clients.js';
import algosdk from 'algosdk';

// Debug flag for verbose logging
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

/**
 * Create a request-scoped pool-info cache shared across the entire quote
 * evaluation chain (findOptimalMultiHopRoute -> calculateMultiHopQuote ->
 * calculateOptimalSplit -> calculateQuoteForPool). Within one /quote request
 * each distinct pool's on-chain info is fetched at most once; every later
 * lookup returns the SAME object, so redundant round-trips (a ulujs Info()
 * simulate for HumbleSwap, 2-4 reads for Nomadex) are eliminated and route
 * comparison always sees consistent state (no divergent mid-request re-fetch).
 *
 * Pool reserves/fees are independent of the caller address (address is only a
 * placeholder sender for the simulate call), and address is constant for the
 * whole request anyway, so keying by pool alone is safe.
 *
 * Cache key is `${dex}:${poolId}` (dex defaults to 'humbleswap') so two
 * distinct pools that happen to share a numeric poolId across DEXes can never
 * collide onto one entry and misprice a trade.
 *
 * Money-correctness note: this cache only avoids redundant FETCHES. It never
 * touches amount math -- callers still run the exact same quote/split/fee/
 * rounding computation against the (now consistent) pool info.
 *
 * @returns {{
 *   get: (poolCfg: Object, address?: string) => Promise<Object>,
 *   peek: (poolCfg: Object) => (Object|null)
 * }}
 *   get:  fetch-once accessor. Returns a Promise of the pool info; dedupes
 *         concurrent in-flight fetches for the same pool. A FAILED fetch is NOT
 *         cached, so a transient error can be retried later in the same request
 *         (calculateQuoteForPool relies on this to recover from a pre-fetch blip).
 *   peek: synchronous read of an already-resolved entry, or null if the pool has
 *         not been successfully fetched yet this request.
 */
function createPoolInfoCache() {
  const resolved = new Map();   // key -> pool info value (successful fetches only)
  const inflight = new Map();   // key -> in-flight Promise (dedupe concurrent fetches)

  const keyFor = (poolCfg) => `${poolCfg.dex || 'humbleswap'}:${String(poolCfg.poolId)}`;

  function fetchPoolInfo(poolCfg, address) {
    const dex = poolCfg.dex || 'humbleswap';
    if (dex === 'nomadex') {
      return getNomadexPoolInfo(Number(poolCfg.poolId), algodClient, indexerClient, poolCfg);
    }
    return getHumbleswapPoolInfo(Number(poolCfg.poolId), algodClient, indexerClient, poolCfg, address);
  }

  return {
    get(poolCfg, address = '') {
      const key = keyFor(poolCfg);
      if (resolved.has(key)) return Promise.resolve(resolved.get(key));
      let p = inflight.get(key);
      if (!p) {
        p = fetchPoolInfo(poolCfg, address).then(
          (info) => { resolved.set(key, info); inflight.delete(key); return info; },
          (err) => { inflight.delete(key); throw err; }
        );
        inflight.set(key, p);
      }
      return p;
    },
    peek(poolCfg) {
      const v = resolved.get(keyFor(poolCfg));
      return v === undefined ? null : v;
    }
  };
}

/**
 * Get platform fee configuration from environment variables
 * @returns {Object} { feeBps: number, feeAddress: string|null }
 */
function getPlatformFeeConfig() {
  const raw = process.env.PLATFORM_FEE_BPS;
  const trimmed = raw ? raw.trim() : "";
  // UNSET/empty (incl. whitespace-only, as before) PLATFORM_FEE_BPS is a valid
  // "no platform fee" config (feeBps = 0). A SET, non-blank value must fail
  // loudly here, at config-read time — never a silent default/clamp to 0, and
  // never an opaque RangeError deep in a later BigInt(). We validate the raw
  // STRING as a plain non-negative integer literal rather than trusting Number()
  // coercion, which would silently swallow fractional, signed, exponential and
  // underflow forms (e.g. "1e-324" and "-1e-324" coerce to 0, "30.5" -> 30.5)
  // and mask a misconfigured fee.
  let feeBps = 0;
  if (trimmed) {
    feeBps = Number(trimmed);
    // isSafeInteger (not isInteger) also rejects digit strings that lose
    // precision past Number.MAX_SAFE_INTEGER before the downstream BigInt(feeBps)
    // — consistent with how this repo rejects oversized asset/app IDs.
    if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(feeBps)) {
      throw new Error(
        `Invalid PLATFORM_FEE_BPS="${raw}": must be a non-negative integer number of basis points.`
      );
    }
  }
  const feeAddress = process.env.PLATFORM_FEE_ADDR || null;

  // Hard ceiling: the platform fee is only ever charged on `gain` (the
  // improvement of the multi-pool split over the best single pool), so 10000
  // bps = 100% of that gain is the maximum sensible fee. Anything above is a
  // confiscatory misconfiguration that can only ever produce a broken quote —
  // reject it LOUDLY at config-read time (fail-fast, mirroring the parse
  // validation above), never a silent default/clamp. feeBps == 10000 is
  // allowed (the ceiling). The runtime min(fee, gain)/min(fee, ΣM_i) caps in
  // calculateOptimalSplit are kept as defense-in-depth: they guard a separate
  // runtime math invariant (gain can exceed ΣM_i), not this config policy.
  if (feeBps > 10000) {
    throw new Error(
      `Invalid PLATFORM_FEE_BPS="${raw}": ${feeBps} basis points exceeds the maximum of 10000 (100% of the multi-pool gain). The platform fee is charged only on the gain over the best single pool, so a value above 10000 is a confiscatory misconfiguration.`
    );
  }

  // A nonzero fee MUST have a valid fee-routing address. Without one the fee
  // output either has no recipient (routed to nowhere / lost) or produces a
  // broken transaction — a money-correctness gap. Fail LOUDLY at config-read
  // time (fail-fast, mirroring the PLATFORM_FEE_BPS validation above and the
  // no-silent-defaults rule of #32/#34/#35), never a silent skip/default. Via
  // the eager getPlatformFeeConfig() call in index.js this also fails the
  // server boot / serverless cold start. The zero-fee path (feeBps == 0) is
  // deliberately left untouched: no fee is charged, so feeAddress is not
  // required and may be null/unset/malformed with no effect.
  if (feeBps > 0) {
    if (!feeAddress) {
      throw new Error(
        `PLATFORM_FEE_ADDR is required when PLATFORM_FEE_BPS is nonzero (feeBps=${feeBps}) but is unset/empty. Set PLATFORM_FEE_ADDR to the valid Algorand/AVM address that should receive the platform fee, or set PLATFORM_FEE_BPS=0 to disable the fee.`
      );
    }
    if (!algosdk.isValidAddress(feeAddress)) {
      throw new Error(
        `Invalid PLATFORM_FEE_ADDR="${feeAddress}": not a valid Algorand/AVM address (bad format or checksum). A nonzero PLATFORM_FEE_BPS (feeBps=${feeBps}) requires a valid fee-routing address.`
      );
    }
  }

  return { feeBps, feeAddress };
}

/**
 * Get default platform fee object (used when no fee is applied)
 * @returns {Object} Default platformFee object with zero values
 */
function getDefaultPlatformFee() {
  const { feeBps, feeAddress } = getPlatformFeeConfig();
  return {
    gain: "0",
    feeAmount: "0",
    feeBps: feeBps,
    feeAddress: feeAddress,
    applied: false
  };
}

/**
 * Resolve the pool trading fee (in basis points) used by the constant-product
 * quote math. A pool config `fee` is honored ONLY as an explicit operator
 * override; otherwise the live on-chain fee (read per quote from the pool/DEX)
 * is used. The resolved fee is validated: an unreadable fee must never be
 * silently coerced to 0 (which would drop the fee and overstate output), so a
 * missing/NaN/negative/>=100% fee throws and the caller skips the pool.
 * @param {number|string|null|undefined} configFee - explicit operator override
 * @param {number|string|null|undefined} liveFee - live on-chain fee (basis points)
 * @returns {number} fee in basis points
 */
function resolveFee(configFee, liveFee) {
  const raw = (configFee !== undefined && configFee !== null) ? configFee : liveFee;
  // Require a concrete numeric fee. We do NOT run arbitrary values through
  // Number(): Number(null/''/false/'  ') all coerce to 0, which would silently
  // drop the fee and overstate output. Only an integer number or bigint counts.
  const fee = (typeof raw === 'bigint') ? Number(raw) : raw;
  if (typeof fee !== 'number' || !Number.isInteger(fee) || fee < 0 || fee >= 10000) {
    throw new Error(`Invalid pool fee (${raw}); refusing to quote without a valid on-chain fee`);
  }
  return fee;
}

/**
 * Resolve a Nomadex pool's fee to the exact on-chain fraction of
 * NOMADEX_FEE_SCALE (1e14) the swap subroutine uses. Two sources, no lossy
 * fallback: an operator bp override converts losslessly (bps is a multiple of
 * SCALE/10000 = 1e10), otherwise the live RAW uint256 fraction is used so the
 * quote reproduces the contract with full sub-basis-point precision. Never
 * reconstructs the scale from the ceil-rounded display bps (that would
 * underquote). Shared by the single-pool quote and the split-refinement search
 * so both price Nomadex identically.
 * @param {Object} poolCfg - pool configuration (may carry a `fee` bp override)
 * @param {Object} poolInfo - live pool info ({ fee, feeScale })
 * @param {number|string} poolId - pool id, for error messages
 * @returns {BigInt} fee as a fraction of NOMADEX_FEE_SCALE, in [0, SCALE)
 */
function resolveNomadexFeeScale(poolCfg, poolInfo, poolId) {
  const hasFeeOverride = poolCfg.fee !== undefined && poolCfg.fee !== null;
  if (hasFeeOverride) {
    const fee = resolveFee(poolCfg.fee, poolInfo.fee);
    return BigInt(fee) * (NOMADEX_FEE_SCALE / 10000n);
  }
  if (poolInfo.feeScale !== undefined && poolInfo.feeScale !== null) {
    return BigInt(poolInfo.feeScale);
  }
  throw new Error(`Nomadex pool ${poolId} pool info is missing feeScale; refusing to quote against a lossy fee`);
}

/**
 * Calculate quote for a single pool (without building transactions)
 * @param {Object} poolCfg - Pool configuration
 * @param {string|number} inputToken - Input token ID (underlying token)
 * @param {string|number} outputToken - Output token ID (underlying token)
 * @param {string|number|BigInt} amount - Input amount
 * @param {number} slippage - Slippage tolerance (e.g., 0.01 for 1%)
 * @param {string} address - Optional address for transaction building
 * @param {Object} cachedPoolInfo - Optional pre-fetched pool info to avoid redundant Info() calls
 * @param {Object} poolInfoCache - Optional request-scoped pool-info cache (see createPoolInfoCache).
 *   Consulted only when cachedPoolInfo is not supplied, so the internal fallback
 *   fetch is deduped across the request instead of hitting chain again.
 * @returns {Promise<Object>} Quote data with outputAmount, rate, priceImpact, poolId, dex
 */
async function calculateQuoteForPool(poolCfg, inputToken, outputToken, amount, slippage, address = '', cachedPoolInfo = null, poolInfoCache = null) {
  const poolId = Number(String(poolCfg.poolId));
  const dex = poolCfg.dex || 'humbleswap';
  const inputTokenStr = String(inputToken);
  const outputTokenStr = String(outputToken);
  const inputTokenNum = Number(inputToken);
  const outputTokenNum = Number(outputToken);
  const amountBigInt = BigInt(amount);
  
  if (dex === 'nomadex') {
    // Handle Nomadex pool
    const tokA = poolCfg.tokens?.tokA;
    const tokB = poolCfg.tokens?.tokB;
    
    if (!tokA || !tokB) {
      throw new Error('Invalid pool configuration: missing token information');
    }
    
    const tokANum = Number(tokA.id);
    const tokBNum = Number(tokB.id);
    
    // Validate input/output tokens match pool
    const validPair =
      (inputTokenNum === tokANum && outputTokenNum === tokBNum) ||
      (inputTokenNum === tokBNum && outputTokenNum === tokANum);
    
    if (!validPair) {
      throw new Error(`Token pair (${inputToken}, ${outputToken}) does not match pool tokens (${tokANum}, ${tokBNum})`);
    }
    
    // Get pool info - prefer an explicitly pre-fetched value, else the shared
    // request cache (fetch-once), else a direct fetch.
    let poolInfo;
    if (cachedPoolInfo) {
      // Use pre-fetched pool info to avoid redundant calls
      poolInfo = cachedPoolInfo;
    } else if (poolInfoCache) {
      poolInfo = await poolInfoCache.get(poolCfg, address);
    } else {
      poolInfo = await getNomadexPoolInfo(poolId, algodClient, indexerClient, poolCfg);
    }
    
    if (poolInfo.tokA === null || poolInfo.tokA === undefined || poolInfo.tokB === null || poolInfo.tokB === undefined) {
      throw new Error('Failed to determine pool token IDs');
    }
    
    // Determine swap direction (alpha to beta = tokA to tokB) against the live
    // pool token order. Require an exact match in one direction; never silently
    // fall back to beta->alpha when the pair matches neither orientation.
    const isDirectionAlphaToBeta = inputTokenNum === poolInfo.tokA && outputTokenNum === poolInfo.tokB;
    const isDirectionBetaToAlpha = inputTokenNum === poolInfo.tokB && outputTokenNum === poolInfo.tokA;
    if (!isDirectionAlphaToBeta && !isDirectionBetaToAlpha) {
      throw new Error(`Token pair (${inputTokenNum}, ${outputTokenNum}) does not match live pool ${poolId} tokens (${poolInfo.tokA}, ${poolInfo.tokB})`);
    }
    const inputReserve = isDirectionAlphaToBeta ? poolInfo.reserveA : poolInfo.reserveB;
    const outputReserve = isDirectionAlphaToBeta ? poolInfo.reserveB : poolInfo.reserveA;
    
    
    // Get token decimals for rate calculation
    const inputDecimals = await getTokenDecimals(inputTokenNum.toString());
    const outputDecimals = await getTokenDecimals(outputTokenNum.toString());
    
    // Prefer the live on-chain fee; a config fee is only an operator override.
    // `fee` (bps) is the display value; the swap math needs the exact fee fraction
    // of NOMADEX_FEE_SCALE the contract uses (see calculateNomadexOutput).
    const fee = resolveFee(poolCfg.fee, poolInfo.fee);
    // Reconcile fee units to the on-chain scale so the quote matches the contract
    // exactly (no over/underquote). Shared helper, no lossy fallback.
    const feeScale = resolveNomadexFeeScale(poolCfg, poolInfo, poolId);

    // Calculate quote
    const outputAmount = calculateNomadexOutput(amountBigInt, inputReserve, outputReserve, feeScale);
    const minimumOutputAmount = applySlippageToOutput(outputAmount, slippage);
    const priceImpact = calculatePriceImpact(amountBigInt, inputReserve, outputAmount, outputReserve);

    // Rate normalized for token decimals (shared helper, single source of truth)
    const rate = calculateRate(outputAmount, amountBigInt, inputDecimals, outputDecimals);

    return {
      poolId: poolId.toString(),
      dex: 'nomadex',
      outputAmount: outputAmount.toString(),
      minimumOutputAmount: minimumOutputAmount.toString(),
      rate: rate,
      priceImpact: priceImpact,
      poolInfo: {
        reserveA: inputReserve,
        reserveB: outputReserve,
        fee: fee,
        isDirectionAlphaToBeta
      }
    };
  } else {
    // Handle HumbleSwap pool
    const { inputWrapped, outputWrapped } = resolveWrappedTokens(poolCfg, inputToken, outputToken);

    // Validate wrapped pair matches pool
    if (!validateWrappedPair(poolCfg, inputWrapped, outputWrapped)) {
      throw new Error('Resolved wrapped tokens do not match pool configured pair');
    }

    // Use cached pool info if provided, otherwise fetch it
    let poolInfo;
    let poolBals;
    let protoInfo;
    
    if (cachedPoolInfo) {
      // Use pre-fetched pool info to avoid redundant Info() calls
      poolInfo = cachedPoolInfo;
      poolBals = poolInfo.poolBals;
      protoInfo = poolInfo.protoInfo;
    } else if (poolInfoCache) {
      // Fall back to the shared request cache (fetch-once) rather than hitting chain again
      poolInfo = await poolInfoCache.get(poolCfg, address);
      poolBals = poolInfo.poolBals;
      protoInfo = poolInfo.protoInfo;
    } else {
      // Fetch pool info using humbleswap module
      poolInfo = await getHumbleswapPoolInfo(poolCfg.poolId, algodClient, indexerClient, poolCfg, address);
      poolBals = poolInfo.poolBals;
      protoInfo = poolInfo.protoInfo;
    }
    
    // Determine swap direction against live pool token order. Require an exact
    // match in one direction; never silently fall back to B->A when the wrapped
    // pair matches neither orientation (that would swap against the wrong
    // reserves and misprice the trade).
    const swapAForB = inputWrapped === poolInfo.tokA && outputWrapped === poolInfo.tokB;
    const swapBForA = inputWrapped === poolInfo.tokB && outputWrapped === poolInfo.tokA;
    if (!swapAForB && !swapBForA) {
      throw new Error(`Swap tokens (${inputWrapped}, ${outputWrapped}) do not match pool ${poolId} tokens (${poolInfo.tokA}, ${poolInfo.tokB})`);
    }
    const inputReserve = swapAForB ? poolBals.A : poolBals.B;
    const outputReserve = swapAForB ? poolBals.B : poolBals.A;

    // Prefer the live on-chain fee; a config fee is only an operator override.
    const totalFee = resolveFee(poolCfg.fee, protoInfo.totFee);

    // Token decimals for the normalized rate (matches the Nomadex branch so the
    // `rate` field carries one consistent meaning across DEXes)
    const inputDecimals = await getTokenDecimals(inputTokenNum.toString());
    const outputDecimals = await getTokenDecimals(outputTokenNum.toString());

    // Calculate quote
    const outputAmount = calculateHumbleswapOutput(amount, inputReserve, outputReserve, totalFee);
    const minimumOutputAmount = applySlippageToOutput(outputAmount, slippage);
    const priceImpact = calculatePriceImpact(amount, inputReserve, outputAmount, outputReserve);
    const rate = calculateRate(outputAmount, amount, inputDecimals, outputDecimals);

    return {
      poolId: poolId.toString(),
      dex: 'humbleswap',
      outputAmount: outputAmount.toString(),
      minimumOutputAmount: minimumOutputAmount.toString(),
      rate: rate,
      priceImpact: priceImpact,
      poolInfo: {
        inputWrapped: inputWrapped,
        outputWrapped: outputWrapped,
        reserveA: inputReserve,
        reserveB: outputReserve,
        fee: totalFee,
        swapAForB
      }
    };
  }
}

/**
 * Generate candidate split-ratio vectors for an n-way grid search.
 * Produces: each pool alone (100%), every 50/50 pair, and one equal split
 * across all pools. Each vector has length n. For n === 3 this reproduces the
 * original 7-vector grid exactly, while scaling correctly to 4+ pools/routes.
 * @param {number} n - number of pools/routes (n >= 2)
 * @returns {number[][]} array of ratio vectors, each of length n
 */
function generateSplitRatios(n) {
  const vectors = [];
  // 100% into a single pool/route
  for (let i = 0; i < n; i++) {
    const v = new Array(n).fill(0);
    v[i] = 1;
    vectors.push(v);
  }
  // 50/50 across each distinct pair
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = new Array(n).fill(0);
      v[i] = 0.5;
      v[j] = 0.5;
      vectors.push(v);
    }
  }
  // Equal split across all pools/routes
  vectors.push(new Array(n).fill(1 / n));
  return vectors;
}

/**
 * Allocate a BigInt total across ratio weights, ensuring the parts sum exactly
 * to the total. Any rounding remainder is added to the last positive-ratio slot
 * so it never strands a spurious dust amount in a pool meant to receive nothing.
 * The remainder recipient is chosen by ratio (not by computed amount) so the
 * exact-sum invariant holds even for very small totals where every slot rounds
 * down to 0n (e.g. total=1 with a 50/50 split).
 * @param {BigInt} total - total input amount
 * @param {number[]} ratios - weights (need not sum exactly to 1)
 * @returns {BigInt[]} per-slot allocations summing to total
 */
function allocateAmounts(total, ratios) {
  const amounts = ratios.map(p => (total * BigInt(Math.floor(p * 10000))) / 10000n);
  let lastFunded = -1;
  for (let i = 0; i < ratios.length; i++) {
    if (ratios[i] > 0) lastFunded = i;
  }
  if (lastFunded >= 0) {
    const sum = amounts.reduce((a, b) => a + b, 0n);
    amounts[lastFunded] += total - sum;
  }
  return amounts;
}

/**
 * Classify a caught pool-quoting error into a short reason string for the
 * routeDegraded signal. TASK-18's httpClient timeout wrapper propagates the
 * raw fetch() AbortSignal.timeout() rejection (a DOMException with
 * name 'TimeoutError', or 'AbortError' pre-Node-fetch-standardization) rather
 * than a re-wrapped error, so we key off `err.name` first and fall back to a
 * message substring for anything else that looks like a network timeout.
 * @param {*} err - the caught error/rejection
 * @returns {'timeout'|'error'}
 */
function classifySkipReason(err) {
  const name = err?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  return 'error';
}

/**
 * Composite reconciliation key `${dex||'humbleswap'}:${poolId}` for skipped/
 * succeeded pool bookkeeping. Matches the pool cache-key discipline (PR #23) so
 * skipped/succeeded pools reconcile on (dex, poolId), never poolId alone -- two
 * pools that ever shared a numeric poolId across DEXes could not collide. Given
 * Algorand app ids are globally unique this is behavior-neutral today (equal
 * poolId implies equal dex); it is robustness alignment.
 * @param {{dex?: string, poolId: string|number}} entry
 * @returns {string}
 */
function skipReconcileKey(entry) {
  return `${entry.dex || 'humbleswap'}:${String(entry.poolId)}`;
}

/**
 * Merge multiple `skippedPools` arrays (as returned by calculateOptimalSplit
 * and calculateMultiHopQuote) into one, deduped by the composite (dex, poolId)
 * key (first occurrence wins). Used to roll a per-pool/per-hop degrade signal up
 * into a per-multi-hop-route or per-cross-route-split signal.
 * @param {...Array<{poolId: string, dex?: string, reason: string}>} lists
 * @returns {Array<{poolId: string, dex?: string, reason: string}>}
 */
function mergeSkippedPools(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const entry of (list || [])) {
      const key = skipReconcileKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

/**
 * Calculate optimal split across multiple pools to maximize output
 * Uses iterative approach to find best allocation
 * @param {Array<Object>} matchingPools - Array of matching pool configs
 * @param {string|number} inputToken - Input token ID
 * @param {string|number} outputToken - Output token ID
 * @param {string|number|BigInt} totalAmount - Total input amount
 * @param {number} slippage - Slippage tolerance
 * @param {string} address - Optional address for pool info calls
 * @param {Object} poolInfoCache - Request-scoped pool-info cache (see createPoolInfoCache).
 *   Defaults to a fresh per-call cache; callers thread one shared instance so a
 *   pool is fetched at most once across the whole request.
 * @param {boolean} distributeFeePerLeg - Fee accounting mode (TASK-54). Default
 *   false = Option C: leave every split leg GROSS and let the direct-route
 *   handler subtract the aggregate platformFee.feeAmount exactly once (reported
 *   net/min == ΣG_i/ΣM_i − F, no per-leg flooring dust). Pass true ONLY from the
 *   multi-hop caller (calculateMultiHopQuote), which discards platformFee and
 *   forwards each leg's output into the next hop: it needs the prior per-leg
 *   fee-reduced leg values so multi-hop hop-chaining stays byte-identical.
 * @returns {Promise<Object>} { splitDetails: Array, platformFee: Object|null, skippedPools: Array, succeededPoolIds: Array }
 *   splitDetails: Array of split details: { poolCfg, amount, expectedOutput, minOutput, quote }
 *   platformFee: { feeAmount: string, feeAddress: string, gain: string, feeBps: number } or null
 *   skippedPools: Array of { poolId: string, dex: string, reason: 'error'|'timeout' } for pools
 *     that threw during quoting and NEVER once produced a successful quote in this call (a pool that
 *     errored once but recovered on retry/re-fetch is not reported as skipped -- this only flags
 *     pools genuinely unreachable this request, never pools that simply lost out on pricing). The
 *     `dex` field carries the pool's DEX so skip/success reconciliation keys on (dex, poolId).
 *   succeededPoolIds: Array of composite (dex, poolId) keys (see skipReconcileKey) for every pool
 *     that produced at least one successful quote in this call, including ones that lost the
 *     pricing comparison and aren't in
 *     splitDetails. Callers that aggregate across multiple calculateOptimalSplit calls (e.g.
 *     findOptimalMultiHopRoute evaluating several candidate routes) use this -- not splitDetails
 *     membership -- to tell whether a pool skipped in one candidate is demonstrably reachable via
 *     a different candidate, so it never gets reported as skipped for the whole request.
 */
async function calculateOptimalSplit(matchingPools, inputToken, outputToken, totalAmount, slippage, address = '', poolInfoCache = createPoolInfoCache(), distributeFeePerLeg = false) {
  if (matchingPools.length === 0) {
    throw new Error('No matching pools found');
  }

  const totalAmountBigInt = BigInt(totalAmount);

  // Raw log of every pool-quoting error caught below (may contain duplicate
  // poolIds -- e.g. a pool that fails the info pre-fetch AND the full quote)
  // plus the set of poolIds that produced AT LEAST ONE successful quote
  // anywhere in this request. finalizeSkippedPools() reconciles the two: a
  // poolId is only reported as skipped if it NEVER once succeeded. This is
  // deliberately NOT "is this pool in the final splitDetails" -- a pool that
  // recovers (e.g. the info pre-fetch hiccups but the full quote then
  // succeeds) or that succeeds but simply loses the pricing comparison to a
  // better pool/split must never be reported as skipped; only a pool that
  // was genuinely unavailable for the whole request is (CONVE-35: the signal
  // must stay honest, never conflating "errored" with "lost on pricing").
  const skipErrors = [];
  // succeededPoolIds holds composite (dex, poolId) reconciliation keys, not bare
  // poolIds, so skip/success matching keys on (dex, poolId) -- see skipReconcileKey.
  const succeededPoolIds = new Set();
  function recordSkip(poolCfg, err) {
    skipErrors.push({ poolId: String(poolCfg.poolId), dex: poolCfg.dex || 'humbleswap', reason: classifySkipReason(err) });
  }
  function recordSuccess(poolCfg) {
    succeededPoolIds.add(skipReconcileKey(poolCfg));
  }
  function finalizeSkippedPools() {
    const seen = new Set();
    const skippedPools = [];
    for (const entry of skipErrors) {
      const key = skipReconcileKey(entry);
      if (succeededPoolIds.has(key) || seen.has(key)) continue;
      seen.add(key);
      skippedPools.push(entry);
    }
    return skippedPools;
  }

  // Pre-fetch pool info for ALL pools (both HumbleSwap and Nomadex) through the
  // shared request cache, so each distinct pool is fetched at most once for the
  // whole request. A failure here is only tentatively recorded: it does NOT by
  // itself mean the pool is unusable (calculateQuoteForPool retries via the same
  // cache when cachedPoolInfo is falsy, and a failed fetch is never cached), so
  // it's reconciled below against whether the pool's actual QUOTE attempt (not
  // just the info pre-fetch) ever succeeds.
  await Promise.all(
    matchingPools.map(poolCfg => {
      return poolInfoCache.get(poolCfg, address).catch((err) => {
        console.warn(`Failed to fetch pool info for pool ${poolCfg.poolId} (${poolCfg.dex || 'humbleswap'}):`, err.message);
        recordSkip(poolCfg, err);
        return null;
      });
    })
  );

  // If only one pool, use it entirely (no platform fee for single pool)
  if (matchingPools.length === 1) {
    const poolCfg = matchingPools[0];
    const cachedInfo = poolInfoCache.peek(poolCfg);
    const quote = await calculateQuoteForPool(poolCfg, inputToken, outputToken, totalAmount, slippage, address, cachedInfo, poolInfoCache);
    recordSuccess(poolCfg);
    const splitDetails = [{
      poolCfg,
      amount: totalAmountBigInt.toString(),
      expectedOutput: quote.outputAmount,
      minOutput: quote.minimumOutputAmount,
      quote
    }];
    return {
      splitDetails,
      platformFee: getDefaultPlatformFee(),
      skippedPools: finalizeSkippedPools(),
      succeededPoolIds: Array.from(succeededPoolIds)
    };
  }
  
  // For multiple pools, find optimal split using mathematical optimization
  const numPools = matchingPools.length;
  
  // For 2 pools, use binary search to find optimal split mathematically
  if (numPools === 2) {
    // Use the pool configs exactly as supplied. These already carry the correct
    // DEX identity; re-resolving by numeric poolId (getPoolConfigById) would drop
    // it and, when a poolId is shared across DEXes, silently swap in the wrong
    // pool -- mispricing the split AND poisoning the (dex,poolId) cache key.
    const poolCfg1 = matchingPools[0];
    const poolCfg2 = matchingPools[1];

    // Get cached pool info - for HumbleSwap it's the full Info() result, for Nomadex it's the poolInfo object
    const cachedInfo1 = poolInfoCache.peek(poolCfg1);
    const cachedInfo2 = poolInfoCache.peek(poolCfg2);

    // Test both pools with full amount to see if they work
    const fullQuote1 = await calculateQuoteForPool(poolCfg1, inputToken, outputToken, totalAmount, slippage, address, cachedInfo1, poolInfoCache).then((q) => {
      recordSuccess(poolCfg1);
      return q;
    }).catch((err) => {
      console.warn(`Pool ${poolCfg1.poolId} (${poolCfg1.dex || 'humbleswap'}) failed to calculate quote:`, err.message);
      recordSkip(poolCfg1, err);
      return null;
    });
    const fullQuote2 = await calculateQuoteForPool(poolCfg2, inputToken, outputToken, totalAmount, slippage, address, cachedInfo2, poolInfoCache).then((q) => {
      recordSuccess(poolCfg2);
      return q;
    }).catch((err) => {
      console.warn(`Pool ${poolCfg2.poolId} (${poolCfg2.dex || 'humbleswap'}) failed to calculate quote:`, err.message);
      recordSkip(poolCfg2, err);
      return null;
    });

    if (!fullQuote1 && !fullQuote2) {
      throw new Error('Both pools failed to calculate quotes');
    }

    // If only one pool works, use it entirely (no platform fee for single pool)
    if (!fullQuote1) {
      const splitDetails = [{
        poolCfg: poolCfg2,
        amount: totalAmountBigInt.toString(),
        expectedOutput: fullQuote2.outputAmount,
        minOutput: fullQuote2.minimumOutputAmount,
        quote: fullQuote2
      }];
      return {
        splitDetails,
        platformFee: getDefaultPlatformFee(),
        skippedPools: finalizeSkippedPools(),
        succeededPoolIds: Array.from(succeededPoolIds)
      };
    }
    if (!fullQuote2) {
      const splitDetails = [{
        poolCfg: poolCfg1,
        amount: totalAmountBigInt.toString(),
        expectedOutput: fullQuote1.outputAmount,
        minOutput: fullQuote1.minimumOutputAmount,
        quote: fullQuote1
      }];
      return {
        splitDetails,
        platformFee: getDefaultPlatformFee(),
        skippedPools: finalizeSkippedPools(),
        succeededPoolIds: Array.from(succeededPoolIds)
      };
    }

    // Both pools work - calculate optimal split mathematically

    // Guard against a null pool-info cache entry: the pre-fetch above (line
    // ~370-378) can fail transiently for a pool while the per-pool quote retry
    // just above still succeeds (calculateQuoteForPool re-fetches internally
    // when cachedPoolInfo is falsy). If we blindly reused cachedInfo1/cachedInfo2
    // below, a null cache entry would null-deref on poolInfo1.tokA etc. Re-fetch
    // the raw pool info here so the split math always has a real object.
    let resolvedInfo1 = cachedInfo1;
    if (!resolvedInfo1) {
      resolvedInfo1 = await poolInfoCache.get(poolCfg1, address);
    }
    let resolvedInfo2 = cachedInfo2;
    if (!resolvedInfo2) {
      resolvedInfo2 = await poolInfoCache.get(poolCfg2, address);
    }

    // Extract pool reserves and fees from cached info or quotes. We also build a
    // per-pool output closure (out1Fn/out2Fn) that reproduces each pool's EXACT
    // on-chain output using the corrected per-DEX formula (Nomadex uses the raw
    // fee-scale curve; HumbleSwap uses the fee-adjusted-input curve). These feed
    // the curve-exact split refinement below, so the split seed is optimized
    // against the true curves for Nomadex-only, HumbleSwap-only, and mixed pairs.
    let r1In, r1Out, f1, r2In, r2Out, f2;
    let out1Fn, out2Fn;

    if (poolCfg1.dex === 'nomadex') {
      const poolInfo1 = resolvedInfo1;
      const isDirectionAlphaToBeta1 = Number(inputToken) === poolInfo1.tokA && Number(outputToken) === poolInfo1.tokB;
      r1In = BigInt(isDirectionAlphaToBeta1 ? poolInfo1.reserveA : poolInfo1.reserveB);
      r1Out = BigInt(isDirectionAlphaToBeta1 ? poolInfo1.reserveB : poolInfo1.reserveA);
      // Prefer the live on-chain fee; a config fee is only an operator override.
      f1 = resolveFee(poolCfg1.fee, poolInfo1.fee);
      const feeScale1 = resolveNomadexFeeScale(poolCfg1, poolInfo1, poolCfg1.poolId);
      out1Fn = (x) => calculateNomadexOutput(x, r1In, r1Out, feeScale1);
    } else {
      // HumbleSwap
      const poolInfo1 = resolvedInfo1;
      const swapAForB1 = fullQuote1.poolInfo.swapAForB;
      r1In = BigInt(swapAForB1 ? poolInfo1.poolBals.A : poolInfo1.poolBals.B);
      r1Out = BigInt(swapAForB1 ? poolInfo1.poolBals.B : poolInfo1.poolBals.A);
      // Prefer the live on-chain fee; a config fee is only an operator override.
      f1 = resolveFee(poolCfg1.fee, poolInfo1.protoInfo.totFee);
      out1Fn = (x) => calculateHumbleswapOutput(x, r1In, r1Out, f1);
    }

    if (poolCfg2.dex === 'nomadex') {
      const poolInfo2 = resolvedInfo2;
      const isDirectionAlphaToBeta2 = Number(inputToken) === poolInfo2.tokA && Number(outputToken) === poolInfo2.tokB;
      r2In = BigInt(isDirectionAlphaToBeta2 ? poolInfo2.reserveA : poolInfo2.reserveB);
      r2Out = BigInt(isDirectionAlphaToBeta2 ? poolInfo2.reserveB : poolInfo2.reserveA);
      // Prefer the live on-chain fee; a config fee is only an operator override.
      f2 = resolveFee(poolCfg2.fee, poolInfo2.fee);
      const feeScale2 = resolveNomadexFeeScale(poolCfg2, poolInfo2, poolCfg2.poolId);
      out2Fn = (y) => calculateNomadexOutput(y, r2In, r2Out, feeScale2);
    } else {
      // HumbleSwap
      const poolInfo2 = resolvedInfo2;
      const swapAForB2 = fullQuote2.poolInfo.swapAForB;
      r2In = BigInt(swapAForB2 ? poolInfo2.poolBals.A : poolInfo2.poolBals.B);
      r2Out = BigInt(swapAForB2 ? poolInfo2.poolBals.B : poolInfo2.poolBals.A);
      // Prefer the live on-chain fee; a config fee is only an operator override.
      f2 = resolveFee(poolCfg2.fee, poolInfo2.protoInfo.totFee);
      out2Fn = (y) => calculateHumbleswapOutput(y, r2In, r2Out, f2);
    }

    // Closed-form seed: a heuristic starting point. It solves the split for the
    // Uniswap fee-adjusted-input curve, so it is a good (but floor-rounded, not
    // exact) fit for HumbleSwap and only approximate when a Nomadex pool is
    // involved (whose curve differs from that denominator).
    const optimalP1Amount = calculateOptimalSplitAmount(totalAmountBigInt, r1In, r1Out, f1, r2In, r2Out, f2);
    // Refine the seed against the ACTUAL per-pool curves with a bounded,
    // DEX-agnostic search. Guaranteed no worse than the seed (it evaluates the
    // endpoints and the seed among its candidates), so it can only improve or tie
    // the seed's routing — most notably for Nomadex-involving/mixed pairs, where
    // the seed's Uniswap-curve assumption is off.
    const refinedP1Amount = refineSplitAmount(totalAmountBigInt, out1Fn, out2Fn, optimalP1Amount);

    // Ensure minimum amounts (at least 0.1% of total). Snap a sub-dust leg to a
    // single-pool route so we never strand a spurious tiny allocation.
    const minAmount = totalAmountBigInt / BigInt(1000);
    const clampSplit = (p1) => {
      let a = p1;
      let b = totalAmountBigInt - p1;
      if (a < minAmount) { a = 0n; b = totalAmountBigInt; }
      else if (b < minAmount) { a = totalAmountBigInt; b = 0n; }
      return { p1Amount: a, p2Amount: b };
    };
    const seedSplit = clampSplit(optimalP1Amount);
    const refinedSplit = clampSplit(refinedP1Amount);

    // Test edge cases plus BOTH the closed-form seed and the curve-refined split.
    // Keeping the seed in the candidate set guarantees the refinement can only
    // improve or tie the prior 3-point method; the winner is chosen by exact
    // re-validated output below, so the reported output is always honest.
    let bestSplit = null;
    let bestTotalOutput = 0n;

    const allCandidates = [
      { p1Amount: 0n, p2Amount: totalAmountBigInt, name: '100% pool2' },
      { p1Amount: totalAmountBigInt, p2Amount: 0n, name: '100% pool1' },
      { p1Amount: seedSplit.p1Amount, p2Amount: seedSplit.p2Amount, name: 'optimal split (seed)' },
      { p1Amount: refinedSplit.p1Amount, p2Amount: refinedSplit.p2Amount, name: 'refined split' }
    ];
    // Dedupe by pool-1 amount (p2 is fully determined by it) so identical
    // candidates — e.g. a HumbleSwap-only pair where the refinement ties the
    // seed, or a split that snaps to an endpoint — don't trigger a redundant
    // re-validation. Keeps the number of re-validation calls bounded (<= 4).
    const seen = new Set();
    const testCases = allCandidates.filter((tc) => {
      const key = tc.p1Amount.toString();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    for (const testCase of testCases) {
      if (testCase.p1Amount === 0n) {
        const totalOutput = BigInt(fullQuote2.outputAmount);
        if (totalOutput > bestTotalOutput) {
          bestTotalOutput = totalOutput;
          bestSplit = [{
            poolCfg: poolCfg2,
            amount: testCase.p2Amount.toString(),
            expectedOutput: fullQuote2.outputAmount,
            minOutput: fullQuote2.minimumOutputAmount,
            quote: fullQuote2
          }];
        }
      } else if (testCase.p2Amount === 0n) {
        const totalOutput = BigInt(fullQuote1.outputAmount);
        if (totalOutput > bestTotalOutput) {
          bestTotalOutput = totalOutput;
          bestSplit = [{
            poolCfg: poolCfg1,
            amount: testCase.p1Amount.toString(),
            expectedOutput: fullQuote1.outputAmount,
            minOutput: fullQuote1.minimumOutputAmount,
            quote: fullQuote1
          }];
        }
      } else {
        // Calculate quotes for the optimal split
        const quotes = await Promise.all([
          calculateQuoteForPool(poolCfg1, inputToken, outputToken, testCase.p1Amount.toString(), slippage, address, resolvedInfo1, poolInfoCache).catch((err) => {
            recordSkip(poolCfg1, err);
            return null;
          }),
          calculateQuoteForPool(poolCfg2, inputToken, outputToken, testCase.p2Amount.toString(), slippage, address, resolvedInfo2, poolInfoCache).catch((err) => {
            recordSkip(poolCfg2, err);
            return null;
          })
        ]);
        
        if (quotes[0] && quotes[1]) {
          const totalOutput = BigInt(quotes[0].outputAmount) + BigInt(quotes[1].outputAmount);
          if (totalOutput > bestTotalOutput) {
            bestTotalOutput = totalOutput;
            bestSplit = [{
              poolCfg: poolCfg1,
              amount: testCase.p1Amount.toString(),
              expectedOutput: quotes[0].outputAmount,
              minOutput: quotes[0].minimumOutputAmount,
              quote: quotes[0]
            }, {
              poolCfg: poolCfg2,
              amount: testCase.p2Amount.toString(),
              expectedOutput: quotes[1].outputAmount,
              minOutput: quotes[1].minimumOutputAmount,
              quote: quotes[1]
            }];
          }
        }
      }
    }
    
    if (bestSplit) {
      // Calculate platform fee for multi-pool route
      const multiPoolOutput = bestSplit.reduce((sum, split) => sum + BigInt(split.expectedOutput), 0n);
      const bestSinglePoolOutput = BigInt(fullQuote1.outputAmount) > BigInt(fullQuote2.outputAmount) 
        ? BigInt(fullQuote1.outputAmount) 
        : BigInt(fullQuote2.outputAmount);
      
      const { feeBps, feeAddress } = getPlatformFeeConfig();
      let platformFee = getDefaultPlatformFee();
      
      // Always calculate gain for multi-pool routes
      if (multiPoolOutput > bestSinglePoolOutput) {
        const gain = multiPoolOutput - bestSinglePoolOutput;
        
        // Update platformFee with calculated gain
        platformFee.gain = gain.toString();
        
        // Apply fee if configured
        if (feeBps > 0 && feeAddress) {
          // Cap the fee at the realized gain. The fee is only ever charged on
          // `gain` (the improvement of the multi-pool split over the best
          // single pool), so it can never legitimately exceed that gain. For
          // every valid config (feeBps <= 10000) `uncappedFee <= gain`, making
          // this cap a strict no-op. feeBps > 10000 is now hard-rejected at
          // config read (getPlatformFeeConfig, TASK-56), so this cap is kept as
          // defense-in-depth on the runtime math invariant (separate layer from
          // config policy) — a belt-and-suspenders guard should the fee formula
          // or config validation ever change.
          const uncappedFee = (gain * BigInt(feeBps)) / BigInt(10000);
          let feeAmount = uncappedFee > gain ? gain : uncappedFee;

          // Option C (direct routes): additionally cap the aggregate fee at ΣM_i
          // (the aggregate GROSS minimum). On-chain the fee is one separate
          // transfer of the full feeAmount while the swaps are guaranteed to
          // yield at least ΣM_i; capping at ΣM_i keeps the reported/enforced net
          // floor (ΣM_i − feeAmount) >= 0 so the fee can never exceed the
          // guaranteed output. No-op for non-confiscatory configs (feeAmount <<
          // ΣM_i); only a near-100% fee at high slippage would hit it. Multi-hop
          // keeps the legacy per-leg accounting, so this cap must NOT apply there.
          if (!distributeFeePerLeg) {
            const totalMinOutput = bestSplit.reduce((sum, split) => sum + BigInt(split.minOutput), 0n);
            if (feeAmount > totalMinOutput) feeAmount = totalMinOutput;
          }

          if (feeAmount > 0n) {
            if (distributeFeePerLeg) {
              // Legacy per-leg distribution, retained ONLY for the multi-hop
              // caller (TASK-54): multi-hop discards platformFee and forwards each
              // leg's output into the next hop, so the legs must keep their prior
              // fee-reduced values for hop-chaining to stay byte-identical.
              const totalOutput = multiPoolOutput;
              for (const split of bestSplit) {
                const splitOutput = BigInt(split.expectedOutput);
                const splitMinOutput = BigInt(split.minOutput);
                const splitFeeAmount = (feeAmount * splitOutput) / totalOutput;
                const splitMinFeeAmount = (feeAmount * splitMinOutput) / totalOutput;
                split.expectedOutput = (splitOutput - splitFeeAmount).toString();
                split.minOutput = (splitMinOutput - splitMinFeeAmount).toString();
              }
            }
            // Option C (aggregate fee) for direct routes: split legs stay fully
            // GROSS (split.expectedOutput = G_i, split.minOutput = M_i, the gross
            // slippage min). On-chain the fee is a SINGLE separate transfer of the
            // full `feeAmount`, and the aggregate net/min are reduced by it exactly
            // once when the response is assembled (lib/handlers.js). No per-leg fee
            // distribution means no proportional-flooring dust: reported net ==
            // ΣG_i − feeAmount and reported min == ΣM_i − feeAmount (the worst-case
            // enforced net floor).
            platformFee.feeAmount = feeAmount.toString();
            platformFee.applied = true;
          }
        }
      }
      
      return {
        splitDetails: bestSplit,
        platformFee: platformFee,
        skippedPools: finalizeSkippedPools(),
        succeededPoolIds: Array.from(succeededPoolIds)
      };
    }

    // Fallback: use the pool with better full quote (no platform fee for single pool)
    if (BigInt(fullQuote1.outputAmount) > BigInt(fullQuote2.outputAmount)) {
      const splitDetails = [{
        poolCfg: poolCfg1,
        amount: totalAmountBigInt.toString(),
        expectedOutput: fullQuote1.outputAmount,
        minOutput: fullQuote1.minimumOutputAmount,
        quote: fullQuote1
      }];
      return {
        splitDetails,
        platformFee: getDefaultPlatformFee(),
        skippedPools: finalizeSkippedPools(),
        succeededPoolIds: Array.from(succeededPoolIds)
      };
    } else {
      const splitDetails = [{
        poolCfg: poolCfg2,
        amount: totalAmountBigInt.toString(),
        expectedOutput: fullQuote2.outputAmount,
        minOutput: fullQuote2.minimumOutputAmount,
        quote: fullQuote2
      }];
      return {
        splitDetails,
        platformFee: getDefaultPlatformFee(),
        skippedPools: finalizeSkippedPools(),
        succeededPoolIds: Array.from(succeededPoolIds)
      };
    }
  } else {
    // For more than 2 pools, use a simpler approach: equal split or try a few common splits
    // This can be optimized later with more sophisticated algorithms
    let bestSplit = null;
    let bestTotalOutput = 0n;
    
    // Grid search over candidate split ratios sized to the actual pool count.
    const splits = generateSplitRatios(numPools);

    for (const split of splits) {
      const amounts = allocateAmounts(totalAmountBigInt, split);

      // Skip only if a NON-ZERO allocation is dust; zero allocations are valid
      // (they simply mean that pool is unused for this candidate).
      if (amounts.some(a => a > 0n && a < totalAmountBigInt / 1000n)) {
        continue;
      }

      try {
        const quotes = await Promise.all(
          matchingPools.map((pool, idx) => {
            if (amounts[idx] === 0n) return null;
            const cachedInfo = poolInfoCache.peek(pool);
            return calculateQuoteForPool(pool, inputToken, outputToken, amounts[idx].toString(), slippage, address, cachedInfo, poolInfoCache).then((q) => {
              recordSuccess(pool);
              return q;
            }).catch((err) => {
              recordSkip(pool, err);
              return null;
            });
          })
        );

        // A candidate is valid only if every funded pool produced a quote;
        // otherwise executing it would strand the failed pool's allocation.
        const allFundedQuoted = quotes.every((q, idx) => amounts[idx] === 0n || q !== null);
        if (allFundedQuoted) {
          const totalOutput = quotes.reduce((sum, q) => sum + (q ? BigInt(q.outputAmount) : 0n), 0n);
          if (totalOutput > bestTotalOutput) {
            bestTotalOutput = totalOutput;
            bestSplit = [];
            for (let idx = 0; idx < matchingPools.length; idx++) {
              if (amounts[idx] === 0n || !quotes[idx]) continue;
              bestSplit.push({
                poolCfg: matchingPools[idx],
                amount: amounts[idx].toString(),
                expectedOutput: quotes[idx].outputAmount,
                minOutput: quotes[idx].minimumOutputAmount,
                quote: quotes[idx]
              });
            }
          }
        }
      } catch (err) {
        continue;
      }
    }
    
    if (!bestSplit || bestSplit.length === 0) {
      // Fallback: use the pool with best single-pool quote (no platform fee for single pool)
      const quotes = await Promise.all(
        matchingPools.map(pool => {
          const cachedInfo = poolInfoCache.peek(pool);
          return calculateQuoteForPool(pool, inputToken, outputToken, totalAmount, slippage, address, cachedInfo, poolInfoCache)
            .then(quote => {
              recordSuccess(pool);
              return { pool, quote };
            })
            .catch((err) => {
              recordSkip(pool, err);
              return null;
            });
        })
      );

      const validQuotes = quotes.filter(q => q !== null);
      if (validQuotes.length === 0) {
        throw new Error('Failed to calculate quotes for any pool');
      }

      // Find pool with highest output
      const best = validQuotes.reduce((best, current) => {
        const bestOutput = BigInt(best.quote.outputAmount);
        const currentOutput = BigInt(current.quote.outputAmount);
        return currentOutput > bestOutput ? current : best;
      });

      const splitDetails = [{
        poolCfg: best.pool,
        amount: totalAmountBigInt.toString(),
        expectedOutput: best.quote.outputAmount,
        minOutput: best.quote.minimumOutputAmount,
        quote: best.quote
      }];
      return {
        splitDetails,
        platformFee: getDefaultPlatformFee(),
        skippedPools: finalizeSkippedPools(),
        succeededPoolIds: Array.from(succeededPoolIds)
      };
    }
    
    // Calculate platform fee for multi-pool route (3+ pools)
    const multiPoolOutput = bestSplit.reduce((sum, split) => sum + BigInt(split.expectedOutput), 0n);
    
    // Calculate best single-pool output by testing each pool with full amount
    const singlePoolQuotes = await Promise.all(
      matchingPools.map(pool => {
        const cachedInfo = poolInfoCache.peek(pool);
        return calculateQuoteForPool(pool, inputToken, outputToken, totalAmount, slippage, address, cachedInfo, poolInfoCache)
          .then(quote => {
            recordSuccess(pool);
            return BigInt(quote.outputAmount);
          })
          .catch((err) => {
            recordSkip(pool, err);
            return 0n;
          });
      })
    );
    const bestSinglePoolOutput = singlePoolQuotes.reduce((max, output) => output > max ? output : max, 0n);
    
    const { feeBps, feeAddress } = getPlatformFeeConfig();
    let platformFee = getDefaultPlatformFee();
    
    // Always calculate gain for multi-pool routes
    if (multiPoolOutput > bestSinglePoolOutput) {
      const gain = multiPoolOutput - bestSinglePoolOutput;
      
      // Update platformFee with calculated gain
      platformFee.gain = gain.toString();
      
      // Apply fee if configured
      if (feeBps > 0 && feeAddress) {
        // Cap the fee at the realized gain (see the 2-pool site above): the fee
        // is only ever charged on `gain`, so it can never legitimately exceed
        // it. No-op for every valid config (feeBps <= 10000); feeBps > 10000 is
        // hard-rejected at config read (TASK-56), so this cap is kept as
        // defense-in-depth on the runtime math invariant, not config policy.
        const uncappedFee = (gain * BigInt(feeBps)) / BigInt(10000);
        let feeAmount = uncappedFee > gain ? gain : uncappedFee;

        // Option C (direct routes): additionally cap the aggregate fee at ΣM_i
        // (the aggregate GROSS minimum) so the single fee transfer can never
        // exceed the guaranteed output and push the reported/enforced net floor
        // (ΣM_i − feeAmount) below zero. No-op for non-confiscatory configs; only
        // a near-100% fee at high slippage would hit it. Multi-hop keeps the
        // legacy per-leg accounting, so this cap must NOT apply there.
        if (!distributeFeePerLeg) {
          const totalMinOutput = bestSplit.reduce((sum, split) => sum + BigInt(split.minOutput), 0n);
          if (feeAmount > totalMinOutput) feeAmount = totalMinOutput;
        }

        if (feeAmount > 0n) {
          if (distributeFeePerLeg) {
            // Legacy per-leg distribution, retained ONLY for the multi-hop
            // caller (TASK-54): multi-hop discards platformFee and forwards each
            // leg's output into the next hop, so the legs must keep their prior
            // fee-reduced values for hop-chaining to stay byte-identical.
            const totalOutput = multiPoolOutput;
            for (const split of bestSplit) {
              const splitOutput = BigInt(split.expectedOutput);
              const splitMinOutput = BigInt(split.minOutput);
              const splitFeeAmount = (feeAmount * splitOutput) / totalOutput;
              const splitMinFeeAmount = (feeAmount * splitMinOutput) / totalOutput;
              split.expectedOutput = (splitOutput - splitFeeAmount).toString();
              split.minOutput = (splitMinOutput - splitMinFeeAmount).toString();
            }
          }
          // Option C (aggregate fee) for direct routes: split legs stay fully
          // GROSS (split.expectedOutput = G_i, split.minOutput = M_i, the gross
          // slippage min). On-chain the fee is a SINGLE separate transfer of the
          // full `feeAmount`, and the aggregate net/min are reduced by it exactly
          // once when the response is assembled (lib/handlers.js). No per-leg fee
          // distribution means no proportional-flooring dust: reported net ==
          // ΣG_i − feeAmount and reported min == ΣM_i − feeAmount (the worst-case
          // enforced net floor).
          platformFee.feeAmount = feeAmount.toString();
          platformFee.applied = true;
        }
      }
    }
    
    return {
      splitDetails: bestSplit,
      platformFee: platformFee,
      skippedPools: finalizeSkippedPools(),
      succeededPoolIds: Array.from(succeededPoolIds)
    };
  }
}

/**
 * Calculate quote for a multi-hop route with optional per-hop splitting
 * @param {Object} route - Route object with pools (single pool per hop) or poolOptions (multiple pools per hop)
 * @param {string|number} inputToken - Input token ID (underlying token)
 * @param {string|number} outputToken - Output token ID (underlying token)
 * @param {string|number|BigInt} amount - Input amount
 * @param {number} slippage - Slippage tolerance
 * @param {string} address - Optional address for pool info calls
 * @param {Object} poolInfoCache - Request-scoped pool-info cache (see createPoolInfoCache).
 *   Defaults to a fresh per-call cache; callers thread one shared instance so a
 *   pool is fetched at most once across the whole request (and across every
 *   candidate route/combination compared within it).
 * @returns {Promise<Object>} Quote data with outputAmount, rate, priceImpact, route details
 */
async function calculateMultiHopQuote(route, inputToken, outputToken, amount, slippage, address = '', poolInfoCache = createPoolInfoCache()) {
  const { pools, poolOptions, intermediateTokens } = route;
  const totalAmountBigInt = BigInt(amount);

  // Determine if we have single pools or pool options for each hop
  const hasPoolOptions = poolOptions && Array.isArray(poolOptions) && poolOptions.length > 0;
  const hasPools = pools && Array.isArray(pools) && pools.length > 0;

  if (!hasPoolOptions && !hasPools) {
    throw new Error('Route has no pools or poolOptions');
  }

  const numHops = hasPoolOptions ? poolOptions.length : pools.length;

  // Pre-fetch pool info for all pools through the shared request cache, so each
  // distinct pool is fetched at most once for the whole request.
  const allPools = hasPoolOptions
    ? poolOptions.flat()
    : pools;

  await Promise.all(
    allPools.map(poolCfg => {
      return poolInfoCache.get(poolCfg, address).catch((err) => {
        console.warn(`Failed to fetch pool info for pool ${poolCfg.poolId} (${poolCfg.dex || 'humbleswap'}):`, err.message);
        return null;
      });
    })
  );
  
  // Calculate quotes for each hop sequentially, with optional splitting
  const hopQuotes = [];
  let currentInputToken = Number(inputToken);
  let currentAmount = totalAmountBigInt;
  // TASK-44: pools skipped (errored/timed out and not represented in the
  // route) by any split hop's calculateOptimalSplit call, collected here and
  // merged (deduped by (dex, poolId), via the shared mergeSkippedPools helper) into
  // the returned `skippedPools` below. A single-pool (non-split) hop has no
  // silent skip path -- calculateQuoteForPool there is unguarded, so a
  // failure throws out of this whole function rather than degrading silently.
  const hopSkippedLists = [];
  // Every poolId that produced at least one successful quote in ANY split
  // hop's calculateOptimalSplit call, even if it lost that hop's pricing
  // comparison. Exposed on the return value so a caller aggregating several
  // calculateMultiHopQuote calls (findOptimalMultiHopRoute) can tell a pool
  // skipped in one candidate is reachable via a different candidate.
  const hopSucceededPoolIds = new Set();

  for (let hopIndex = 0; hopIndex < numHops; hopIndex++) {
    const currentOutputToken = hopIndex < numHops - 1
      ? Number(intermediateTokens[hopIndex])
      : Number(outputToken);

    // Slippage handling for multi-hop routes:
    // - All hops use the same slippage tolerance for quote calculation
    // - This gives each hop flexibility to handle market movement
    // - The FINAL hop's minimumOutputAmount becomes the user-facing guarantee,
    //   and it is enforced on-chain exactly as reported (no hidden margin)
    const hopSlippage = slippage;

    let hopSplitResult;

    if (hasPoolOptions && poolOptions[hopIndex] && poolOptions[hopIndex].length > 0) {
      // Multiple pools for this hop - calculate optimal split
      const hopPools = poolOptions[hopIndex];
      if (DEBUG) console.log(`[calculateMultiHopQuote] Hop ${hopIndex + 1}: Splitting ${currentAmount.toString()} ${currentInputToken} across ${hopPools.length} pools (slippage: ${hopSlippage})`);

      hopSplitResult = await calculateOptimalSplit(
        hopPools,
        currentInputToken,
        currentOutputToken,
        currentAmount.toString(),
        hopSlippage,
        address,
        poolInfoCache,
        // TASK-54: multi-hop keeps the legacy per-leg fee distribution so its
        // hop-chaining (which forwards each leg's output into the next hop) stays
        // byte-identical. Multi-hop discards platformFee at the handler level, so
        // Option C's aggregate accounting only applies to direct routes.
        true
      );
      hopSkippedLists.push(hopSplitResult.skippedPools);
      for (const poolKey of (hopSplitResult.succeededPoolIds || [])) {
        hopSucceededPoolIds.add(poolKey);
      }

      // Convert split details to hop quotes format
      const hopQuoteDetails = hopSplitResult.splitDetails.map(split => ({
        poolCfg: split.poolCfg,
        inputToken: currentInputToken,
        outputToken: currentOutputToken,
        inputAmount: split.amount,
        outputAmount: split.expectedOutput,
        minimumOutputAmount: split.minOutput,
        rate: split.quote.rate,
        priceImpact: split.quote.priceImpact,
        quote: split.quote
      }));
      
      // Aggregate output from all pools in this hop
      const totalHopOutput = hopSplitResult.splitDetails.reduce(
        (sum, split) => sum + BigInt(split.expectedOutput), 
        0n
      );
      const totalHopMinOutput = hopSplitResult.splitDetails.reduce(
        (sum, split) => sum + BigInt(split.minOutput), 
        0n
      );
      
      // Calculate weighted average price impact for this hop
      const totalInputNum = Number(currentAmount);
      const weightedPriceImpact = hopSplitResult.splitDetails.reduce((sum, split) => {
        const splitInput = Number(split.amount);
        const weight = splitInput / totalInputNum;
        return sum + (split.quote.priceImpact * weight);
      }, 0);
      
      hopQuotes.push({
        hopIndex,
        inputToken: currentInputToken,
        outputToken: currentOutputToken,
        inputAmount: currentAmount.toString(),
        outputAmount: totalHopOutput.toString(),
        minimumOutputAmount: totalHopMinOutput.toString(),
        priceImpact: weightedPriceImpact,
        splitDetails: hopQuoteDetails,
        isSplit: true
      });
      
      // Use aggregated output as input for next hop
      currentInputToken = currentOutputToken;
      currentAmount = totalHopOutput;
      
      if (DEBUG) console.log(`[calculateMultiHopQuote] Hop ${hopIndex + 1}: Aggregated output ${totalHopOutput.toString()} ${currentOutputToken} from ${hopPools.length} pools`);
    } else {
      // Single pool for this hop
      const poolCfg = hasPools ? pools[hopIndex] : null;
      if (!poolCfg) {
        throw new Error(`No pool available for hop ${hopIndex + 1}`);
      }

      // Get cached pool info
      const cachedInfo = poolInfoCache.peek(poolCfg);

      // Calculate quote for this hop (using hopSlippage - 0 for intermediate, user's slippage for final)
      const quote = await calculateQuoteForPool(
        poolCfg,
        currentInputToken,
        currentOutputToken,
        currentAmount.toString(),
        hopSlippage,
        address,
        cachedInfo,
        poolInfoCache
      );
      hopSucceededPoolIds.add(skipReconcileKey(poolCfg));

      hopQuotes.push({
        hopIndex,
        poolCfg,
        inputToken: currentInputToken,
        outputToken: currentOutputToken,
        inputAmount: currentAmount.toString(),
        outputAmount: quote.outputAmount,
        minimumOutputAmount: quote.minimumOutputAmount,
        rate: quote.rate,
        priceImpact: quote.priceImpact,
        quote,
        isSplit: false
      });
      
      // Use output of this hop as input for next hop
      currentInputToken = currentOutputToken;
      currentAmount = BigInt(quote.outputAmount);
    }
  }
  
  // Aggregate results from final hop
  const finalHop = hopQuotes[hopQuotes.length - 1];
  const totalOutput = BigInt(finalHop.outputAmount);
  const totalMinOutput = BigInt(finalHop.minimumOutputAmount);
  
  // Calculate overall rate (accounting for decimals) via the shared helper
  const inputDecimals = await getTokenDecimals(inputToken);
  const outputDecimals = await getTokenDecimals(outputToken);
  const overallRate = calculateRate(totalOutput, totalAmountBigInt, inputDecimals, outputDecimals);

  // Calculate cumulative price impact across all hops
  let cumulativePriceImpact = 0;
  for (const hopQuote of hopQuotes) {
    cumulativePriceImpact += hopQuote.priceImpact;
  }
  
  return {
    outputAmount: totalOutput.toString(),
    minimumOutputAmount: totalMinOutput.toString(),
    rate: overallRate,
    priceImpact: cumulativePriceImpact,
    hopQuotes: hopQuotes,
    route: route,
    // TASK-44: pools skipped due to an error/timeout in any split hop;
    // empty when every hop's pools all responded.
    skippedPools: mergeSkippedPools(...hopSkippedLists),
    // TASK-44: every poolId that produced a successful quote anywhere in
    // this call (including ones that lost a hop's pricing comparison).
    succeededPoolIds: Array.from(hopSucceededPoolIds)
  };
}

/**
 * Find the optimal multi-hop route by evaluating all pool combinations
 * @param {Array<Object>} routes - Array of route objects (may have poolOptions or be concrete routes)
 * @param {string|number} inputToken - Input token ID (underlying token)
 * @param {string|number} outputToken - Output token ID (underlying token)
 * @param {string|number|BigInt} amount - Input amount
 * @param {number} slippage - Slippage tolerance
 * @param {string} address - Optional address for pool info calls
 * @param {number} maxCombinations - Maximum number of combinations to evaluate per route (default: MAX_ROUTE_COMBINATIONS, env-tunable via MAX_ROUTE_COMBINATIONS, TASK-26)
 * @param {Object} poolInfoCache - Request-scoped pool-info cache (see createPoolInfoCache).
 *   Defaults to a fresh cache; handleQuote passes ONE shared instance so a pool
 *   is fetched at most once across every candidate route/combination compared
 *   here AND the sibling direct-route calculateOptimalSplit call in the request.
 * @returns {Promise<Object|null>} Best route quote: {route, quote} or null if no valid routes
 */
async function findOptimalMultiHopRoute(routes, inputToken, outputToken, amount, slippage, address = '', maxCombinations = MAX_ROUTE_COMBINATIONS, poolInfoCache = createPoolInfoCache()) {
  if (!routes || routes.length === 0) {
    if (DEBUG) console.log('[findOptimalMultiHopRoute] No routes provided');
    return null;
  }

  if (DEBUG) console.log(`[findOptimalMultiHopRoute] Evaluating ${routes.length} route(s) for ${inputToken}->${outputToken}, amount: ${amount}`);
  
  let bestQuote = null;
  let bestRoute = null;
  let bestOutput = 0n;

  // TASK-44: this function evaluates MANY independent candidate routes/combos
  // (poolOptions splitting, then concrete combinations per route), each via
  // its own calculateMultiHopQuote call with its own request-local
  // skippedPools. A pool that errors in one candidate (which might end up
  // being the winner) can still succeed in a different candidate evaluated
  // moments later in this same search. That later success must cancel the
  // earlier skip for the SAME reason calculateOptimalSplit's own
  // recordSuccess/recordSkip reconciliation exists: a pool that is
  // demonstrably reachable this request must never be reported as skipped.
  // poolIdsUsedAnywhere tracks every poolId that actually appears (i.e. won
  // its hop's pricing comparison) in ANY evaluated candidate's hopQuotes, PLUS
  // every poolId in that candidate's own succeededPoolIds (pools that produced
  // a successful quote even if they lost their hop's internal comparison and
  // so never made it into hopQuotes) - the latter closes the gap where a pool
  // is reachable but never happens to win any candidate's split. Used to
  // filter the final winner's skippedPools below.
  // Holds composite (dex, poolId) reconciliation keys (see skipReconcileKey),
  // matching succeededPoolIds' key format, so the winner's skippedPools are
  // filtered on (dex, poolId) rather than poolId alone.
  const poolIdsUsedAnywhere = new Set();
  function trackUsedPools(quote) {
    for (const hopQuote of (quote?.hopQuotes || [])) {
      if (hopQuote.isSplit && Array.isArray(hopQuote.splitDetails)) {
        for (const split of hopQuote.splitDetails) {
          if (split.poolCfg) poolIdsUsedAnywhere.add(skipReconcileKey(split.poolCfg));
        }
      } else if (hopQuote.poolCfg) {
        poolIdsUsedAnywhere.add(skipReconcileKey(hopQuote.poolCfg));
      }
    }
    for (const poolKey of (quote?.succeededPoolIds || [])) {
      poolIdsUsedAnywhere.add(poolKey);
    }
  }
  
  // TASK-22: Build the full ordered list of candidate evaluations, then run them
  // concurrently. Order is preserved EXACTLY as the previous sequential
  // implementation produced it (per route, in route order: the poolOptions
  // per-hop-splitting candidate first, then each concrete combination in
  // generation order). The winner is chosen below with a strict
  // `output > bestOutput` comparison, so the FIRST candidate at the maximum
  // output wins ties -- i.e. evaluation order is selection-relevant and must not
  // change. Each candidate is tagged so the reduction can reproduce the original
  // per-candidate bookkeeping.
  const candidates = [];
  // TASK-22: routes whose concrete enumeration we deferred as a FAILURE-ONLY
  // fallback (see below). A single-pool-per-hop route's poolOptions candidate can
  // only fail via a transient error (calculateOptimalSplit's one-pool path is
  // unguarded and a failed pool-info fetch is never cached); when it does, we
  // still evaluate its concrete combination -- inline, in route order (see the
  // reduction loop) -- exactly as the old code's always-run concrete pass acted
  // as a retry after a transient split failure.
  const deferredSinglePoolRoutes = new Set();
  // TASK-26: enforce the fan-out cap as a PER-REQUEST budget shared across ALL
  // candidate routes, not merely per-route. generateRouteCombinations bounds a
  // SINGLE route's concrete combinations, but findRoutes can return several
  // routes, so without a shared budget one /quote could still enumerate
  // maxCombinations * (number of routes) concrete combinations - the exact
  // amplification (each a full re-evaluation) this cap exists to stop. Only the
  // expensive concrete cartesian enumeration draws down the budget, in route
  // order; each route's single cheap poolOptions (per-hop split) candidate is
  // always kept so every route stays represented by its best split. Lowering
  // the cap only changes HOW MANY concrete candidates are evaluated, never the
  // AMM/selection math applied to the ones that are (CONVE-35).
  let concreteCombinationBudget = maxCombinations;
  for (const route of routes) {
    const hasPoolOptions = route.poolOptions && Array.isArray(route.poolOptions) && route.poolOptions.length > 0;

    // Candidate 1: evaluate the route with per-hop splitting (poolOptions).
    if (hasPoolOptions) {
      candidates.push({ originalRoute: route, evalRoute: route, type: 'poolOptions' });
    }

    // Candidate set 2: concrete pool combinations (drawn from the shared budget).
    let concreteRoutes = [];
    if (route.pools && Array.isArray(route.pools) && route.pools.length > 0) {
      // Route is already concrete (no poolOptions to split): one combination,
      // evaluated only while budget remains.
      concreteRoutes = concreteCombinationBudget > 0 ? [route] : [];
    } else if (hasPoolOptions) {
      // TASK-22: a route whose every hop has exactly one pool has only ONE
      // possible concrete combination, and that combination is IDENTICAL to the
      // per-hop-splitting candidate above: a "split" across a single pool routes
      // the full amount through that one pool with no platform fee (see
      // calculateOptimalSplit's matchingPools.length === 1 branch), producing
      // the exact same per-hop -- and therefore final -- output. On the success
      // path re-evaluating it would be pure duplicated work that can only ever
      // tie the poolOptions candidate and, losing the strict-greater tie break,
      // never change the winner. So don't enumerate it up front; defer it as a
      // failure-only fallback evaluated inline in route order below.
      const singlePoolPerHop = route.poolOptions.every(
        hopPools => Array.isArray(hopPools) && hopPools.length === 1
      );
      if (singlePoolPerHop) {
        deferredSinglePoolRoutes.add(route);
      } else if (concreteCombinationBudget > 0) {
        // Pass the REMAINING budget (not the full cap) so the total concrete
        // combinations across every route can never exceed maxCombinations.
        concreteRoutes = generateRouteCombinations(route, concreteCombinationBudget);
      }
    }
    concreteCombinationBudget -= concreteRoutes.length;
    for (const concreteRoute of concreteRoutes) {
      candidates.push({ originalRoute: route, evalRoute: concreteRoute, type: 'concrete' });
    }
  }

  // Reduce one settled candidate result into the running best. Called in
  // candidate order (never concurrently), so the strict `output > bestOutput`
  // tie break and the shared mutable state (bestOutput, poolIdsUsedAnywhere)
  // behave exactly like the old sequential loop. Returns true iff the candidate
  // produced a successful quote.
  function applyResult({ candidate, quote, error }) {
    const { originalRoute, evalRoute, type } = candidate;

    if (error) {
      if (type === 'poolOptions') {
        console.warn(`[findOptimalMultiHopRoute] Failed to calculate quote for route with splitting:`, error.message);
      } else {
        console.warn(`[findOptimalMultiHopRoute] Failed to calculate quote for concrete combination:`, error.message);
      }
      return false;
    }

    const output = BigInt(quote.outputAmount);
    trackUsedPools(quote);

    if (type === 'poolOptions') {
      if (output > bestOutput) {
        bestOutput = output;
        bestQuote = quote;
        bestRoute = originalRoute; // Keep the route with poolOptions
      }
    } else {
      if (output > bestOutput) {
        bestOutput = output;
        bestQuote = quote;
        bestRoute = evalRoute;
      }
    }
    return true;
  }

  // Evaluate a route's concrete combinations concurrently and return the settled
  // results in generation order (used for the failure-only single-pool fallback).
  function evaluateConcreteCombinations(route) {
    const concreteRoutes = generateRouteCombinations(route, maxCombinations);
    return Promise.all(
      concreteRoutes.map(concreteRoute =>
        calculateMultiHopQuote(concreteRoute, inputToken, outputToken, amount, slippage, address, poolInfoCache)
          .then(quote => ({ candidate: { originalRoute: route, evalRoute: concreteRoute, type: 'concrete' }, quote, error: null }))
          .catch(error => ({ candidate: { originalRoute: route, evalRoute: concreteRoute, type: 'concrete' }, quote: null, error }))
      )
    );
  }

  if (DEBUG) console.log(`[findOptimalMultiHopRoute] Evaluating ${candidates.length} candidate(s) concurrently`);

  // TASK-22: evaluate every candidate concurrently. This is safe now that all
  // pool state is fetched through the shared request-scoped poolInfoCache, which
  // dedupes both resolved AND in-flight fetches -- so concurrent candidates that
  // touch the same pool trigger at most one fetch and observe identical state.
  // Each evaluation's own error is caught so one bad candidate can't reject the
  // whole batch, exactly as the previous try/catch-per-candidate did.
  const evaluated = await Promise.all(
    candidates.map(candidate =>
      calculateMultiHopQuote(
        candidate.evalRoute,
        inputToken,
        outputToken,
        amount,
        slippage,
        address,
        poolInfoCache
      )
        .then(quote => ({ candidate, quote, error: null }))
        .catch(error => ({ candidate, quote: null, error }))
    )
  );

  // Reduce results in the original candidate order so the strict-greater tie
  // break selects exactly the same winner (route AND amounts) as the previous
  // sequential version for the same chain state. When a single-pool-per-hop
  // route's poolOptions candidate fails (transient error only), evaluate its
  // deferred concrete fallback INLINE here -- i.e. in the exact position the old
  // always-run concrete pass occupied (right after that route's poolOptions
  // candidate, before the next route) -- so the tie break order is unchanged.
  for (const result of evaluated) {
    const succeeded = applyResult(result);
    if (!succeeded && result.candidate.type === 'poolOptions' && deferredSinglePoolRoutes.has(result.candidate.originalRoute)) {
      if (DEBUG) console.log(`[findOptimalMultiHopRoute] Split pass failed for a single-pool route; evaluating concrete fallback`);
      const fallbackResults = await evaluateConcreteCombinations(result.candidate.originalRoute);
      for (const fallbackResult of fallbackResults) {
        applyResult(fallbackResult);
      }
    }
  }

  if (bestQuote && bestRoute) {
    // Always show summary of selected route
    const hops = bestRoute.poolOptions?.length || bestRoute.pools?.length || 1;
    const poolCount = bestRoute.poolOptions
      ? bestRoute.poolOptions.reduce((sum, opts) => sum + opts.length, 0)
      : bestRoute.pools?.length || 1;
    console.log(`[Quote] ${inputToken} -> ${outputToken}: ${amount} in, ${bestOutput.toString()} out (${hops} hops, ${poolCount} pools)`);
    // TASK-44: drop any poolId from the winning quote's skippedPools that
    // demonstrably succeeded in SOME evaluated candidate this request (see
    // poolIdsUsedAnywhere/trackUsedPools above) - a pool that is reachable
    // this request must never be reported as skipped, even if the specific
    // candidate that ended up winning happened to hit a transient error for it.
    if (bestQuote.skippedPools && bestQuote.skippedPools.length > 0) {
      bestQuote.skippedPools = bestQuote.skippedPools.filter(
        entry => !poolIdsUsedAnywhere.has(skipReconcileKey(entry))
      );
    }
    return {
      route: bestRoute,
      quote: bestQuote
    };
  }

  if (DEBUG) console.log('[findOptimalMultiHopRoute] No valid route found');
  return null;
}

export {
  calculateQuoteForPool,
  calculateOptimalSplit,
  calculateMultiHopQuote,
  findOptimalMultiHopRoute,
  // Request-scoped pool-info cache factory. handleQuote creates one per /quote
  // request and threads it through the whole quote pipeline; also reused by tests.
  createPoolInfoCache,
  // Pure helpers exported for unit testing (no chain access required).
  getPlatformFeeConfig,
  resolveFee,
  generateSplitRatios,
  allocateAmounts,
  skipReconcileKey,
  mergeSkippedPools
};

