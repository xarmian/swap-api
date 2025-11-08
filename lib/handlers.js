import { calculateOptimalSplit } from './quotes.js';
import { buildSwapTransactions } from './transactions.js';
import { getPoolConfigById, findMatchingPools } from './config.js';
import { getTokenDecimals } from './utils.js';

/**
 * Unified quote handler that works for both single-pool and multi-pool scenarios
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Object} params - Handler parameters
 * @param {string|number} params.inputToken - Input token ID
 * @param {string|number} params.outputToken - Output token ID
 * @param {string|number|BigInt} params.amount - Input amount
 * @param {number} params.slippage - Slippage tolerance
 * @param {string} params.address - Optional user address
 * @param {string|number|undefined} params.poolId - Optional pool ID (if provided, uses single pool)
 * @param {Array<string>|undefined} params.dex - Optional DEX filter
 */
async function handleQuote(req, res, params) {
  try {
    const { inputToken, outputToken, amount, slippage, address, poolId, dex } = params;
    const inputTokenStr = String(inputToken);
    const outputTokenStr = String(outputToken);

    // Determine which pools to use
    let matchingPools;
    if (poolId) {
      // Single pool mode: find the specified pool
      const poolCfg = getPoolConfigById(poolId);
      if (!poolCfg) {
        return res.status(400).json({ error: `Pool ${poolId} not found in config` });
      }
      matchingPools = [poolCfg];
    } else {
      // Multi-pool mode: find matching pools
      matchingPools = findMatchingPools(inputToken, outputToken, dex);
      
      if (matchingPools.length === 0) {
        const dexList = dex && Array.isArray(dex) ? dex.join(', ') : 'all';
        return res.status(400).json({
          error: `No matching pools found for token pair (${inputToken}, ${outputToken})`,
          searchedDexes: dexList
        });
      }
    }

    // Calculate optimal split across pools (works for single pool too)
    let splitDetails;
    try {
      splitDetails = await calculateOptimalSplit(matchingPools, inputToken, outputToken, amount, slippage, address);
    } catch (splitError) {
      return res.status(500).json({
        error: 'Failed to calculate optimal split',
        message: splitError.message
      });
    }

    // Build transactions (only if address is provided)
    let unsignedTransactions = [];
    if (address) {
      try {
        unsignedTransactions = await buildSwapTransactions(splitDetails, inputToken, outputToken, slippage, address);
      } catch (txnError) {
        console.error('Error building swap transactions:', txnError);
        // Return quote without transactions if transaction building fails
        const totalOutput = splitDetails.reduce((sum, split) => sum + BigInt(split.expectedOutput), 0n);
        const totalMinOutput = splitDetails.reduce((sum, split) => sum + BigInt(split.minOutput), 0n);
        const totalInput = BigInt(amount);
        
        // Calculate rate in normalized units (accounting for decimals)
        const inputDecimals = await getTokenDecimals(inputToken);
        const outputDecimals = await getTokenDecimals(outputToken);
        const inputDecimalsMultiplier = BigInt(10) ** BigInt(inputDecimals);
        const outputDecimalsMultiplier = BigInt(10) ** BigInt(outputDecimals);
        const overallRate = Number((totalOutput * inputDecimalsMultiplier) / (totalInput * outputDecimalsMultiplier));
        
        // Calculate weighted average price impact
        const totalInputNum = Number(totalInput);
        const weightedPriceImpact = splitDetails.reduce((sum, split) => {
          const splitInput = Number(split.amount);
          const weight = splitInput / totalInputNum;
          return sum + (split.quote.priceImpact * weight);
        }, 0);

        // Build response - always include route, and poolId for single pool
        const response = {
          quote: {
            inputAmount: totalInput.toString(),
            outputAmount: totalOutput.toString(),
            minimumOutputAmount: totalMinOutput.toString(),
            rate: overallRate,
            priceImpact: weightedPriceImpact
          },
          unsignedTransactions: [],
          error: 'Failed to generate swap transactions: ' + txnError.message,
          route: {
            pools: splitDetails.map(split => ({
              poolId: split.poolCfg.poolId.toString(),
              dex: split.poolCfg.dex || 'humbleswap',
              inputAmount: split.amount,
              outputAmount: split.expectedOutput
            }))
          }
        };

        // Include poolId for single pool (backward compatibility)
        if (splitDetails.length === 1) {
          response.poolId = splitDetails[0].poolCfg.poolId.toString();
        } else {
          response.poolId = null;
        }

        return res.status(200).json(response);
      }
    }

    // Calculate aggregate quote data
    const totalOutput = splitDetails.reduce((sum, split) => sum + BigInt(split.expectedOutput), 0n);
    const totalMinOutput = splitDetails.reduce((sum, split) => sum + BigInt(split.minOutput), 0n);
    const totalInput = BigInt(amount);
    
    // Calculate rate in normalized units (accounting for decimals)
    const inputDecimals = await getTokenDecimals(inputToken);
    const outputDecimals = await getTokenDecimals(outputToken);
    const inputDecimalsMultiplier = BigInt(10) ** BigInt(inputDecimals);
    const outputDecimalsMultiplier = BigInt(10) ** BigInt(outputDecimals);
    const scaleFactor = BigInt(10) ** BigInt(18); // Use 18 decimals for precision
    const numerator = totalOutput * inputDecimalsMultiplier * scaleFactor;
    const denominator = totalInput * outputDecimalsMultiplier;
    const overallRate = Number(numerator / denominator) / Number(scaleFactor);
    
    // Calculate weighted average price impact
    const totalInputNum = Number(totalInput);
    const weightedPriceImpact = splitDetails.reduce((sum, split) => {
      const splitInput = Number(split.amount);
      const weight = splitInput / totalInputNum;
      return sum + (split.quote.priceImpact * weight);
    }, 0);

    // Build response - always include route, and poolId for single pool
    const response = {
      quote: {
        inputAmount: totalInput.toString(),
        outputAmount: totalOutput.toString(),
        minimumOutputAmount: totalMinOutput.toString(),
        rate: overallRate,
        priceImpact: weightedPriceImpact
      },
      unsignedTransactions: unsignedTransactions,
      route: {
        pools: splitDetails.map(split => ({
          poolId: split.poolCfg.poolId.toString(),
          dex: split.poolCfg.dex || 'humbleswap',
          inputAmount: split.amount,
          outputAmount: split.expectedOutput
        }))
      }
    };

    // Include poolId for single pool (backward compatibility)
    if (splitDetails.length === 1) {
      response.poolId = splitDetails[0].poolCfg.poolId.toString();
    } else {
      response.poolId = null;
    }

    res.json(response);

  } catch (error) {
    console.error('Error generating quote:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}

export { handleQuote };

