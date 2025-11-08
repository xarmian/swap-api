import {
  getPoolInfo as getNomadexPoolInfo,
  calculateOutputAmount as calculateNomadexOutput
} from './nomadex.js';
import {
  getPoolInfo as getHumbleswapPoolInfo,
  calculateOutputAmount as calculateHumbleswapOutput,
  resolveWrappedTokens,
  validateWrappedPair
} from './humbleswap.js';
import { getTokenDecimals, calculatePriceImpact, calculateOptimalSplitAmount } from './utils.js';
import { getPoolConfigById } from './config.js';
import { algodClient, indexerClient } from './clients.js';

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
    
    
    // Get token decimals for rate calculation
    const inputDecimals = await getTokenDecimals(inputTokenNum.toString());
    const outputDecimals = await getTokenDecimals(outputTokenNum.toString());
    
    // Calculate quote
    const outputAmount = calculateNomadexOutput(amountBigInt, inputReserve, outputReserve, poolInfo.fee);
    const minimumOutputAmount = (outputAmount * BigInt(Math.floor((1 - slippage) * 10000))) / BigInt(10000);
    const priceImpact = calculatePriceImpact(amountBigInt, inputReserve, outputAmount, outputReserve);
    
    // Calculate rate in normalized units (accounting for decimals)
    // Rate = (outputAmount / 10^outputDecimals) / (inputAmount / 10^inputDecimals)
    //      = (outputAmount * 10^inputDecimals) / (inputAmount * 10^outputDecimals)
    // Use BigInt with scaling factor to preserve decimal precision
    const inputDecimalsMultiplier = BigInt(10) ** BigInt(inputDecimals);
    const outputDecimalsMultiplier = BigInt(10) ** BigInt(outputDecimals);
    const scaleFactor = BigInt(10) ** BigInt(18); // Use 18 decimals for precision
    const numerator = BigInt(outputAmount) * inputDecimalsMultiplier * scaleFactor;
    const denominator = BigInt(amountBigInt) * outputDecimalsMultiplier;
    const rate = Number(numerator / denominator) / Number(scaleFactor);
    
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
    
    // Determine swap direction
    const swapAForB = inputWrapped === poolInfo.tokA && outputWrapped === poolInfo.tokB;
    const inputReserve = swapAForB ? poolBals.A : poolBals.B;
    const outputReserve = swapAForB ? poolBals.B : poolBals.A;
    
    // Calculate quote
    const totalFee = protoInfo.totFee;
    const outputAmount = calculateHumbleswapOutput(amount, inputReserve, outputReserve, totalFee);
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
 * Calculate optimal split across multiple pools to maximize output
 * Uses iterative approach to find best allocation
 * @param {Array<Object>} matchingPools - Array of matching pool configs
 * @param {string|number} inputToken - Input token ID
 * @param {string|number} outputToken - Output token ID
 * @param {string|number|BigInt} totalAmount - Total input amount
 * @param {number} slippage - Slippage tolerance
 * @param {string} address - Optional address for pool info calls
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
    let bestSplit = null;
    let bestTotalOutput = 0n;
    
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
}

export {
  calculateQuoteForPool,
  calculateOptimalSplit
};

