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
  const T = Number(totalAmount);
  const R1_in = Number(r1In);
  const R1_out = Number(r1Out);
  const R2_in = Number(r2In);
  const R2_out = Number(r2Out);
  const F1 = 10000 - f1;
  const F2 = 10000 - f2;
  
  // Constants from the derivative equation
  const K1 = R1_out * F1 * R1_in * 10000;
  const K2 = R2_out * F2 * R2_in * 10000;
  const D1_base = R1_in * 10000;
  const D2_base = R2_in * 10000;
  
  // We need to solve: K1 / (D1_base + x * F1)^2 = K2 / (D2_base + (T-x) * F2)^2
  // Rearranging: K1 * (D2_base + (T-x) * F2)^2 = K2 * (D1_base + x * F1)^2
  // This is a quadratic equation in x
  
  // Expand: K1 * (D2_base^2 + 2*D2_base*(T-x)*F2 + (T-x)^2*F2^2) = K2 * (D1_base^2 + 2*D1_base*x*F1 + x^2*F1^2)
  // Let's solve this more directly using the square root approach:
  // sqrt(K1) * (D2_base + (T-x) * F2) = sqrt(K2) * (D1_base + x * F1)
  
  const sqrtK1 = Math.sqrt(K1);
  const sqrtK2 = Math.sqrt(K2);
  
  // sqrt(K1) * (D2_base + (T-x) * F2) = sqrt(K2) * (D1_base + x * F1)
  // sqrt(K1) * D2_base + sqrt(K1) * T * F2 - sqrt(K1) * x * F2 = sqrt(K2) * D1_base + sqrt(K2) * x * F1
  // sqrt(K1) * D2_base + sqrt(K1) * T * F2 - sqrt(K2) * D1_base = x * (sqrt(K2) * F1 + sqrt(K1) * F2)
  
  const leftSide = sqrtK1 * D2_base + sqrtK1 * T * F2 - sqrtK2 * D1_base;
  const rightSideCoeff = sqrtK2 * F1 + sqrtK1 * F2;
  
  if (rightSideCoeff === 0) {
    // Fallback to equal split if coefficients are invalid
    return BigInt(Math.floor(T / 2));
  }
  
  const x = leftSide / rightSideCoeff;
  
  // Clamp to valid range [0, T]
  const clampedX = Math.max(0, Math.min(T, x));
  
  return BigInt(Math.floor(clampedX));
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
  calculatePriceImpact
};

