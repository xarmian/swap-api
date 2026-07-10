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
import { getPoolConfigById, generateRouteCombinations } from './config.js';
import { algodClient, indexerClient } from './clients.js';

// Debug flag for verbose logging
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

/**
 * Get platform fee configuration from environment variables
 * @returns {Object} { feeBps: number, feeAddress: string|null }
 */
function getPlatformFeeConfig() {
  const feeBps = process.env.PLATFORM_FEE_BPS ? Number(process.env.PLATFORM_FEE_BPS) : 0;
  const feeAddress = process.env.PLATFORM_FEE_ADDR || null;
  
  // Validate feeBps is reasonable (warn if > 100% = 10000 basis points)
  if (feeBps > 10000) {
    console.warn(`Warning: PLATFORM_FEE_BPS is ${feeBps} basis points (${feeBps / 100}%), which exceeds 100%. This may be a configuration error.`);
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
 * @returns {Promise<Object>} Quote data with outputAmount, rate, priceImpact, poolId, dex
 */
async function calculateQuoteForPool(poolCfg, inputToken, outputToken, amount, slippage, address = '', cachedPoolInfo = null) {
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
    
    // Get pool info - use cached if provided, otherwise fetch
    let poolInfo;
    if (cachedPoolInfo) {
      // Use pre-fetched pool info to avoid redundant calls
      poolInfo = cachedPoolInfo;
    } else {
      // Fetch pool info (shouldn't happen if caching works correctly)
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
 * Calculate optimal split across multiple pools to maximize output
 * Uses iterative approach to find best allocation
 * @param {Array<Object>} matchingPools - Array of matching pool configs
 * @param {string|number} inputToken - Input token ID
 * @param {string|number} outputToken - Output token ID
 * @param {string|number|BigInt} totalAmount - Total input amount
 * @param {number} slippage - Slippage tolerance
 * @param {string} address - Optional address for pool info calls
 * @returns {Promise<Object>} { splitDetails: Array, platformFee: Object|null }
 *   splitDetails: Array of split details: { poolCfg, amount, expectedOutput, minOutput, quote }
 *   platformFee: { feeAmount: string, feeAddress: string, gain: string, feeBps: number } or null
 */
async function calculateOptimalSplit(matchingPools, inputToken, outputToken, totalAmount, slippage, address = '') {
  if (matchingPools.length === 0) {
    throw new Error('No matching pools found');
  }
  
  const totalAmountBigInt = BigInt(totalAmount);
  
  // Fetch pool info once per pool to avoid redundant Info() calls
  // This is especially important for HumbleSwap pools during grid search optimization
  const poolInfoCache = new Map();
  
  async function getPoolInfo(poolCfg) {
    const poolId = String(poolCfg.poolId);
    if (poolInfoCache.has(poolId)) {
      return poolInfoCache.get(poolId);
    }
    
    const dex = poolCfg.dex || 'humbleswap';
    if (dex === 'humbleswap') {
      // Fetch HumbleSwap pool info once using humbleswap module
      const info = await getHumbleswapPoolInfo(Number(poolCfg.poolId), algodClient, indexerClient, poolCfg, address);
      poolInfoCache.set(poolId, info);
      return info;
    } else if (dex === 'nomadex') {
      // Fetch Nomadex pool info once and cache it
      const poolInfo = await getNomadexPoolInfo(Number(poolCfg.poolId), algodClient, indexerClient, poolCfg);
      poolInfoCache.set(poolId, poolInfo);
      return poolInfo;
    }
    return null;
  }
  
  // Pre-fetch pool info for ALL pools (both HumbleSwap and Nomadex)
  await Promise.all(
    matchingPools.map(poolCfg => {
      return getPoolInfo(poolCfg).catch((err) => {
        console.warn(`Failed to fetch pool info for pool ${poolCfg.poolId} (${poolCfg.dex || 'humbleswap'}):`, err.message);
        return null;
      });
    })
  );
  
  // If only one pool, use it entirely (no platform fee for single pool)
  if (matchingPools.length === 1) {
    const poolCfg = matchingPools[0];
    const cachedInfo = poolInfoCache.get(String(poolCfg.poolId)) || null;
    const quote = await calculateQuoteForPool(poolCfg, inputToken, outputToken, totalAmount, slippage, address, cachedInfo);
    return {
      splitDetails: [{
        poolCfg,
        amount: totalAmountBigInt.toString(),
        expectedOutput: quote.outputAmount,
        minOutput: quote.minimumOutputAmount,
        quote
      }],
      platformFee: getDefaultPlatformFee()
    };
  }
  
  // For multiple pools, find optimal split using mathematical optimization
  const numPools = matchingPools.length;
  
  // For 2 pools, use binary search to find optimal split mathematically
  if (numPools === 2) {
    // Re-fetch pool configs using getPoolConfigById to match working endpoint pattern
    const poolCfg1 = getPoolConfigById(matchingPools[0].poolId);
    const poolCfg2 = getPoolConfigById(matchingPools[1].poolId);
    
    if (!poolCfg1 || !poolCfg2) {
      throw new Error('Failed to reload pool configs');
    }
    
    // Get cached pool info - for HumbleSwap it's the full Info() result, for Nomadex it's the poolInfo object
    const cachedInfo1 = poolInfoCache.get(String(poolCfg1.poolId)) || null;
    const cachedInfo2 = poolInfoCache.get(String(poolCfg2.poolId)) || null;
    
    // Test both pools with full amount to see if they work
    const fullQuote1 = await calculateQuoteForPool(poolCfg1, inputToken, outputToken, totalAmount, slippage, address, cachedInfo1).catch((err) => {
      console.warn(`Pool ${poolCfg1.poolId} (${poolCfg1.dex || 'humbleswap'}) failed to calculate quote:`, err.message);
      return null;
    });
    const fullQuote2 = await calculateQuoteForPool(poolCfg2, inputToken, outputToken, totalAmount, slippage, address, cachedInfo2).catch((err) => {
      console.warn(`Pool ${poolCfg2.poolId} (${poolCfg2.dex || 'humbleswap'}) failed to calculate quote:`, err.message);
      return null;
    });
    
    if (!fullQuote1 && !fullQuote2) {
      throw new Error('Both pools failed to calculate quotes');
    }
    
    // If only one pool works, use it entirely (no platform fee for single pool)
    if (!fullQuote1) {
      return {
        splitDetails: [{
          poolCfg: poolCfg2,
          amount: totalAmountBigInt.toString(),
          expectedOutput: fullQuote2.outputAmount,
          minOutput: fullQuote2.minimumOutputAmount,
          quote: fullQuote2
        }],
        platformFee: getDefaultPlatformFee()
      };
    }
    if (!fullQuote2) {
      return {
        splitDetails: [{
          poolCfg: poolCfg1,
          amount: totalAmountBigInt.toString(),
          expectedOutput: fullQuote1.outputAmount,
          minOutput: fullQuote1.minimumOutputAmount,
          quote: fullQuote1
        }],
        platformFee: getDefaultPlatformFee()
      };
    }
    
    // Both pools work - calculate optimal split mathematically

    // Extract pool reserves and fees from cached info or quotes. We also build a
    // per-pool output closure (out1Fn/out2Fn) that reproduces each pool's EXACT
    // on-chain output using the corrected per-DEX formula (Nomadex uses the raw
    // fee-scale curve; HumbleSwap uses the fee-adjusted-input curve). These feed
    // the curve-exact split refinement below, so the split seed is optimized
    // against the true curves for Nomadex-only, HumbleSwap-only, and mixed pairs.
    let r1In, r1Out, f1, r2In, r2Out, f2;
    let out1Fn, out2Fn;

    if (poolCfg1.dex === 'nomadex') {
      const poolInfo1 = cachedInfo1;
      const isDirectionAlphaToBeta1 = Number(inputToken) === poolInfo1.tokA && Number(outputToken) === poolInfo1.tokB;
      r1In = BigInt(isDirectionAlphaToBeta1 ? poolInfo1.reserveA : poolInfo1.reserveB);
      r1Out = BigInt(isDirectionAlphaToBeta1 ? poolInfo1.reserveB : poolInfo1.reserveA);
      // Prefer the live on-chain fee; a config fee is only an operator override.
      f1 = resolveFee(poolCfg1.fee, poolInfo1.fee);
      const feeScale1 = resolveNomadexFeeScale(poolCfg1, poolInfo1, poolCfg1.poolId);
      out1Fn = (x) => calculateNomadexOutput(x, r1In, r1Out, feeScale1);
    } else {
      // HumbleSwap
      const poolInfo1 = cachedInfo1;
      const swapAForB1 = fullQuote1.poolInfo.swapAForB;
      r1In = BigInt(swapAForB1 ? poolInfo1.poolBals.A : poolInfo1.poolBals.B);
      r1Out = BigInt(swapAForB1 ? poolInfo1.poolBals.B : poolInfo1.poolBals.A);
      // Prefer the live on-chain fee; a config fee is only an operator override.
      f1 = resolveFee(poolCfg1.fee, poolInfo1.protoInfo.totFee);
      out1Fn = (x) => calculateHumbleswapOutput(x, r1In, r1Out, f1);
    }

    if (poolCfg2.dex === 'nomadex') {
      const poolInfo2 = cachedInfo2;
      const isDirectionAlphaToBeta2 = Number(inputToken) === poolInfo2.tokA && Number(outputToken) === poolInfo2.tokB;
      r2In = BigInt(isDirectionAlphaToBeta2 ? poolInfo2.reserveA : poolInfo2.reserveB);
      r2Out = BigInt(isDirectionAlphaToBeta2 ? poolInfo2.reserveB : poolInfo2.reserveA);
      // Prefer the live on-chain fee; a config fee is only an operator override.
      f2 = resolveFee(poolCfg2.fee, poolInfo2.fee);
      const feeScale2 = resolveNomadexFeeScale(poolCfg2, poolInfo2, poolCfg2.poolId);
      out2Fn = (y) => calculateNomadexOutput(y, r2In, r2Out, feeScale2);
    } else {
      // HumbleSwap
      const poolInfo2 = cachedInfo2;
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
          calculateQuoteForPool(poolCfg1, inputToken, outputToken, testCase.p1Amount.toString(), slippage, address, cachedInfo1).catch(() => null),
          calculateQuoteForPool(poolCfg2, inputToken, outputToken, testCase.p2Amount.toString(), slippage, address, cachedInfo2).catch(() => null)
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
          const feeAmount = (gain * BigInt(feeBps)) / BigInt(10000);
          
          if (feeAmount > 0n) {
            // Subtract fee from output amounts
            const totalOutput = multiPoolOutput;
            const totalMinOutput = bestSplit.reduce((sum, split) => sum + BigInt(split.minOutput), 0n);
            
            // Calculate proportional fee deduction from each split
            for (const split of bestSplit) {
              const splitOutput = BigInt(split.expectedOutput);
              const splitMinOutput = BigInt(split.minOutput);
              const splitFeeAmount = (feeAmount * splitOutput) / totalOutput;
              const splitMinFeeAmount = (feeAmount * splitMinOutput) / totalOutput;
              
              split.expectedOutput = (splitOutput - splitFeeAmount).toString();
              split.minOutput = (splitMinOutput - splitMinFeeAmount).toString();
            }
            
            platformFee.feeAmount = feeAmount.toString();
            platformFee.applied = true;
          }
        }
      }
      
      return {
        splitDetails: bestSplit,
        platformFee: platformFee
      };
    }
    
    // Fallback: use the pool with better full quote (no platform fee for single pool)
    if (BigInt(fullQuote1.outputAmount) > BigInt(fullQuote2.outputAmount)) {
      return {
        splitDetails: [{
          poolCfg: poolCfg1,
          amount: totalAmountBigInt.toString(),
          expectedOutput: fullQuote1.outputAmount,
          minOutput: fullQuote1.minimumOutputAmount,
          quote: fullQuote1
        }],
        platformFee: getDefaultPlatformFee()
      };
    } else {
      return {
        splitDetails: [{
          poolCfg: poolCfg2,
          amount: totalAmountBigInt.toString(),
          expectedOutput: fullQuote2.outputAmount,
          minOutput: fullQuote2.minimumOutputAmount,
          quote: fullQuote2
        }],
        platformFee: getDefaultPlatformFee()
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
            const cachedInfo = poolInfoCache.get(String(pool.poolId)) || null;
            return calculateQuoteForPool(pool, inputToken, outputToken, amounts[idx].toString(), slippage, address, cachedInfo).catch(() => null);
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
          const cachedInfo = poolInfoCache.get(String(pool.poolId)) || null;
          return calculateQuoteForPool(pool, inputToken, outputToken, totalAmount, slippage, address, cachedInfo)
            .then(quote => ({ pool, quote }))
            .catch(() => null);
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
      
      return {
        splitDetails: [{
          poolCfg: best.pool,
          amount: totalAmountBigInt.toString(),
          expectedOutput: best.quote.outputAmount,
          minOutput: best.quote.minimumOutputAmount,
          quote: best.quote
        }],
        platformFee: getDefaultPlatformFee()
      };
    }
    
    // Calculate platform fee for multi-pool route (3+ pools)
    const multiPoolOutput = bestSplit.reduce((sum, split) => sum + BigInt(split.expectedOutput), 0n);
    
    // Calculate best single-pool output by testing each pool with full amount
    const singlePoolQuotes = await Promise.all(
      matchingPools.map(pool => {
        const cachedInfo = poolInfoCache.get(String(pool.poolId)) || null;
        return calculateQuoteForPool(pool, inputToken, outputToken, totalAmount, slippage, address, cachedInfo)
          .then(quote => BigInt(quote.outputAmount))
          .catch(() => 0n);
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
        const feeAmount = (gain * BigInt(feeBps)) / BigInt(10000);
        
        if (feeAmount > 0n) {
          // Subtract fee from output amounts
          const totalOutput = multiPoolOutput;
          const totalMinOutput = bestSplit.reduce((sum, split) => sum + BigInt(split.minOutput), 0n);
          
          // Calculate proportional fee deduction from each split
          for (const split of bestSplit) {
            const splitOutput = BigInt(split.expectedOutput);
            const splitMinOutput = BigInt(split.minOutput);
            const splitFeeAmount = (feeAmount * splitOutput) / totalOutput;
            const splitMinFeeAmount = (feeAmount * splitMinOutput) / totalOutput;
            
            split.expectedOutput = (splitOutput - splitFeeAmount).toString();
            split.minOutput = (splitMinOutput - splitMinFeeAmount).toString();
          }
          
          platformFee.feeAmount = feeAmount.toString();
          platformFee.applied = true;
        }
      }
    }
    
    return {
      splitDetails: bestSplit,
      platformFee: platformFee
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
 * @returns {Promise<Object>} Quote data with outputAmount, rate, priceImpact, route details
 */
async function calculateMultiHopQuote(route, inputToken, outputToken, amount, slippage, address = '') {
  const { pools, poolOptions, intermediateTokens } = route;
  const totalAmountBigInt = BigInt(amount);
  
  // Determine if we have single pools or pool options for each hop
  const hasPoolOptions = poolOptions && Array.isArray(poolOptions) && poolOptions.length > 0;
  const hasPools = pools && Array.isArray(pools) && pools.length > 0;
  
  if (!hasPoolOptions && !hasPools) {
    throw new Error('Route has no pools or poolOptions');
  }
  
  const numHops = hasPoolOptions ? poolOptions.length : pools.length;
  
  // Fetch pool info once per pool to avoid redundant calls
  const poolInfoCache = new Map();
  
  async function getPoolInfo(poolCfg) {
    const poolId = String(poolCfg.poolId);
    if (poolInfoCache.has(poolId)) {
      return poolInfoCache.get(poolId);
    }
    
    const dex = poolCfg.dex || 'humbleswap';
    if (dex === 'humbleswap') {
      const info = await getHumbleswapPoolInfo(Number(poolCfg.poolId), algodClient, indexerClient, poolCfg, address);
      poolInfoCache.set(poolId, info);
      return info;
    } else if (dex === 'nomadex') {
      const poolInfo = await getNomadexPoolInfo(Number(poolCfg.poolId), algodClient, indexerClient, poolCfg);
      poolInfoCache.set(poolId, poolInfo);
      return poolInfo;
    }
    return null;
  }
  
  // Pre-fetch pool info for all pools
  const allPools = hasPoolOptions 
    ? poolOptions.flat() 
    : pools;
  
  await Promise.all(
    allPools.map(poolCfg => {
      return getPoolInfo(poolCfg).catch((err) => {
        console.warn(`Failed to fetch pool info for pool ${poolCfg.poolId} (${poolCfg.dex || 'humbleswap'}):`, err.message);
        return null;
      });
    })
  );
  
  // Calculate quotes for each hop sequentially, with optional splitting
  const hopQuotes = [];
  let currentInputToken = Number(inputToken);
  let currentAmount = totalAmountBigInt;

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
        address
      );
      
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
      const cachedInfo = poolInfoCache.get(String(poolCfg.poolId)) || null;

      // Calculate quote for this hop (using hopSlippage - 0 for intermediate, user's slippage for final)
      const quote = await calculateQuoteForPool(
        poolCfg,
        currentInputToken,
        currentOutputToken,
        currentAmount.toString(),
        hopSlippage,
        address,
        cachedInfo
      );
      
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
    route: route
  };
}

/**
 * Calculate the number of hops for a route
 * @param {Object} route - Route object
 * @returns {number} Number of hops
 */
function getRouteHops(route) {
  if (route.poolOptions && Array.isArray(route.poolOptions)) {
    return route.poolOptions.length;
  }
  if (route.pools && Array.isArray(route.pools)) {
    return route.pools.length;
  }
  if (route.hops !== undefined) {
    return route.hops;
  }
  return 1; // Default to 1 hop if unknown
}

/**
 * Estimate transaction count for a route based on splitDetails
 * This is a conservative estimate to avoid exceeding Algorand's 16 transaction limit
 * @param {Array<Object>} splitDetails - Array of split details
 * @returns {number} Estimated transaction count
 */
function estimateTransactionCount(splitDetails) {
  if (!splitDetails || splitDetails.length === 0) {
    return 0;
  }
  
  // Detect if this is a multi-hop route
  const isMultiHop = splitDetails[0].inputToken !== undefined;
  
  let estimatedCount = 0;
  const seenTokens = new Set();
  
  for (const split of splitDetails) {
    const dex = split.poolCfg?.dex || 'humbleswap';
    const inputToken = split.inputToken !== undefined ? String(split.inputToken) : null;
    const outputToken = split.outputToken !== undefined ? String(split.outputToken) : null;
    
    // Base transaction count per pool swap
    // Nomadex: typically 1-2 transactions (simple swaps)
    // HumbleSwap: typically 3-5 transactions (depends on wrapping, deposit/withdraw needs)
    let splitCount = dex === 'nomadex' ? 2 : 4;
    
    // For multi-hop routes, add overhead for intermediate token handling
    // Each hop may need additional transactions for token transfers
    if (isMultiHop) {
      // Track unique tokens to estimate wrapping/unwrapping overhead
      if (inputToken && !seenTokens.has(inputToken)) {
        seenTokens.add(inputToken);
        // First time seeing this token might need wrapping
        if (inputToken !== '0') { // Not native VOI
          splitCount += 1;
        }
      }
      if (outputToken && !seenTokens.has(outputToken)) {
        seenTokens.add(outputToken);
        // First time seeing this token might need unwrapping
        if (outputToken !== '0') { // Not native VOI
          splitCount += 1;
        }
      }
    }
    
    estimatedCount += splitCount;
  }
  
  // For cross-route splits, we have multiple independent routes
  // Each route may need coordination, but we're already counting all splits above
  // Add a small overhead for grouping multiple routes together
  // This is conservative - actual count may be lower due to optimizations
  return estimatedCount;
}

/**
 * Calculate optimal split across multiple routes (direct and/or multi-hop)
 * Uses mathematical optimization for 2 routes, grid search for 3+ routes
 * @param {Array<Object>} routes - Array of route objects with same input/output tokens
 * @param {string|number} inputToken - Input token ID (underlying token)
 * @param {string|number} outputToken - Output token ID (underlying token)
 * @param {string|number|BigInt} totalAmount - Total input amount
 * @param {number} slippage - Slippage tolerance
 * @param {string} address - Optional address for pool info calls
 * @returns {Promise<Object|null>} { splitDetails: Array, quote: Object, totalHops: number } or null if invalid
 */
async function calculateOptimalRouteSplit(routes, inputToken, outputToken, totalAmount, slippage, address = '') {
  if (!routes || routes.length < 2) {
    return null;
  }
  
  const totalAmountBigInt = BigInt(totalAmount);

  // Token decimals for the normalized overall rate (shared helper), fetched
  // once so both the 2-route and 3+-route branches report a consistent rate.
  const inputDecimals = await getTokenDecimals(inputToken);
  const outputDecimals = await getTokenDecimals(outputToken);

  // Calculate total hops across all routes
  const routeHops = routes.map(route => getRouteHops(route));
  const totalHops = routeHops.reduce((sum, hops) => sum + hops, 0);
  
  // Enforce 4 hops/splits total limit
  if (totalHops > 4) {
    if (DEBUG) console.log(`[calculateOptimalRouteSplit] Total hops ${totalHops} exceeds limit of 4, skipping cross-route split`);
    return null;
  }
  
  if (DEBUG) console.log(`[calculateOptimalRouteSplit] Evaluating split across ${routes.length} route(s) with total ${totalHops} hops`);
  
  const numRoutes = routes.length;
  
  // For 2 routes, use mathematical optimization
  if (numRoutes === 2) {
    const [route1, route2] = routes;
    
    // Sample each route at multiple input amounts to build output curves
    // We'll evaluate at 0%, 25%, 50%, 75%, 100% to approximate the curve
    const samplePoints = [0n, totalAmountBigInt / 4n, totalAmountBigInt / 2n, (totalAmountBigInt * 3n) / 4n, totalAmountBigInt];
    
    // Evaluate route1 at sample points
    const route1Samples = [];
    for (const sampleAmount of samplePoints) {
      if (sampleAmount === 0n) {
        route1Samples.push({ input: 0n, output: 0n });
      } else {
        try {
          const quote = await calculateMultiHopQuote(route1, inputToken, outputToken, sampleAmount.toString(), slippage, address);
          route1Samples.push({ input: sampleAmount, output: BigInt(quote.outputAmount) });
        } catch (error) {
          console.warn(`[calculateOptimalRouteSplit] Failed to sample route1 at ${sampleAmount.toString()}:`, error.message);
          return null;
        }
      }
    }
    
    // Evaluate route2 at sample points
    const route2Samples = [];
    for (const sampleAmount of samplePoints) {
      if (sampleAmount === 0n) {
        route2Samples.push({ input: 0n, output: 0n });
      } else {
        try {
          const quote = await calculateMultiHopQuote(route2, inputToken, outputToken, sampleAmount.toString(), slippage, address);
          route2Samples.push({ input: sampleAmount, output: BigInt(quote.outputAmount) });
        } catch (error) {
          console.warn(`[calculateOptimalRouteSplit] Failed to sample route2 at ${sampleAmount.toString()}:`, error.message);
          return null;
        }
      }
    }
    
    // Find optimal split by testing multiple ratios
    // Use iterative refinement: start with equal split, then refine based on marginal rates
    let bestSplit = null;
    let bestTotalOutput = 0n;
    
    // Test edge cases and several split ratios
    const testRatios = [
      { r1: 0n, r2: totalAmountBigInt, name: '100% route2' },
      { r1: totalAmountBigInt / 4n, r2: (totalAmountBigInt * 3n) / 4n, name: '25/75 split' },
      { r1: totalAmountBigInt / 3n, r2: (totalAmountBigInt * 2n) / 3n, name: '33/67 split' },
      { r1: totalAmountBigInt / 2n, r2: totalAmountBigInt / 2n, name: '50/50 split' },
      { r1: (totalAmountBigInt * 2n) / 3n, r2: totalAmountBigInt / 3n, name: '67/33 split' },
      { r1: (totalAmountBigInt * 3n) / 4n, r2: totalAmountBigInt / 4n, name: '75/25 split' },
      { r1: totalAmountBigInt, r2: 0n, name: '100% route1' }
    ];
    
    // Refine using marginal rate approximation
    // Calculate approximate marginal rates from samples
    const getMarginalRate = (samples, amount) => {
      // Find the two sample points that bracket the amount
      for (let i = 0; i < samples.length - 1; i++) {
        if (samples[i].input <= amount && amount <= samples[i + 1].input) {
          const inputDiff = Number(samples[i + 1].input - samples[i].input);
          const outputDiff = Number(samples[i + 1].output - samples[i].output);
          if (inputDiff > 0) {
            return outputDiff / inputDiff; // Marginal rate (output per input)
          }
        }
      }
      return 0;
    };
    
    // Use iterative refinement: find where marginal rates are approximately equal
    let refinedR1 = totalAmountBigInt / 2n;
    for (let iter = 0; iter < 5; iter++) {
      const r1Num = Number(refinedR1);
      const r2Num = Number(totalAmountBigInt - refinedR1);
      
      const mr1 = getMarginalRate(route1Samples, refinedR1);
      const mr2 = getMarginalRate(route2Samples, totalAmountBigInt - refinedR1);
      
      if (Math.abs(mr1 - mr2) < 0.0001 || mr1 === 0 || mr2 === 0) {
        break; // Rates are approximately equal or we can't refine further
      }
      
      // Adjust split based on which route has higher marginal rate
      const adjustment = totalAmountBigInt / 20n; // 5% adjustment
      if (mr1 > mr2) {
        refinedR1 = refinedR1 + adjustment;
      } else {
        refinedR1 = refinedR1 - adjustment;
      }
      
      // Clamp to valid range
      const minAmount = totalAmountBigInt / 1000n; // 0.1% minimum
      if (refinedR1 < minAmount) {
        refinedR1 = minAmount;
      } else if (refinedR1 > totalAmountBigInt - minAmount) {
        refinedR1 = totalAmountBigInt - minAmount;
      }
    }
    
    // Add refined split to test cases
    testRatios.push({ r1: refinedR1, r2: totalAmountBigInt - refinedR1, name: 'refined split' });
    
    // Test all split ratios
    for (const testRatio of testRatios) {
      const r1Amount = testRatio.r1;
      const r2Amount = testRatio.r2;
      
      // Skip if amounts are too small
      const minAmount = totalAmountBigInt / 1000n;
      if (r1Amount > 0n && r1Amount < minAmount) continue;
      if (r2Amount > 0n && r2Amount < minAmount) continue;
      
      try {
        let quote1 = null;
        let quote2 = null;
        
        if (r1Amount > 0n) {
          quote1 = await calculateMultiHopQuote(route1, inputToken, outputToken, r1Amount.toString(), slippage, address);
        }
        if (r2Amount > 0n) {
          quote2 = await calculateMultiHopQuote(route2, inputToken, outputToken, r2Amount.toString(), slippage, address);
        }
        
        const totalOutput = (quote1 ? BigInt(quote1.outputAmount) : 0n) + (quote2 ? BigInt(quote2.outputAmount) : 0n);
        
        if (totalOutput > bestTotalOutput) {
          bestTotalOutput = totalOutput;
          
          // Build split details
          const splitDetails = [];
          if (quote1) {
            // Convert route1 quote to split details format
            for (const hopQuote of quote1.hopQuotes) {
              if (hopQuote.isSplit && hopQuote.splitDetails) {
                for (const split of hopQuote.splitDetails) {
                  splitDetails.push({
                    poolCfg: split.poolCfg,
                    amount: split.inputAmount,
                    expectedOutput: split.outputAmount,
                    minOutput: split.minimumOutputAmount,
                    quote: split.quote,
                    inputToken: split.inputToken,
                    outputToken: split.outputToken
                  });
                }
              } else {
                splitDetails.push({
                  poolCfg: hopQuote.poolCfg,
                  amount: hopQuote.inputAmount,
                  expectedOutput: hopQuote.outputAmount,
                  minOutput: hopQuote.minimumOutputAmount,
                  quote: hopQuote.quote,
                  inputToken: hopQuote.inputToken,
                  outputToken: hopQuote.outputToken
                });
              }
            }
          }
          if (quote2) {
            // Convert route2 quote to split details format
            for (const hopQuote of quote2.hopQuotes) {
              if (hopQuote.isSplit && hopQuote.splitDetails) {
                for (const split of hopQuote.splitDetails) {
                  splitDetails.push({
                    poolCfg: split.poolCfg,
                    amount: split.inputAmount,
                    expectedOutput: split.outputAmount,
                    minOutput: split.minimumOutputAmount,
                    quote: split.quote,
                    inputToken: split.inputToken,
                    outputToken: split.outputToken
                  });
                }
              } else {
                splitDetails.push({
                  poolCfg: hopQuote.poolCfg,
                  amount: hopQuote.inputAmount,
                  expectedOutput: hopQuote.outputAmount,
                  minOutput: hopQuote.minimumOutputAmount,
                  quote: hopQuote.quote,
                  inputToken: hopQuote.inputToken,
                  outputToken: hopQuote.outputToken
                });
              }
            }
          }
          
          bestSplit = {
            splitDetails,
            quote: {
              outputAmount: totalOutput.toString(),
              minimumOutputAmount: ((quote1 ? BigInt(quote1.minimumOutputAmount) : 0n) + (quote2 ? BigInt(quote2.minimumOutputAmount) : 0n)).toString(),
              rate: calculateRate(totalOutput, totalAmountBigInt, inputDecimals, outputDecimals),
              priceImpact: (quote1 ? quote1.priceImpact : 0) + (quote2 ? quote2.priceImpact : 0),
              hopQuotes: [
                ...(quote1 ? quote1.hopQuotes : []),
                ...(quote2 ? quote2.hopQuotes : [])
              ],
              splitDetails: splitDetails // Include splitDetails for handlers.js
            },
            totalHops
          };
        }
      } catch (error) {
        console.warn(`[calculateOptimalRouteSplit] Failed to evaluate split ${testRatio.name}:`, error.message);
        continue;
      }
    }
    
    if (bestSplit) {
      if (DEBUG) console.log(`[calculateOptimalRouteSplit] Best cross-route split output: ${bestTotalOutput.toString()}`);
      return bestSplit;
    }
    
    return null;
  } else {
    // For 3+ routes, use grid search with predefined split ratios
    let bestSplit = null;
    let bestTotalOutput = 0n;
    
    // Grid search over candidate split ratios sized to the actual route count.
    const splits = generateSplitRatios(numRoutes);

    for (const split of splits) {
      const amounts = allocateAmounts(totalAmountBigInt, split);

      // Skip only if a NON-ZERO allocation is dust; zero allocations are valid.
      if (amounts.some(a => a > 0n && a < totalAmountBigInt / 1000n)) {
        continue;
      }

      try {
        const quotes = await Promise.all(
          routes.map((route, idx) => {
            if (amounts[idx] === 0n) return null;
            return calculateMultiHopQuote(route, inputToken, outputToken, amounts[idx].toString(), slippage, address).catch(() => null);
          })
        );

        // Valid only if every funded route produced a quote; otherwise the
        // failed route's allocation would be stranded on execution.
        const allFundedQuoted = quotes.every((q, idx) => amounts[idx] === 0n || q !== null);
        if (allFundedQuoted) {
          const totalOutput = quotes.reduce((sum, q) => sum + (q ? BigInt(q.outputAmount) : 0n), 0n);
          if (totalOutput > bestTotalOutput) {
            bestTotalOutput = totalOutput;
            
            // Build split details from all routes
            const splitDetails = [];
            let totalMinOutput = 0n;
            let totalPriceImpact = 0;
            const allHopQuotes = [];
            
            for (let idx = 0; idx < quotes.length; idx++) {
              const quote = quotes[idx];
              if (!quote) continue;
              
              totalMinOutput += BigInt(quote.minimumOutputAmount);
              totalPriceImpact += quote.priceImpact;
              allHopQuotes.push(...quote.hopQuotes);
              
              // Convert quote to split details format
              for (const hopQuote of quote.hopQuotes) {
                if (hopQuote.isSplit && hopQuote.splitDetails) {
                  for (const splitDetail of hopQuote.splitDetails) {
                    splitDetails.push({
                      poolCfg: splitDetail.poolCfg,
                      amount: splitDetail.inputAmount,
                      expectedOutput: splitDetail.outputAmount,
                      minOutput: splitDetail.minimumOutputAmount,
                      quote: splitDetail.quote,
                      inputToken: splitDetail.inputToken,
                      outputToken: splitDetail.outputToken
                    });
                  }
                } else {
                  splitDetails.push({
                    poolCfg: hopQuote.poolCfg,
                    amount: hopQuote.inputAmount,
                    expectedOutput: hopQuote.outputAmount,
                    minOutput: hopQuote.minimumOutputAmount,
                    quote: hopQuote.quote,
                    inputToken: hopQuote.inputToken,
                    outputToken: hopQuote.outputToken
                  });
                }
              }
            }
            
            bestSplit = {
              splitDetails,
              quote: {
                outputAmount: totalOutput.toString(),
                minimumOutputAmount: totalMinOutput.toString(),
                rate: calculateRate(totalOutput, totalAmountBigInt, inputDecimals, outputDecimals),
                priceImpact: totalPriceImpact,
                hopQuotes: allHopQuotes,
                splitDetails: splitDetails // Include splitDetails for handlers.js
              },
              totalHops
            };
          }
        }
      } catch (err) {
        console.warn(`[calculateOptimalRouteSplit] Failed to evaluate grid search split:`, err.message);
        continue;
      }
    }
    
    if (bestSplit) {
      if (DEBUG) console.log(`[calculateOptimalRouteSplit] Best cross-route split output: ${bestTotalOutput.toString()}`);
      return bestSplit;
    }
    
    return null;
  }
}

/**
 * Find the optimal multi-hop route by evaluating all pool combinations
 * @param {Array<Object>} routes - Array of route objects (may have poolOptions or be concrete routes)
 * @param {string|number} inputToken - Input token ID (underlying token)
 * @param {string|number} outputToken - Output token ID (underlying token)
 * @param {string|number|BigInt} amount - Input amount
 * @param {number} slippage - Slippage tolerance
 * @param {string} address - Optional address for pool info calls
 * @param {number} maxCombinations - Maximum number of combinations to evaluate per route (default: 100)
 * @returns {Promise<Object|null>} Best route quote: {route, quote} or null if no valid routes
 */
async function findOptimalMultiHopRoute(routes, inputToken, outputToken, amount, slippage, address = '', maxCombinations = 100) {
  if (!routes || routes.length === 0) {
    if (DEBUG) console.log('[findOptimalMultiHopRoute] No routes provided');
    return null;
  }

  if (DEBUG) console.log(`[findOptimalMultiHopRoute] Evaluating ${routes.length} route(s) for ${inputToken}->${outputToken}, amount: ${amount}`);
  
  let bestQuote = null;
  let bestRoute = null;
  let bestOutput = 0n;
  
  // Store all valid routes for cross-route splitting evaluation
  const validRoutes = [];
  
  // Evaluate each route (sorted by hops, shortest first)
  for (let routeIdx = 0; routeIdx < routes.length; routeIdx++) {
    const route = routes[routeIdx];
    
    // Check if route has poolOptions - if so, use it directly with splitting
    if (route.poolOptions && Array.isArray(route.poolOptions) && route.poolOptions.length > 0) {
      if (DEBUG) console.log(`[findOptimalMultiHopRoute] Route ${routeIdx + 1}: Has poolOptions, evaluating with per-hop splitting`);
      
      try {
        // Use route directly with poolOptions - calculateMultiHopQuote will handle splitting
        const quote = await calculateMultiHopQuote(
          route,
          inputToken,
          outputToken,
          amount,
          slippage,
          address
        );
        
        const output = BigInt(quote.outputAmount);
        if (DEBUG) console.log(`[findOptimalMultiHopRoute] Route ${routeIdx + 1} with splitting output: ${output.toString()}, current best: ${bestOutput.toString()}`);

        // Store for cross-route splitting
        validRoutes.push({ route, quote, output });

        // Track the best quote
        if (output > bestOutput) {
          if (DEBUG) console.log(`[findOptimalMultiHopRoute] New best! Updating from ${bestOutput.toString()} to ${output.toString()}`);
          bestOutput = output;
          bestQuote = quote;
          bestRoute = route; // Keep the route with poolOptions
        }
      } catch (error) {
        console.warn(`[findOptimalMultiHopRoute] Failed to calculate quote for route ${routeIdx + 1} with splitting:`, error.message);
        // Continue to try concrete routes as fallback
      }
    }
    
    // Also try concrete route combinations (for comparison)
    let concreteRoutes = [];
    if (route.pools && Array.isArray(route.pools) && route.pools.length > 0) {
      if (DEBUG) console.log(`[findOptimalMultiHopRoute] Route ${routeIdx + 1}: Also trying concrete route with ${route.pools.length} pools`);
      concreteRoutes = [route];
    } else if (route.poolOptions) {
      // Generate concrete combinations as fallback/comparison
      if (DEBUG) console.log(`[findOptimalMultiHopRoute] Route ${routeIdx + 1}: Generating concrete combinations for comparison`);
      concreteRoutes = generateRouteCombinations(route, maxCombinations);
    }

    if (concreteRoutes.length > 0) {
      if (DEBUG) console.log(`[findOptimalMultiHopRoute] Route ${routeIdx + 1}: Evaluating ${concreteRoutes.length} concrete combination(s)`);
      
      // Evaluate each concrete route combination
      for (let comboIdx = 0; comboIdx < concreteRoutes.length; comboIdx++) {
        const concreteRoute = concreteRoutes[comboIdx];
        try {
          const routeStr = concreteRoute.pools.map(p => `${p.poolId}(${p.dex || 'humbleswap'})`).join('->');
          if (DEBUG) console.log(`[findOptimalMultiHopRoute] Evaluating concrete combination ${comboIdx + 1}/${concreteRoutes.length}: ${routeStr}`);
          
          const quote = await calculateMultiHopQuote(
            concreteRoute,
            inputToken,
            outputToken,
            amount,
            slippage,
            address
          );
          
          const output = BigInt(quote.outputAmount);
          if (DEBUG) console.log(`[findOptimalMultiHopRoute] Concrete combination ${comboIdx + 1} output: ${output.toString()}, current best: ${bestOutput.toString()}`);
          
          // Store for cross-route splitting (use the best concrete route for each original route)
          // Only store if this is better than the poolOptions version or if poolOptions wasn't evaluated
          const existingRoute = validRoutes.find(vr => vr.route === route);
          if (!existingRoute || output > existingRoute.output) {
            const idx = validRoutes.findIndex(vr => vr.route === route);
            if (idx >= 0) {
              validRoutes[idx] = { route: concreteRoute, quote, output };
            } else {
              validRoutes.push({ route: concreteRoute, quote, output });
            }
          }
          
          // Track the best quote
          if (output > bestOutput) {
            if (DEBUG) console.log(`[findOptimalMultiHopRoute] New best! Updating from ${bestOutput.toString()} to ${output.toString()}`);
            bestOutput = output;
            bestQuote = quote;
            bestRoute = concreteRoute;
          }
        } catch (error) {
          // If one combination fails, continue with others
          console.warn(`[findOptimalMultiHopRoute] Failed to calculate quote for concrete combination ${comboIdx + 1}:`, error.message);
          continue;
        }
      }
    }
  }
  
  // After evaluating individual routes, check for cross-route splitting opportunities
  // All routes in validRoutes have the same input/output tokens, so we can try splitting
  /*if (validRoutes.length >= 2) {
    console.log(`[findOptimalMultiHopRoute] Found ${validRoutes.length} valid routes, evaluating cross-route split`);
    
    try {
      const crossRouteSplit = await calculateOptimalRouteSplit(
        validRoutes.map(vr => vr.route),
        inputToken,
        outputToken,
        amount,
        slippage,
        address
      );
      
      if (crossRouteSplit) {
        const crossRouteOutput = BigInt(crossRouteSplit.quote.outputAmount);
        console.log(`[findOptimalMultiHopRoute] Cross-route split output: ${crossRouteOutput.toString()}, current best: ${bestOutput.toString()}`);
        
        // Estimate transaction count for cross-route split
        const estimatedTxCount = estimateTransactionCount(crossRouteSplit.splitDetails);
        const MAX_TRANSACTIONS = 16; // Algorand transaction group limit
        
        if (estimatedTxCount > MAX_TRANSACTIONS) {
          console.log(`[findOptimalMultiHopRoute] Cross-route split would exceed transaction limit (estimated ${estimatedTxCount} > ${MAX_TRANSACTIONS}), skipping and using best single route`);
          // Don't use cross-route split, keep the best single route we found
        } else if (crossRouteOutput > bestOutput) {
          console.log(`[findOptimalMultiHopRoute] Cross-route split is best! Updating from ${bestOutput.toString()} to ${crossRouteOutput.toString()} (estimated ${estimatedTxCount} transactions)`);
          bestOutput = crossRouteOutput;
          bestQuote = crossRouteSplit.quote;
          // For cross-route splits, we create a synthetic route object
          bestRoute = {
            isCrossRouteSplit: true,
            routes: validRoutes.map(vr => vr.route),
            totalHops: crossRouteSplit.totalHops
          };
        }
      }
    } catch (error) {
      console.warn(`[findOptimalMultiHopRoute] Failed to calculate cross-route split:`, error.message);
      // Continue with single-route results
    }
  }*/
  
  if (bestQuote && bestRoute) {
    // Always show summary of selected route
    const hops = bestRoute.poolOptions?.length || bestRoute.pools?.length || 1;
    const poolCount = bestRoute.poolOptions
      ? bestRoute.poolOptions.reduce((sum, opts) => sum + opts.length, 0)
      : bestRoute.pools?.length || 1;
    console.log(`[Quote] ${inputToken} -> ${outputToken}: ${amount} in, ${bestOutput.toString()} out (${hops} hops, ${poolCount} pools)`);
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
  findOptimalMultiHopRoute
};

