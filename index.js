import express from 'express';
import cors from 'cors';
import { swap200, CONTRACT, swap } from 'ulujs';
import algosdk from 'algosdk';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getPoolInfo as getNomadexPoolInfo,
  calculateOutputAmount as calculateNomadexOutput,
  buildSwapTransactions as buildNomadexSwapTransactions,
  getTokenTypeFromConfig
} from './lib/nomadex.js';

dotenv.config();

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Algorand clients (using Voi mainnet)
const algodClient = new algosdk.Algodv2(
  '',
  process.env.ALGOD_URL || 'https://mainnet-api.voi.nodely.dev',
  ''
);
const indexerClient = new algosdk.Indexer(
  '',
  process.env.INDEXER_URL || 'https://mainnet-idx.voi.nodely.dev',
  ''
);

// --- Config loading (local pools/tokens) ---

let poolsConfig = null;
let tokensConfig = null;
const decimalsCache = new Map();

function loadJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function loadConfigsOnce() {
  if (poolsConfig && tokensConfig) return;
  const poolsPath = path.join(__dirname, 'config', 'pools.json');
  const tokensPath = path.join(__dirname, 'config', 'tokens.json');
  poolsConfig = loadJSON(poolsPath);
  tokensConfig = loadJSON(tokensPath) || { tokens: {} };
  if (!poolsConfig || !Array.isArray(poolsConfig.pools)) {
    throw new Error('Invalid or missing config/pools.json');
  }
}

function getPoolConfigById(poolId) {
  loadConfigsOnce();
  const pid = Number(poolId);
  const found = poolsConfig.pools.find(p => Number(p.poolId) === pid);
  return found || null;
}

function getTokenMetaFromConfig(tokenId) {
  loadConfigsOnce();
  const t = tokensConfig.tokens[String(tokenId)];
  return t || null;
}

/**
 * Find matching pools for a given token pair
 * @param {string|number} inputToken - Input token ID (underlying token, not wrapped)
 * @param {string|number} outputToken - Output token ID (underlying token, not wrapped)
 * @param {Array<string>|undefined} dexFilter - Optional array of DEX names to filter by (e.g., ["humbleswap", "nomadex"])
 * @returns {Array<Object>} Array of matching pool configs
 */
function findMatchingPools(inputToken, outputToken, dexFilter) {
  loadConfigsOnce();
  const inputTokenStr = String(inputToken);
  const outputTokenStr = String(outputToken);
  const inputTokenNum = Number(inputToken);
  const outputTokenNum = Number(outputToken);
  
  const matchingPools = [];
  
  // Default to all DEXes if no filter provided
  const allowedDexes = dexFilter && Array.isArray(dexFilter) && dexFilter.length > 0
    ? dexFilter.map(d => String(d).toLowerCase())
    : ['humbleswap', 'nomadex'];
  
  for (const pool of poolsConfig.pools) {
    const poolDex = (pool.dex || 'humbleswap').toLowerCase();
    
    // Filter by DEX if specified
    if (!allowedDexes.includes(poolDex)) {
      continue;
    }
    
    let matches = false;
    
    if (poolDex === 'humbleswap') {
      // For HumbleSwap, check underlyingToWrapped mappings
      const u2w = pool.tokens?.underlyingToWrapped || {};
      
      // Try both string and number keys (JSON may have either)
      const inputWrapped = u2w[inputTokenStr] ?? u2w[inputTokenNum];
      const outputWrapped = u2w[outputTokenStr] ?? u2w[outputTokenNum];
      
      if (inputWrapped !== undefined && outputWrapped !== undefined) {
        // Check if wrapped pair matches pool's wrappedPair
        const wrappedPair = pool.tokens?.wrappedPair || {};
        const tokA = Number(wrappedPair.tokA);
        const tokB = Number(wrappedPair.tokB);
        
        const inputWrappedNum = Number(inputWrapped);
        const outputWrappedNum = Number(outputWrapped);
        
        // Check if the wrapped tokens form a valid pair in this pool
        const matchesPair =
          (inputWrappedNum === tokA && outputWrappedNum === tokB) ||
          (inputWrappedNum === tokB && outputWrappedNum === tokA);
        
        if (matchesPair) {
          matches = true;
        }
      }
    } else if (poolDex === 'nomadex') {
      // For Nomadex, check direct token IDs from config
      const tokA = pool.tokens?.tokA;
      const tokB = pool.tokens?.tokB;
      
      if (tokA && tokB) {
        const tokANum = Number(tokA.id);
        const tokBNum = Number(tokB.id);
        
        const matchesPair =
          (inputTokenNum === tokANum && outputTokenNum === tokBNum) ||
          (inputTokenNum === tokBNum && outputTokenNum === tokANum);
        
        if (matchesPair) {
          matches = true;
        }
      }
    }
    
    if (matches) {
      matchingPools.push(pool);
    }
  }
  
  return matchingPools;
}

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

// No external token lookup; use local config

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
    
    // Determine swap direction (alpha to beta = tokA to tokB)
    const isDirectionAlphaToBeta = inputTokenNum === poolInfo.tokA && outputTokenNum === poolInfo.tokB;
    const inputReserve = isDirectionAlphaToBeta ? poolInfo.reserveA : poolInfo.reserveB;
    const outputReserve = isDirectionAlphaToBeta ? poolInfo.reserveB : poolInfo.reserveA;
    
    // Calculate quote
    const outputAmount = calculateNomadexOutput(amountBigInt, inputReserve, outputReserve, poolInfo.fee);
    const minimumOutputAmount = (outputAmount * BigInt(Math.floor((1 - slippage) * 10000))) / BigInt(10000);
    const priceImpact = calculatePriceImpact(amountBigInt, inputReserve, outputAmount, outputReserve);
    const rate = Number(outputAmount) / Number(amountBigInt);
    
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
        fee: poolInfo.fee,
        isDirectionAlphaToBeta
      }
    };
  } else {
    // Handle HumbleSwap pool
    const u2w = poolCfg.tokens && poolCfg.tokens.underlyingToWrapped ? poolCfg.tokens.underlyingToWrapped : {};
    const inputWrapped = u2w[inputTokenStr];
    const outputWrapped = u2w[outputTokenStr];
    if (inputWrapped === undefined) {
      throw new Error(`No wrapped mapping for input token ${inputTokenStr} in pool ${poolId}`);
    }
    if (outputWrapped === undefined) {
      throw new Error(`No wrapped mapping for output token ${outputTokenStr} in pool ${poolId}`);
    }

    // Validate wrapped pair matches pool
    const pair = poolCfg.tokens.wrappedPair || {};
    const wrappedPairOk =
      (Number(pair.tokA) === Number(inputWrapped) && Number(pair.tokB) === Number(outputWrapped)) ||
      (Number(pair.tokA) === Number(outputWrapped) && Number(pair.tokB) === Number(inputWrapped));
    if (!wrappedPairOk) {
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
      // Create swap instance using ulujs swap class
      // Use placeholder address for pool info calls if address is not provided
      const poolContractId = String(poolCfg.poolId);
      const addressForInfo = address || algosdk.generateAccount().addr;
      const swapInstance = new swap(Number(poolContractId), algodClient, indexerClient, {
        acc: { addr: addressForInfo, sk: new Uint8Array(0) },
        simulate: true,
        formatBytes: true,
        waitForConfirmation: false
      });

      // Get pool info for quote calculation
      const infoResult = await swapInstance.Info();
      if (!infoResult.success) {
        throw new Error('Failed to fetch pool information: ' + JSON.stringify(infoResult.error));
      }
      
      poolInfo = infoResult.returnValue;
      poolBals = poolInfo.poolBals;
      protoInfo = poolInfo.protoInfo;
    }
    
    // Determine swap direction
    const swapAForB = Number(inputWrapped) === poolInfo.tokA && Number(outputWrapped) === poolInfo.tokB;
    const inputReserve = swapAForB ? poolBals.A : poolBals.B;
    const outputReserve = swapAForB ? poolBals.B : poolBals.A;
    
    // Calculate quote
    const totalFee = protoInfo.totFee;
    const outputAmount = calculateOutputAmount(amount, inputReserve, outputReserve, totalFee);
    const minimumOutputAmount = (outputAmount * BigInt(Math.floor((1 - slippage) * 10000))) / BigInt(10000);
    const priceImpact = calculatePriceImpact(amount, inputReserve, outputAmount, outputReserve);
    const rate = Number(outputAmount) / Number(amount);
    
    return {
      poolId: poolId.toString(),
      dex: 'humbleswap',
      outputAmount: outputAmount.toString(),
      minimumOutputAmount: minimumOutputAmount.toString(),
      rate: rate,
      priceImpact: priceImpact,
      poolInfo: {
        inputWrapped: Number(inputWrapped),
        outputWrapped: Number(outputWrapped),
        reserveA: inputReserve,
        reserveB: outputReserve,
        fee: totalFee,
        swapAForB
      }
    };
  }
}

/**
 * Calculate optimal split across multiple pools to maximize output
 * Uses iterative approach to find best allocation
 * @param {Array<Object>} matchingPools - Array of matching pool configs
 * @param {string|number} inputToken - Input token ID
 * @param {string|number} outputToken - Output token ID
 * @param {string|number|BigInt} totalAmount - Total input amount
 * @param {number} slippage - Slippage tolerance
 * @returns {Promise<Array<Object>>} Array of split details: { poolCfg, amount, expectedOutput, minOutput, quote }
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
      // Fetch HumbleSwap pool info once
      const poolContractId = Number(poolCfg.poolId);
      const addressForInfo = address || 'H7W63MIQJMYBOEYPM5NJEGX3P54H54RZIV2G3OQ2255AULG6U74BE5KFC4';
      const swapInstance = new swap(poolContractId, algodClient, indexerClient, {
        acc: { addr: addressForInfo, sk: new Uint8Array(0) },
        simulate: true,
        formatBytes: true,
        waitForConfirmation: false
      });
      
      const infoResult = await swapInstance.Info();
      if (!infoResult.success) {
        throw new Error('Failed to fetch pool information: ' + JSON.stringify(infoResult.error));
      }
      
      const info = infoResult.returnValue;
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
      return getPoolInfo(poolCfg).catch(() => null);
    })
  );
  
  // If only one pool, use it entirely
  if (matchingPools.length === 1) {
    const poolCfg = matchingPools[0];
    const cachedInfo = poolInfoCache.get(String(poolCfg.poolId)) || null;
    const quote = await calculateQuoteForPool(poolCfg, inputToken, outputToken, totalAmount, slippage, address, cachedInfo);
    return [{
      poolCfg,
      amount: totalAmountBigInt.toString(),
      expectedOutput: quote.outputAmount,
      minOutput: quote.minimumOutputAmount,
      quote
    }];
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
    const fullQuote1 = await calculateQuoteForPool(poolCfg1, inputToken, outputToken, totalAmount, slippage, address, cachedInfo1).catch(() => null);
    const fullQuote2 = await calculateQuoteForPool(poolCfg2, inputToken, outputToken, totalAmount, slippage, address, cachedInfo2).catch(() => null);
    
    if (!fullQuote1 && !fullQuote2) {
      throw new Error('Both pools failed to calculate quotes');
    }
    
    // If only one pool works, use it entirely
    if (!fullQuote1) {
      return [{
        poolCfg: poolCfg2,
        amount: totalAmountBigInt.toString(),
        expectedOutput: fullQuote2.outputAmount,
        minOutput: fullQuote2.minimumOutputAmount,
        quote: fullQuote2
      }];
    }
    if (!fullQuote2) {
      return [{
        poolCfg: poolCfg1,
        amount: totalAmountBigInt.toString(),
        expectedOutput: fullQuote1.outputAmount,
        minOutput: fullQuote1.minimumOutputAmount,
        quote: fullQuote1
      }];
    }
    
    // Both pools work - calculate optimal split mathematically
    
    // Extract pool reserves and fees from cached info or quotes
    let r1In, r1Out, f1, r2In, r2Out, f2;
    
    if (poolCfg1.dex === 'nomadex') {
      const poolInfo1 = cachedInfo1;
      const isDirectionAlphaToBeta1 = Number(inputToken) === poolInfo1.tokA && Number(outputToken) === poolInfo1.tokB;
      r1In = BigInt(isDirectionAlphaToBeta1 ? poolInfo1.reserveA : poolInfo1.reserveB);
      r1Out = BigInt(isDirectionAlphaToBeta1 ? poolInfo1.reserveB : poolInfo1.reserveA);
      f1 = poolInfo1.fee;
    } else {
      // HumbleSwap
      const poolInfo1 = cachedInfo1;
      const swapAForB1 = fullQuote1.poolInfo.swapAForB;
      r1In = BigInt(swapAForB1 ? poolInfo1.poolBals.A : poolInfo1.poolBals.B);
      r1Out = BigInt(swapAForB1 ? poolInfo1.poolBals.B : poolInfo1.poolBals.A);
      f1 = poolInfo1.protoInfo.totFee;
    }
    
    if (poolCfg2.dex === 'nomadex') {
      const poolInfo2 = cachedInfo2;
      const isDirectionAlphaToBeta2 = Number(inputToken) === poolInfo2.tokA && Number(outputToken) === poolInfo2.tokB;
      r2In = BigInt(isDirectionAlphaToBeta2 ? poolInfo2.reserveA : poolInfo2.reserveB);
      r2Out = BigInt(isDirectionAlphaToBeta2 ? poolInfo2.reserveB : poolInfo2.reserveA);
      f2 = poolInfo2.fee;
    } else {
      // HumbleSwap
      const poolInfo2 = cachedInfo2;
      const swapAForB2 = fullQuote2.poolInfo.swapAForB;
      r2In = BigInt(swapAForB2 ? poolInfo2.poolBals.A : poolInfo2.poolBals.B);
      r2Out = BigInt(swapAForB2 ? poolInfo2.poolBals.B : poolInfo2.poolBals.A);
      f2 = poolInfo2.protoInfo.totFee;
    }
    
    // Calculate optimal split mathematically
    const optimalP1Amount = calculateOptimalSplitAmount(totalAmountBigInt, r1In, r1Out, f1, r2In, r2Out, f2);
    const optimalP2Amount = totalAmountBigInt - optimalP1Amount;
    
    // Ensure minimum amounts (at least 0.1% of total)
    const minAmount = totalAmountBigInt / BigInt(1000);
    let p1Amount = optimalP1Amount;
    let p2Amount = optimalP2Amount;
    
    if (p1Amount < minAmount) {
      p1Amount = 0n;
      p2Amount = totalAmountBigInt;
    } else if (p2Amount < minAmount) {
      p1Amount = totalAmountBigInt;
      p2Amount = 0n;
    }
    
    // Test edge cases and calculated optimal split
    let bestSplit = null;
    let bestTotalOutput = 0n;
    
    const testCases = [
      { p1Amount: 0n, p2Amount: totalAmountBigInt, name: '100% pool2' },
      { p1Amount: totalAmountBigInt, p2Amount: 0n, name: '100% pool1' },
      { p1Amount, p2Amount, name: 'optimal split' }
    ];
    
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
      return bestSplit;
    }
    
    // Fallback: use the pool with better full quote
    if (BigInt(fullQuote1.outputAmount) > BigInt(fullQuote2.outputAmount)) {
      return [{
        poolCfg: poolCfg1,
        amount: totalAmountBigInt.toString(),
        expectedOutput: fullQuote1.outputAmount,
        minOutput: fullQuote1.minimumOutputAmount,
        quote: fullQuote1
      }];
    } else {
      return [{
        poolCfg: poolCfg2,
        amount: totalAmountBigInt.toString(),
        expectedOutput: fullQuote2.outputAmount,
        minOutput: fullQuote2.minimumOutputAmount,
        quote: fullQuote2
      }];
    }
  } else {
    // For more than 2 pools, use a simpler approach: equal split or try a few common splits
    // This can be optimized later with more sophisticated algorithms
    const splits = [
      [1.0, 0, 0], // All in first pool
      [0, 1.0, 0], // All in second pool
      [0, 0, 1.0], // All in third pool (if exists)
      [0.5, 0.5, 0], // Equal split between first two
      [0.5, 0, 0.5], // Equal split between first and third
      [0, 0.5, 0.5], // Equal split between second and third
      [1/3, 1/3, 1/3] // Equal split between all three
    ];
    
    for (const split of splits) {
      if (split.length > numPools) continue;
      
      const amounts = split.slice(0, numPools).map(p => 
        (totalAmountBigInt * BigInt(Math.floor(p * 10000))) / BigInt(10000)
      );
      
      // Adjust last amount to account for rounding
      const sum = amounts.reduce((a, b) => a + b, 0n);
      amounts[amounts.length - 1] = totalAmountBigInt - (sum - amounts[amounts.length - 1]);
      
      // Skip if any amount is too small
      if (amounts.some(a => a < totalAmountBigInt / BigInt(1000))) {
        continue;
      }
      
      try {
        const quotes = await Promise.all(
          matchingPools.map((pool, idx) => {
            const cachedInfo = poolInfoCache.get(String(pool.poolId)) || null;
            return calculateQuoteForPool(pool, inputToken, outputToken, amounts[idx].toString(), slippage, address, cachedInfo).catch(() => null);
          })
        );
        
        if (quotes.every(q => q !== null)) {
          const totalOutput = quotes.reduce((sum, q) => sum + BigInt(q.outputAmount), 0n);
          if (totalOutput > bestTotalOutput) {
            bestTotalOutput = totalOutput;
            bestSplit = matchingPools.map((poolCfg, idx) => ({
              poolCfg,
              amount: amounts[idx].toString(),
              expectedOutput: quotes[idx].outputAmount,
              minOutput: quotes[idx].minimumOutputAmount,
              quote: quotes[idx]
            }));
          }
        }
      } catch (err) {
        continue;
      }
    }
  }
  
  if (!bestSplit || bestSplit.length === 0) {
    // Fallback: use the pool with best single-pool quote
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
    
    return [{
      poolCfg: best.pool,
      amount: totalAmountBigInt.toString(),
      expectedOutput: best.quote.outputAmount,
      minOutput: best.quote.minimumOutputAmount,
      quote: best.quote
    }];
  }
  
  return bestSplit;
}

/**
 * Build transactions for multiple pools and combine into single atomic group
 * @param {Array<Object>} splitDetails - Array from calculateOptimalSplit: { poolCfg, amount, expectedOutput, minOutput, quote }
 * @param {string|number} inputToken - Input token ID (underlying token)
 * @param {string|number} outputToken - Output token ID (underlying token)
 * @param {number} slippage - Slippage tolerance
 * @param {string} address - User's address (optional)
 * @returns {Promise<Array<string>>} Array of base64-encoded unsigned transactions
 */
async function buildMultiPoolTransactions(splitDetails, inputToken, outputToken, slippage, address) {
  // Return empty array if address is not provided
  if (!address) {
    return [];
  }
  
  const allTransactions = [];
  
  for (const split of splitDetails) {
    const { poolCfg, amount, minOutput, quote } = split;
    const poolId = Number(poolCfg.poolId);
    const dex = poolCfg.dex || 'humbleswap';
    const inputTokenStr = String(inputToken);
    const outputTokenStr = String(outputToken);
    const inputTokenNum = Number(inputToken);
    const outputTokenNum = Number(outputToken);
    const amountBigInt = BigInt(amount);
    
    if (dex === 'nomadex') {
      // Build Nomadex transactions
      const inputTokenType = getTokenTypeFromConfig(poolCfg, inputTokenNum);
      const outputTokenType = getTokenTypeFromConfig(poolCfg, outputTokenNum);
      
      if (!inputTokenType || !outputTokenType) {
        throw new Error(`Could not determine token types for pool ${poolId}`);
      }
      
      const isDirectionAlphaToBeta = quote.poolInfo.isDirectionAlphaToBeta;
      
      // Apply safety margin to minimum output (same as handleNomadexQuote)
      // The contract's calculation may differ slightly due to rounding, so we need to be more conservative
      const safetyMargin = BigInt(99); // 99% of minimum (1% buffer)
      const adjustedMinimumOutput = (BigInt(minOutput) * safetyMargin) / BigInt(100);
      
      const poolTransactions = await buildNomadexSwapTransactions({
        sender: address,
        poolId: poolId,
        inputToken: inputTokenNum,
        outputToken: outputTokenNum,
        amountIn: amountBigInt.toString(),
        minAmountOut: adjustedMinimumOutput.toString(),
        isDirectionAlphaToBeta,
        inputTokenType,
        outputTokenType,
        algodClient
      });
      
      // Decode transactions to add to group
      const decodedTxns = poolTransactions.map(txn =>
        algosdk.decodeUnsignedTransaction(Buffer.from(txn, 'base64'))
      );
      
      allTransactions.push(...decodedTxns);
    } else {
      // Build HumbleSwap transactions
      const u2w = poolCfg.tokens?.underlyingToWrapped || {};
      const inputWrapped = u2w[inputTokenStr];
      const outputWrapped = u2w[outputTokenStr];
      
      if (inputWrapped === undefined || outputWrapped === undefined) {
        throw new Error(`Missing wrapped token mappings for pool ${poolId}`);
      }
      
      // Get decimals
      const inputDecimals = await getTokenDecimals(inputTokenStr);
      const outputDecimals = await getTokenDecimals(outputTokenStr);
      const amountInDecimal = Number(amountBigInt) / (10 ** inputDecimals);
      
      // Create swap instance
      const swapInstance = new swap(poolId, algodClient, indexerClient, {
        acc: { addr: address, sk: new Uint8Array(0) },
        simulate: true,
        formatBytes: true,
        waitForConfirmation: false
      });
      
      // Build token objects
      const tokenA = {
        contractId: Number(inputWrapped),
        tokenId: inputTokenStr,
        amount: amountInDecimal.toString(),
        decimals: inputDecimals,
        symbol: (getTokenMetaFromConfig(inputWrapped) || {}).symbol || undefined
      };
      
      const tokenB = {
        contractId: Number(outputWrapped),
        tokenId: outputTokenStr,
        decimals: outputDecimals,
        symbol: (getTokenMetaFromConfig(outputWrapped) || {}).symbol || undefined
      };
      
      // Generate swap transactions
      const swapResult = await swapInstance.swap(
        address,
        poolId,
        tokenA,
        tokenB,
        [], // extraTxns
        {
          debug: false,
          slippage: slippage,
          degenMode: false,
          skipWithdraw: false
        }
      );
      
      if (!swapResult || !swapResult.success) {
        throw new Error(`Failed to generate swap transactions for pool ${poolId}: ${JSON.stringify(swapResult?.error || 'Unknown error')}`);
      }
      
      // Decode transactions to add to group
      const decodedTxns = swapResult.txns.map(txn =>
        algosdk.decodeUnsignedTransaction(Buffer.from(txn, 'base64'))
      );
      
      allTransactions.push(...decodedTxns);
    }
  }
  
  // Assign group ID to all transactions to make them atomic
  // Clear any existing group IDs first, then assign a new one to all transactions together
  if (allTransactions.length > 0) {
    // Clear any existing group IDs
    for (const txn of allTransactions) {
      txn.group = undefined;
    }
    // Assign a new group ID to all transactions together
    algosdk.assignGroupID(allTransactions);
  }
  
  // Encode all transactions back to base64
  return allTransactions.map(txn => 
    Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64')
  );
}

/**
 * Handle Nomadex quote request
 */
async function handleNomadexQuote(req, res, params) {
  try {
    const { address, inputToken, outputToken, amount, slippage, poolContractId, poolCfg } = params;

    // Validate tokens match pool configuration
    const tokA = poolCfg.tokens?.tokA;
    const tokB = poolCfg.tokens?.tokB;
    
    if (!tokA || !tokB) {
      return res.status(400).json({ error: 'Invalid pool configuration: missing token information' });
    }

    const inputTokenNum = Number(inputToken);
    const outputTokenNum = Number(outputToken);
    const tokANum = Number(tokA.id);
    const tokBNum = Number(tokB.id);

    // Validate input/output tokens match pool
    const validPair =
      (inputTokenNum === tokANum && outputTokenNum === tokBNum) ||
      (inputTokenNum === tokBNum && outputTokenNum === tokANum);

    if (!validPair) {
      return res.status(400).json({
        error: `Token pair (${inputToken}, ${outputToken}) does not match pool tokens (${tokANum}, ${tokBNum})`
      });
    }

    // Get token types from config
    const inputTokenType = getTokenTypeFromConfig(poolCfg, inputTokenNum);
    const outputTokenType = getTokenTypeFromConfig(poolCfg, outputTokenNum);

    if (!inputTokenType || !outputTokenType) {
      return res.status(400).json({ error: 'Could not determine token types from pool configuration' });
    }

    // Get pool info
    const poolInfo = await getNomadexPoolInfo(poolContractId, algodClient, indexerClient, poolCfg);

    // Note: tokA can be 0 (native token), so we check for null/undefined explicitly
    if (poolInfo.tokA === null || poolInfo.tokA === undefined || poolInfo.tokB === null || poolInfo.tokB === undefined) {
      return res.status(500).json({ error: 'Failed to determine pool token IDs' });
    }

    // Determine swap direction (alpha to beta = tokA to tokB)
    const isDirectionAlphaToBeta = inputTokenNum === poolInfo.tokA && outputTokenNum === poolInfo.tokB;
    const inputReserve = isDirectionAlphaToBeta ? poolInfo.reserveA : poolInfo.reserveB;
    const outputReserve = isDirectionAlphaToBeta ? poolInfo.reserveB : poolInfo.reserveA;

    // Calculate quote
    const amountBigInt = BigInt(amount);
    const outputAmount = calculateNomadexOutput(amountBigInt, inputReserve, outputReserve, poolInfo.fee);
    // Apply slippage tolerance to get minimum output
    const minimumOutputAmount = (outputAmount * BigInt(Math.floor((1 - slippage) * 10000))) / BigInt(10000);
    // Add a larger safety margin (1%) to account for rounding differences and potential reserve changes
    // between our calculation and the contract's actual execution
    // The contract's calculation may differ slightly due to rounding, so we need to be more conservative
    const safetyMargin = BigInt(99); // 99% of minimum (1% buffer)
    const adjustedMinimumOutput = (minimumOutputAmount * safetyMargin) / BigInt(100);
    const priceImpact = calculatePriceImpact(amountBigInt, inputReserve, outputAmount, outputReserve);
    const rate = Number(outputAmount) / Number(amountBigInt);

    // Build swap transactions (only if address is provided)
    let unsignedTransactions = [];
    if (address) {
      try {
        unsignedTransactions = await buildNomadexSwapTransactions({
          sender: address,
          poolId: poolContractId,
          inputToken: inputTokenNum,
          outputToken: outputTokenNum,
          amountIn: amountBigInt.toString(),
          minAmountOut: adjustedMinimumOutput.toString(),
          isDirectionAlphaToBeta,
          inputTokenType,
          outputTokenType,
          algodClient
        });
      } catch (txnError) {
        console.error('Error building Nomadex transactions:', txnError);
        return res.status(200).json({
          quote: {
            inputAmount: amountBigInt.toString(),
            outputAmount: outputAmount.toString(),
            minimumOutputAmount: minimumOutputAmount.toString(),
            rate: rate,
            priceImpact: priceImpact
          },
          unsignedTransactions: [],
          poolId: poolContractId.toString(),
          error: 'Failed to generate swap transactions: ' + txnError.message
        });
      }
    }

    res.json({
      quote: {
        inputAmount: amountBigInt.toString(),
        outputAmount: outputAmount.toString(),
        minimumOutputAmount: minimumOutputAmount.toString(),
        rate: rate,
        priceImpact: priceImpact
      },
      unsignedTransactions: unsignedTransactions,
      poolId: poolContractId.toString()
    });

  } catch (error) {
    console.error('Error generating Nomadex quote:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
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

    // Validate required fields (address and poolId are now optional)
    if (inputToken === undefined || outputToken === undefined || !amount) {
      return res.status(400).json({
        error: 'Missing required fields: inputToken, outputToken, amount'
      });
    }

    // Default slippage tolerance to 1% if not provided
    const slippage = slippageTolerance || 0.01;
    const inputTokenStr = String(inputToken);
    const outputTokenStr = String(outputToken);

    // If poolId is provided, use existing single-pool logic (backward compatible)
    if (poolId) {
      const poolContractId = poolId;
      const poolCfg = getPoolConfigById(poolContractId);
      if (!poolCfg) {
        return res.status(400).json({ error: `Pool ${poolContractId} not found in config` });
      }

      const dexType = poolCfg.dex || 'humbleswap';

      // Route to appropriate DEX handler
      if (dexType === 'nomadex') {
        return await handleNomadexQuote(req, res, {
          address,
          inputToken: inputTokenStr,
          outputToken: outputTokenStr,
          amount,
          slippage,
          poolContractId,
          poolCfg
        });
      } else {
        // Handle HumbleSwap pool (existing logic)
        const u2w = poolCfg.tokens && poolCfg.tokens.underlyingToWrapped ? poolCfg.tokens.underlyingToWrapped : {};
        const inputWrapped = u2w[inputTokenStr];
        const outputWrapped = u2w[outputTokenStr];
        if (inputWrapped === undefined) {
          return res.status(400).json({ error: `No wrapped mapping for input token ${inputTokenStr} in pool ${poolContractId}` });
        }
        if (outputWrapped === undefined) {
          return res.status(400).json({ error: `No wrapped mapping for output token ${outputTokenStr} in pool ${poolContractId}` });
        }

        // Validate wrapped pair matches pool
        const pair = poolCfg.tokens.wrappedPair || {};
        const wrappedPairOk =
          (Number(pair.tokA) === Number(inputWrapped) && Number(pair.tokB) === Number(outputWrapped)) ||
          (Number(pair.tokA) === Number(outputWrapped) && Number(pair.tokB) === Number(inputWrapped));
        if (!wrappedPairOk) {
          return res.status(400).json({ error: 'Resolved wrapped tokens do not match pool configured pair' });
        }

        // Create swap instance using ulujs swap class
        // Use placeholder address for pool info calls if address is not provided
        const addressForInfo = address || algosdk.generateAccount().addr;
        const swapInstance = new swap(Number(poolContractId), algodClient, indexerClient, {
          acc: { addr: addressForInfo, sk: new Uint8Array(0) },
          simulate: true,
          formatBytes: true,
          waitForConfirmation: false
        });

        // Build token objects for swap using local config and decimals cache
        const inputDecimals = await getTokenDecimals(inputTokenStr);
        const outputDecimals = await getTokenDecimals(outputTokenStr);
        const amountInDecimal = Number(amount) / (10 ** inputDecimals);

        const tokenA = {
          contractId: Number(inputWrapped),
          tokenId: inputTokenStr,
          amount: amountInDecimal.toString(),
          decimals: inputDecimals,
          symbol: (getTokenMetaFromConfig(inputWrapped) || {}).symbol || undefined
        };

        const tokenB = {
          contractId: Number(outputWrapped),
          tokenId: outputTokenStr,
          decimals: outputDecimals,
          symbol: (getTokenMetaFromConfig(outputWrapped) || {}).symbol || undefined
        };

        // Get pool info for quote calculation
        const infoResult = await swapInstance.Info();
        if (!infoResult.success) {
          return res.status(500).json({
            error: 'Failed to fetch pool information',
            details: infoResult.error
          });
        }

        const poolInfo = infoResult.returnValue;
        const { poolBals, protoInfo } = poolInfo;

        // Determine swap direction
        const swapAForB = tokenA.contractId === poolInfo.tokA && tokenB.contractId === poolInfo.tokB;
        const inputReserve = swapAForB ? poolBals.A : poolBals.B;
        const outputReserve = swapAForB ? poolBals.B : poolBals.A;

        // Calculate quote
        const totalFee = protoInfo.totFee;
        const outputAmount = calculateOutputAmount(amount, inputReserve, outputReserve, totalFee);
        const minimumOutputAmount = (outputAmount * BigInt(Math.floor((1 - slippage) * 10000))) / BigInt(10000);
        const priceImpact = calculatePriceImpact(amount, inputReserve, outputAmount, outputReserve);
        const rate = Number(outputAmount) / Number(amount);

        // Generate swap transactions (only if address is provided)
        let unsignedTransactions = [];
        if (address) {
          const swapResult = await swapInstance.swap(
            address,
            Number(poolContractId),
            tokenA,
            tokenB,
            [], // extraTxns
            {
              debug: false,
              slippage: slippage,
              degenMode: false,
              skipWithdraw: false
            }
          );

          if (!swapResult || !swapResult.success) {
            return res.status(200).json({
              quote: {
                inputAmount: amount.toString(),
                outputAmount: outputAmount.toString(),
                minimumOutputAmount: minimumOutputAmount.toString(),
                rate: rate,
                priceImpact: priceImpact
              },
              unsignedTransactions: [],
              poolId: poolContractId.toString(),
              error: 'Failed to generate swap transactions' + (swapResult?.error ? `: ${JSON.stringify(swapResult.error)}` : '')
            });
          }
          
          unsignedTransactions = swapResult.txns;
        }

        return res.json({
          quote: {
            inputAmount: amount.toString(),
            outputAmount: outputAmount.toString(),
            minimumOutputAmount: minimumOutputAmount.toString(),
            rate: rate,
            priceImpact: priceImpact
          },
          unsignedTransactions: unsignedTransactions,
          poolId: poolContractId.toString()
        });
      }
    }

    // New path: pool discovery and optimal routing
    // Find matching pools
    const matchingPools = findMatchingPools(inputToken, outputToken, dex);
    
    if (matchingPools.length === 0) {
      const dexList = dex && Array.isArray(dex) ? dex.join(', ') : 'all';
      return res.status(400).json({
        error: `No matching pools found for token pair (${inputToken}, ${outputToken})`,
        searchedDexes: dexList
      });
    }

    // Calculate optimal split across pools
    let splitDetails;
    try {
      splitDetails = await calculateOptimalSplit(matchingPools, inputToken, outputToken, amount, slippage, address);
    } catch (splitError) {
      return res.status(500).json({
        error: 'Failed to calculate optimal split',
        message: splitError.message
      });
    }

    // Build combined transactions (only if address is provided)
    let unsignedTransactions = [];
    if (address) {
      try {
        unsignedTransactions = await buildMultiPoolTransactions(splitDetails, inputToken, outputToken, slippage, address);
      } catch (txnError) {
      console.error('Error building multi-pool transactions:', txnError);
      // Return quote without transactions if transaction building fails
      const totalOutput = splitDetails.reduce((sum, split) => sum + BigInt(split.expectedOutput), 0n);
      const totalMinOutput = splitDetails.reduce((sum, split) => sum + BigInt(split.minOutput), 0n);
      const totalInput = BigInt(amount);
      const overallRate = Number(totalOutput) / Number(totalInput);
      
      // Calculate weighted average price impact
      const totalInputNum = Number(totalInput);
      const weightedPriceImpact = splitDetails.reduce((sum, split) => {
        const splitInput = Number(split.amount);
        const weight = splitInput / totalInputNum;
        return sum + (split.quote.priceImpact * weight);
      }, 0);

      return res.status(200).json({
        quote: {
          inputAmount: totalInput.toString(),
          outputAmount: totalOutput.toString(),
          minimumOutputAmount: totalMinOutput.toString(),
          rate: overallRate,
          priceImpact: weightedPriceImpact
        },
        unsignedTransactions: [],
        poolId: null,
        route: {
          pools: splitDetails.map(split => ({
            poolId: split.poolCfg.poolId.toString(),
            dex: split.poolCfg.dex || 'humbleswap',
            inputAmount: split.amount,
            outputAmount: split.expectedOutput
          }))
        },
        error: 'Failed to generate swap transactions: ' + txnError.message
      });
      }
    }

    // Calculate aggregate quote data
    const totalOutput = splitDetails.reduce((sum, split) => sum + BigInt(split.expectedOutput), 0n);
    const totalMinOutput = splitDetails.reduce((sum, split) => sum + BigInt(split.minOutput), 0n);
    const totalInput = BigInt(amount);
    const overallRate = Number(totalOutput) / Number(totalInput);
    
    // Calculate weighted average price impact
    const totalInputNum = Number(totalInput);
    const weightedPriceImpact = splitDetails.reduce((sum, split) => {
      const splitInput = Number(split.amount);
      const weight = splitInput / totalInputNum;
      return sum + (split.quote.priceImpact * weight);
    }, 0);

    // Build route summary
    const route = {
      pools: splitDetails.map(split => ({
        poolId: split.poolCfg.poolId.toString(),
        dex: split.poolCfg.dex || 'humbleswap',
        inputAmount: split.amount,
        outputAmount: split.expectedOutput
      }))
    };

    console.log('Quote:', {
      input: totalInput.toString(),
      output: totalOutput.toString(),
      rate: overallRate.toFixed(6),
      pools: route.pools.map(p => `${p.poolId}(${p.dex}):${p.inputAmount}`).join(' + ')
    });

    res.json({
      quote: {
        inputAmount: totalInput.toString(),
        outputAmount: totalOutput.toString(),
        minimumOutputAmount: totalMinOutput.toString(),
        rate: overallRate,
        priceImpact: weightedPriceImpact
      },
      unsignedTransactions: unsignedTransactions,
      poolId: null, // null when using multi-pool routing
      route: route
    });

  } catch (error) {
    console.error('Error generating quote:', error);
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
      // Handle HumbleSwap pool (existing logic)
      const swapContract = new swap200(Number(poolId), algodClient, indexerClient);
      const infoResult = await swapContract.Info();

      if (!infoResult.success) {
        return res.status(500).json({
          error: 'Failed to fetch pool information',
          details: infoResult.error
        });
      }

      const poolInfo = infoResult.returnValue;

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
app.get('/config/pools', (req, res) => {
  try {
    loadConfigsOnce();
    res.json(poolsConfig);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load pools config', message: e.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start server only when running directly (local development)
// When imported as a module (Vercel), export the app instead
// In ESM, check if we're not in a serverless environment
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Swap API server running on port ${PORT}`);
    console.log(`Algod: ${process.env.ALGOD_URL || 'https://mainnet-api.voi.nodely.dev'}`);
    console.log(`Indexer: ${process.env.INDEXER_URL || 'https://mainnet-idx.voi.nodely.dev'}`);
  });
}

// Export app for Vercel serverless function
export default app;
