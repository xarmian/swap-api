import { getTokenMetaFromConfig } from './config.js';
import { indexerClient } from './clients.js';

const decimalsCache = new Map();

async function getTokenDecimals(tokenId) {
  const key = String(tokenId);
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  const cfg = getTokenMetaFromConfig(key);
  if (cfg && typeof cfg.decimals === 'number') {
    decimalsCache.set(key, cfg.decimals);
    return cfg.decimals;
  }
  if (Number(key) === 0) {
    decimalsCache.set(key, 6);
    return 6;
  }
  try {
    const resp = await indexerClient.lookupAssetByID(Number(key)).do();
    const dec = resp && resp.asset && typeof resp.asset.params.decimals === 'number'
      ? resp.asset.params.decimals
      : 6;
    decimalsCache.set(key, dec);
    return dec;
  } catch (e) {
    // Fallback to 6
    decimalsCache.set(key, 6);
    return 6;
  }
}

/**
 * Compute a human-readable exchange rate normalized for token decimals.
 *   rate = (outputAmount / 10^outputDecimals) / (inputAmount / 10^inputDecimals)
 *        = (outputAmount * 10^inputDecimals) / (inputAmount * 10^outputDecimals)
 *
 * Computed entirely in BigInt with an 18-decimal scale factor so it preserves
 * fractional precision without truncating (a plain BigInt division would floor
 * the ratio to 0 for most pairs) and without 2^53 precision loss on large
 * amounts (never calls Number() on a raw token amount). This is the single
 * source of truth for the `rate` field so reported rates stay consistent across
 * every DEX branch and code path.
 *
 * @param {BigInt|string|number} outputAmount - Output token amount (base units)
 * @param {BigInt|string|number} inputAmount - Input token amount (base units)
 * @param {number} inputDecimals - Input token decimals
 * @param {number} outputDecimals - Output token decimals
 * @returns {number} Normalized rate (output per input, decimal-adjusted)
 */
function calculateRate(outputAmount, inputAmount, inputDecimals, outputDecimals) {
  const input = BigInt(inputAmount);
  if (input === 0n) return 0;
  const output = BigInt(outputAmount);
  const inputDecimalsMultiplier = 10n ** BigInt(inputDecimals);
  const outputDecimalsMultiplier = 10n ** BigInt(outputDecimals);
  const scaleFactor = 10n ** 18n; // 18 decimals of fractional precision
  const numerator = output * inputDecimalsMultiplier * scaleFactor;
  const denominator = input * outputDecimalsMultiplier;
  return Number(numerator / denominator) / Number(scaleFactor);
}

// Fixed-point scale for slippage quantization: 1e12 gives 1e-12 resolution on
// the tolerance, so the minimum-output floor honors the user's exact slippage
// (down to sub-base-unit error for any realistic amount) rather than snapping
// to whole basis points.
const SLIPPAGE_SCALE = 1000000000000n; // 1e12

/**
 * Apply a slippage tolerance to an output amount to derive the guaranteed
 * minimum output: floor(outputAmount * (1 - slippage)).
 *
 * The slippage fraction is quantized to SLIPPAGE_SCALE (1e-12) resolution and
 * the (1 - slippage) subtraction is done in BigInt, so the result is not
 * subject to the binary-float artifact where an expression like
 * (1 - 0.005) * 10000 evaluates to 9949.9999999999 and a naive Math.floor
 * shaves a whole basis point off the user's protection. Because the tolerance
 * is honored at 1e-12 resolution (not 1e-4 basis points), a fractional-bp
 * slippage like 0.504% is respected exactly instead of being snapped to 0.5%
 * (which would over-promise the minimum). The final BigInt division floors, the
 * standard minimum-output convention. The scaled slippage is clamped to
 * [0, SLIPPAGE_SCALE] so a malformed slippage can never produce a negative
 * factor / negative minimum.
 *
 * @param {BigInt|string|number} outputAmount - Expected output (base units)
 * @param {number} slippage - Slippage tolerance as a fraction (e.g. 0.01 = 1%)
 * @returns {BigInt} Guaranteed minimum output amount (base units)
 */
function applySlippageToOutput(outputAmount, slippage) {
  let slippageScaled = BigInt(Math.round(slippage * Number(SLIPPAGE_SCALE)));
  if (slippageScaled < 0n) slippageScaled = 0n;
  if (slippageScaled > SLIPPAGE_SCALE) slippageScaled = SLIPPAGE_SCALE;
  const factorScaled = SLIPPAGE_SCALE - slippageScaled;
  return (BigInt(outputAmount) * factorScaled) / SLIPPAGE_SCALE;
}

/**
 * Integer square root (floor(sqrt(n))) for non-negative BigInt values, via
 * Newton's method. Used to keep the optimal-split solve fully in BigInt so
 * reserves larger than 2^53 don't lose precision through Number().
 * @param {BigInt} n - non-negative BigInt
 * @returns {BigInt} floor(sqrt(n))
 */
function bigIntSqrt(n) {
  if (n < 0n) throw new Error('bigIntSqrt: negative input');
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

// AMM constant product formula helpers
function calculateOutputAmount(inputAmount, inputReserve, outputReserve, fee) {
  // fee is in basis points (e.g., 30 for 0.3%)
  const amountInWithFee = BigInt(inputAmount) * BigInt(10000 - fee);
  const numerator = amountInWithFee * BigInt(outputReserve);
  const denominator = BigInt(inputReserve) * BigInt(10000) + amountInWithFee;
  return numerator / denominator;
}

/**
 * Calculate optimal split between two AMM pools mathematically
 * Uses calculus to find the split that maximizes total output
 * 
 * For pool 1: output1(x) = (R1_out * x * (10000 - f1)) / (R1_in * 10000 + x * (10000 - f1))
 * For pool 2: output2(T-x) = (R2_out * (T-x) * (10000 - f2)) / (R2_in * 10000 + (T-x) * (10000 - f2))
 * 
 * We maximize: output1(x) + output2(T-x)
 * By setting derivative to zero, we get:
 * (R1_out * (10000 - f1) * R1_in * 10000) / (R1_in * 10000 + x * (10000 - f1))^2 = 
 * (R2_out * (10000 - f2) * R2_in * 10000) / (R2_in * 10000 + (T-x) * (10000 - f2))^2
 * 
 * Solving for x gives us the optimal split
 * 
 * @param {BigInt} totalAmount - Total amount to split
 * @param {BigInt} r1In - Pool 1 input reserve
 * @param {BigInt} r1Out - Pool 1 output reserve
 * @param {number} f1 - Pool 1 fee in basis points
 * @param {BigInt} r2In - Pool 2 input reserve
 * @param {BigInt} r2Out - Pool 2 output reserve
 * @param {number} f2 - Pool 2 fee in basis points
 * @returns {BigInt} Optimal amount for pool 1
 */
function calculateOptimalSplitAmount(totalAmount, r1In, r1Out, f1, r2In, r2Out, f2) {
  // Everything stays in BigInt: reserves can exceed 2^53, so converting to
  // Number here would silently lose precision on large pools. Only the two
  // per-pool fees (small integers in basis points) come in as Numbers.
  const T = BigInt(totalAmount);
  const R1_in = BigInt(r1In);
  const R1_out = BigInt(r1Out);
  const R2_in = BigInt(r2In);
  const R2_out = BigInt(r2Out);
  const F1 = BigInt(10000 - f1);
  const F2 = BigInt(10000 - f2);

  // Constants from the derivative equation
  const K1 = R1_out * F1 * R1_in * 10000n;
  const K2 = R2_out * F2 * R2_in * 10000n;
  const D1_base = R1_in * 10000n;
  const D2_base = R2_in * 10000n;

  // We solve: K1 / (D1_base + x * F1)^2 = K2 / (D2_base + (T-x) * F2)^2
  // Take the square root of both sides (all terms are non-negative):
  //   sqrt(K1) * (D2_base + (T-x) * F2) = sqrt(K2) * (D1_base + x * F1)
  // Rearranged for x:
  //   sqrt(K1)*D2_base + sqrt(K1)*T*F2 - sqrt(K2)*D1_base = x * (sqrt(K2)*F1 + sqrt(K1)*F2)
  // sqrt is floor-approximated (bigIntSqrt); the result is only a heuristic
  // seed, re-validated against exact BigInt outputs by the caller.
  const sqrtK1 = bigIntSqrt(K1);
  const sqrtK2 = bigIntSqrt(K2);

  const leftSide = sqrtK1 * D2_base + sqrtK1 * T * F2 - sqrtK2 * D1_base;
  const rightSideCoeff = sqrtK2 * F1 + sqrtK1 * F2;

  if (rightSideCoeff === 0n) {
    // Fallback to equal split if coefficients are invalid
    return T / 2n;
  }

  const x = leftSide / rightSideCoeff;

  // Clamp to valid range [0, T]
  if (x < 0n) return 0n;
  if (x > T) return T;
  return x;
}

/**
 * Calculates price impact for an AMM swap using the standard formula.
 * 
 * Price impact measures how much the pool's spot price changes due to a trade.
 * This uses the standard AMM approach: comparing spot prices before and after the trade.
 * 
 * Formula:
 * - Spot price before: outputReserve / inputReserve
 * - Spot price after: (outputReserve - outputAmount) / (inputReserve + inputAmount)
 * - Price impact: |(priceAfter - priceBefore) / priceBefore|
 * 
 * This is more accurate than comparing effective price vs spot price, as it directly
 * measures the change in the pool's price state.
 * 
 * @param {BigInt|string|number} inputAmount - Amount of input token being swapped
 * @param {BigInt|string|number} inputReserve - Current reserve of input token in pool
 * @param {BigInt|string|number} outputAmount - Amount of output token received (after fees)
 * @param {BigInt|string|number} outputReserve - Current reserve of output token in pool
 * @returns {number} Price impact as a decimal (e.g., 0.01 = 1% impact)
 */
function calculatePriceImpact(inputAmount, inputReserve, outputAmount, outputReserve) {
  // Convert BigInt values to Numbers for calculation
  const inputAmountNum = Number(inputAmount);
  const inputReserveNum = Number(inputReserve);
  const outputAmountNum = Number(outputAmount);
  const outputReserveNum = Number(outputReserve);

  // Validate inputs to prevent division by zero and invalid calculations
  if (inputReserveNum <= 0 || inputAmountNum <= 0 || outputAmountNum <= 0 || outputReserveNum <= 0) {
    return 0; // Return 0 impact for invalid inputs
  }

  // Calculate spot price before trade: outputReserve / inputReserve
  const spotPriceBefore = outputReserveNum / inputReserveNum;

  // Calculate spot price after trade: (outputReserve - outputAmount) / (inputReserve + inputAmount)
  // This represents the new pool price after the trade executes
  const newOutputReserve = outputReserveNum - outputAmountNum;
  const newInputReserve = inputReserveNum + inputAmountNum;

  // Validate post-trade reserves
  if (newOutputReserve <= 0 || newInputReserve <= 0) {
    return 0; // Return 0 impact if reserves would be invalid
  }

  const spotPriceAfter = newOutputReserve / newInputReserve;

  // Price impact = |(priceAfter - priceBefore) / priceBefore|
  // This measures the percentage change in the pool's spot price due to the trade
  const priceImpact = Math.abs((spotPriceAfter - spotPriceBefore) / spotPriceBefore);

  return priceImpact;
}

export {
  getTokenDecimals,
  calculateOutputAmount,
  calculateOptimalSplitAmount,
  calculatePriceImpact,
  calculateRate,
  applySlippageToOutput
};

