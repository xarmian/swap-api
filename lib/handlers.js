import { calculateOptimalSplit, findOptimalMultiHopRoute } from './quotes.js';
import { buildSwapTransactions } from './transactions.js';
import { getPoolConfigById, findMatchingPools, findRoutes } from './config.js';
import { getTokenDecimals } from './utils.js';

/**
 * Build route response object
 * @param {Array} splitDetails - Split details array
 * @param {string} routeType - 'direct' or 'multi-hop'
 * @param {Array|null} hopQuotes - Array of hop quotes for multi-hop routes
 * @returns {Object} Route response object
 */
function buildRouteResponse(splitDetails, routeType, hopQuotes) {
  if (routeType === 'multi-hop' && hopQuotes) {
    return {
      type: 'multi-hop',
      hops: hopQuotes.map((hopQuote, idx) => {
        // Handle split hops (multiple pools) vs single pool hops
        if (hopQuote.isSplit && hopQuote.splitDetails && hopQuote.splitDetails.length > 0) {
          // Split hop - return array of pools
          return {
            inputToken: hopQuote.inputToken.toString(),
            outputToken: hopQuote.outputToken.toString(),
            inputAmount: hopQuote.inputAmount,
            outputAmount: hopQuote.outputAmount,
            pools: hopQuote.splitDetails.map(split => ({
              poolId: split.poolCfg.poolId.toString(),
              dex: split.poolCfg.dex || 'humbleswap',
              inputAmount: split.inputAmount,
              outputAmount: split.outputAmount
            }))
          };
        } else {
          // Single pool hop
          return {
            poolId: hopQuote.poolCfg?.poolId?.toString() || 'unknown',
            dex: hopQuote.poolCfg?.dex || 'humbleswap',
            inputToken: hopQuote.inputToken.toString(),
            outputToken: hopQuote.outputToken.toString(),
            inputAmount: hopQuote.inputAmount,
            outputAmount: hopQuote.outputAmount
          };
        }
      })
    };
  } else {
    return {
      type: 'direct',
      pools: splitDetails.map(split => ({
        poolId: split.poolCfg.poolId.toString(),
        dex: split.poolCfg.dex || 'humbleswap',
        inputAmount: split.amount,
        outputAmount: split.expectedOutput
      }))
    };
  }
}

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
    let isDirectRoute = true;
    let multiHopQuote = null;
    
    if (poolId) {
      // Single pool mode: find the specified pool
      const poolCfg = getPoolConfigById(poolId);
      if (!poolCfg) {
        return res.status(400).json({ error: `Pool ${poolId} not found in config` });
      }
      matchingPools = [poolCfg];
    } else {
      // Multi-pool mode: find matching pools (direct routes)
      matchingPools = findMatchingPools(inputToken, outputToken, dex);
      
      // If no direct routes found, try multi-hop routes
      if (matchingPools.length === 0) {
        const routes = findRoutes(inputToken, outputToken, 2, dex); // Max 2 hops
        if (routes.length > 0) {
          // Find optimal route by evaluating all pool combinations
          try {
            const optimalResult = await findOptimalMultiHopRoute(
              routes,
              inputToken,
              outputToken,
              amount,
              slippage,
              address
            );
            if (optimalResult) {
              multiHopQuote = optimalResult.quote;
              isDirectRoute = false;
            } else {
              const dexList = dex && Array.isArray(dex) ? dex.join(', ') : 'all';
              return res.status(400).json({
                error: `No matching pools or routes found for token pair (${inputToken}, ${outputToken})`,
                searchedDexes: dexList
              });
            }
          } catch (multiHopError) {
            console.warn('Failed to find optimal multi-hop route:', multiHopError.message);
            const dexList = dex && Array.isArray(dex) ? dex.join(', ') : 'all';
            return res.status(400).json({
              error: `No matching pools or routes found for token pair (${inputToken}, ${outputToken})`,
              searchedDexes: dexList
            });
          }
        } else {
          const dexList = dex && Array.isArray(dex) ? dex.join(', ') : 'all';
          return res.status(400).json({
            error: `No matching pools or routes found for token pair (${inputToken}, ${outputToken})`,
            searchedDexes: dexList
          });
        }
      } else {
        // Direct routes found - also check if multi-hop might be better
        const routes = findRoutes(inputToken, outputToken, 2, dex);
        if (routes.length > 0) {
          try {
            const optimalResult = await findOptimalMultiHopRoute(
              routes,
              inputToken,
              outputToken,
              amount,
              slippage,
              address
            );
            if (optimalResult) {
              // We'll compare after calculating direct route
              multiHopQuote = optimalResult.quote;
            }
          } catch (multiHopError) {
            // Ignore multi-hop errors if we have direct routes
            console.warn('Failed to find optimal multi-hop route for comparison:', multiHopError.message);
          }
        }
      }
    }

    // Calculate optimal split across pools (works for single pool too)
    let splitResult = null;
    if (isDirectRoute) {
      try {
        splitResult = await calculateOptimalSplit(matchingPools, inputToken, outputToken, amount, slippage, address);
      } catch (splitError) {
        // If direct route fails and we have multi-hop, use multi-hop
        if (multiHopQuote) {
          isDirectRoute = false;
        } else {
          return res.status(500).json({
            error: 'Failed to calculate optimal split',
            message: splitError.message
          });
        }
      }
    }
    
    // Compare direct vs multi-hop and select best
    if (splitResult && multiHopQuote) {
      const directOutput = BigInt(splitResult.splitDetails.reduce((sum, split) => sum + BigInt(split.expectedOutput), 0n));
      const multiHopOutput = BigInt(multiHopQuote.outputAmount);
      
      // Use multi-hop if it gives better output
      if (multiHopOutput > directOutput) {
        isDirectRoute = false;
        splitResult = null;
      } else {
        multiHopQuote = null;
      }
    }
    
    // Determine final route details
    let splitDetails;
    let platformFee;
    let routeType = 'direct';
    let hopQuotes = null;
    let multiHopPriceImpact = null;
    
    if (isDirectRoute && splitResult) {
      splitDetails = splitResult.splitDetails;
      platformFee = splitResult.platformFee;
    } else if (multiHopQuote) {
      // Convert multi-hop quote to splitDetails format
      // multiHopQuote is the quote object from findOptimalMultiHopRoute
      // Handle both single-pool hops and split hops
      splitDetails = [];
      for (const hopQuote of multiHopQuote.hopQuotes) {
        if (hopQuote.isSplit && hopQuote.splitDetails) {
          // This hop was split across multiple pools - add all splits
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
          // Single pool hop
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
      platformFee = {
        gain: "0",
        feeAmount: "0",
        feeBps: 0,
        feeAddress: null,
        applied: false
      };
      routeType = 'multi-hop';
      hopQuotes = multiHopQuote.hopQuotes;
      multiHopPriceImpact = multiHopQuote.priceImpact;
    } else {
      return res.status(500).json({
        error: 'Failed to determine route',
        message: 'Neither direct nor multi-hop route could be calculated'
      });
    }

    // Build transactions (only if address is provided)
    let unsignedTransactions = [];
    let networkFee = 0;
    if (address) {
      try {
        const txnResult = await buildSwapTransactions(
          splitDetails, 
          inputToken, 
          outputToken, 
          slippage, 
          address,
          platformFee
        );
        unsignedTransactions = txnResult.transactions;
        networkFee = txnResult.networkFee;
      } catch (txnError) {
        console.error('Error building swap transactions:', txnError);
        // Return quote without transactions if transaction building fails
        // For multi-hop routes, use the aggregated output from the quote
        // For direct routes, sum all splits (multiple pools splitting the same input)
        let totalOutput, totalMinOutput;
        if (routeType === 'multi-hop' && multiHopQuote) {
          // Multi-hop: use the aggregated output from the quote
          totalOutput = BigInt(multiHopQuote.outputAmount);
          totalMinOutput = BigInt(multiHopQuote.minimumOutputAmount);
        } else {
          // Direct route: sum all splits (multiple pools splitting the same input)
          totalOutput = splitDetails.reduce((sum, split) => sum + BigInt(split.expectedOutput), 0n);
          totalMinOutput = splitDetails.reduce((sum, split) => sum + BigInt(split.minOutput), 0n);
        }
        const totalInput = BigInt(amount);
        
        // Calculate rate in normalized units (accounting for decimals)
        const inputDecimals = await getTokenDecimals(inputToken);
        const outputDecimals = await getTokenDecimals(outputToken);
        const inputDecimalsMultiplier = BigInt(10) ** BigInt(inputDecimals);
        const outputDecimalsMultiplier = BigInt(10) ** BigInt(outputDecimals);
        const overallRate = Number((totalOutput * inputDecimalsMultiplier) / (totalInput * outputDecimalsMultiplier));
        
        // Calculate price impact
        // For multi-hop routes, use the cumulative price impact from the quote
        // For direct routes, calculate weighted average across splits
        let weightedPriceImpact;
        if (routeType === 'multi-hop' && multiHopPriceImpact !== null) {
          weightedPriceImpact = multiHopPriceImpact;
        } else {
          const totalInputNum = Number(totalInput);
          weightedPriceImpact = splitDetails.reduce((sum, split) => {
            const splitInput = Number(split.amount);
            const weight = splitInput / totalInputNum;
            return sum + (split.quote.priceImpact * weight);
          }, 0);
        }

        // Build response - always include route, and poolId for single pool
        const response = {
          quote: {
            inputAmount: totalInput.toString(),
            outputAmount: totalOutput.toString(),
            minimumOutputAmount: totalMinOutput.toString(),
            rate: overallRate,
            priceImpact: weightedPriceImpact,
            networkFee: '0' // No transactions, so no network fee
          },
          unsignedTransactions: [],
          error: 'Failed to generate swap transactions: ' + txnError.message,
          route: buildRouteResponse(splitDetails, routeType, hopQuotes)
        };

        // Include poolId for single pool (backward compatibility)
        if (splitDetails.length === 1 && splitDetails[0].poolCfg) {
          response.poolId = splitDetails[0].poolCfg.poolId.toString();
        } else {
          response.poolId = null;
        }
        
        // Always include platform fee metadata
        response.platformFee = {
          gain: platformFee.gain,
          feeAmount: platformFee.feeAmount,
          feeBps: platformFee.feeBps,
          feeAddress: platformFee.feeAddress,
          applied: platformFee.applied || false
        };

        return res.status(200).json(response);
      }
    }

    // Calculate aggregate quote data
    // For multi-hop routes, use the aggregated output from the quote (already calculated correctly)
    // For direct routes, sum all splits (multiple pools splitting the same input)
    let totalOutput, totalMinOutput;
    if (routeType === 'multi-hop' && multiHopQuote) {
      // Multi-hop: use the aggregated output from the quote
      // This is already correctly calculated in calculateMultiHopQuote
      totalOutput = BigInt(multiHopQuote.outputAmount);
      totalMinOutput = BigInt(multiHopQuote.minimumOutputAmount);
    } else {
      // Direct route: sum all splits (multiple pools splitting the same input)
      totalOutput = splitDetails.reduce((sum, split) => sum + BigInt(split.expectedOutput), 0n);
      totalMinOutput = splitDetails.reduce((sum, split) => sum + BigInt(split.minOutput), 0n);
    }
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
    
    // Calculate price impact
    // For multi-hop routes, use the cumulative price impact from the quote
    // For direct routes, calculate weighted average across splits
    let weightedPriceImpact;
    if (routeType === 'multi-hop' && multiHopPriceImpact !== null) {
      weightedPriceImpact = multiHopPriceImpact;
    } else {
      const totalInputNum = Number(totalInput);
      weightedPriceImpact = splitDetails.reduce((sum, split) => {
        const splitInput = Number(split.amount);
        const weight = splitInput / totalInputNum;
        return sum + (split.quote.priceImpact * weight);
      }, 0);
    }

    // Build response - always include route, and poolId for single pool
    const response = {
      quote: {
        inputAmount: totalInput.toString(),
        outputAmount: totalOutput.toString(),
        minimumOutputAmount: totalMinOutput.toString(),
        rate: overallRate,
        priceImpact: weightedPriceImpact,
        networkFee: networkFee.toString() // Add network fee in microAlgos
      },
      unsignedTransactions: unsignedTransactions,
      route: buildRouteResponse(splitDetails, routeType, hopQuotes)
    };

    // Include poolId for single pool (backward compatibility)
    // For multi-hop routes with splits, we don't have a single pool
    if (splitDetails.length === 1 && splitDetails[0].poolCfg) {
      response.poolId = splitDetails[0].poolCfg.poolId.toString();
    } else {
      response.poolId = null;
    }
    
    // Always include platform fee metadata
    response.platformFee = {
      gain: platformFee.gain,
      feeAmount: platformFee.feeAmount,
      feeBps: platformFee.feeBps,
      feeAddress: platformFee.feeAddress,
      applied: platformFee.applied || false
    };

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

