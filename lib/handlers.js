import { calculateOptimalSplit, findOptimalMultiHopRoute } from './quotes.js';
import { buildSwapTransactions, buildBatchUnwrapTransactions } from './transactions.js';
import { getUnderlyingForWrapped } from './config.js';
import { getPoolConfigById, findMatchingPools, findRoutes, getDiscoveryStatus } from './config.js';
import { getTokenDecimals, calculateRate } from './utils.js';
import { logQuoteRequest, logUnwrapRequest } from './supabase.js';
import { fetchTokenPrices } from './prices.js';

/**
 * Merge a discovery-status warning into a /quote response body when some
 * configured pools are currently missing and pending retry. Applied to EVERY
 * response exit of handleQuote (success, txn-build-failure, every no-route /
 * validation / error path) - a missing pool can just as easily be why a real
 * pair looks unsupported (400) as why a served quote is suboptimal (200), and
 * CONVE-35 requires that be visible rather than silently indistinguishable
 * from "this pair genuinely has no route" (TASK-19).
 * @param {Object} body - Response body to merge the warning into
 * @param {{failedPools: Array<{poolId: number}>}|null|undefined} discoveryStatus
 * @returns {Object}
 */
export function withDiscoveryWarning(body, discoveryStatus) {
  if (!discoveryStatus || discoveryStatus.failedPools.length === 0) {
    return body;
  }
  return {
    ...body,
    discoveryWarning: {
      message: 'Some pools are temporarily unavailable and pending retry; this response may be incomplete or a route may be temporarily missing.',
      pendingPoolIds: discoveryStatus.failedPools.map(p => p.poolId)
    }
  };
}

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
  // Snapshot discovery status ONCE up front (declared outside the try so the
  // catch block below can use it too) and reuse it on EVERY response exit -
  // success, the transaction-build-failure fallback, every no-route/validation
  // error, and the catch-all. Pool/route selection happens against whatever
  // poolsConfig was live at that moment; re-reading discovery status later -
  // after a background retry may have already published a newer, more-complete
  // config (lib/config.js maybeRetryFailedPools) - would make an
  // already-computed (or already-rejected) quote look falsely "complete"
  // (TASK-19, CONVE-35).
  let discoveryStatusAtRequestStart = null;
  try {
    discoveryStatusAtRequestStart = getDiscoveryStatus();
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
        const errorMsg = `Pool ${poolId} not found in config`;
        logQuoteRequest({
          address,
          inputToken: inputTokenStr,
          outputToken: outputTokenStr,
          inputAmount: String(amount),
          outputAmount: null,
          minimumOutputAmount: null,
          rate: null,
          priceImpact: null,
          routeType: null,
          poolId: String(poolId),
          route: null,
          slippageTolerance: slippage,
          networkFeeEstimate: null,
          transactions: null,
          error: errorMsg
        });
        return res.status(400).json(withDiscoveryWarning({ error: errorMsg }, discoveryStatusAtRequestStart));
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
              const errorMsg = `No matching pools or routes found for token pair (${inputToken}, ${outputToken})`;
              logQuoteRequest({
                address,
                inputToken: inputTokenStr,
                outputToken: outputTokenStr,
                inputAmount: String(amount),
                outputAmount: null,
                minimumOutputAmount: null,
                rate: null,
                priceImpact: null,
                routeType: null,
                poolId: null,
                route: null,
                slippageTolerance: slippage,
                networkFeeEstimate: null,
                transactions: null,
                error: errorMsg
              });
              return res.status(400).json(withDiscoveryWarning({
                error: errorMsg,
                searchedDexes: dexList
              }, discoveryStatusAtRequestStart));
            }
          } catch (multiHopError) {
            console.warn('Failed to find optimal multi-hop route:', multiHopError.message);
            const dexList = dex && Array.isArray(dex) ? dex.join(', ') : 'all';
            const errorMsg = `No matching pools or routes found for token pair (${inputToken}, ${outputToken})`;
            logQuoteRequest({
              address,
              inputToken: inputTokenStr,
              outputToken: outputTokenStr,
              inputAmount: String(amount),
              outputAmount: null,
              minimumOutputAmount: null,
              rate: null,
              priceImpact: null,
              routeType: null,
              poolId: null,
              route: null,
              slippageTolerance: slippage,
              networkFeeEstimate: null,
              transactions: null,
              error: errorMsg
            });
            return res.status(400).json(withDiscoveryWarning({
              error: errorMsg,
              searchedDexes: dexList
            }, discoveryStatusAtRequestStart));
          }
        } else {
          const dexList = dex && Array.isArray(dex) ? dex.join(', ') : 'all';
          const errorMsg = `No matching pools or routes found for token pair (${inputToken}, ${outputToken})`;
          logQuoteRequest({
            address,
            inputToken: inputTokenStr,
            outputToken: outputTokenStr,
            inputAmount: String(amount),
            outputAmount: null,
            minimumOutputAmount: null,
            rate: null,
            priceImpact: null,
            routeType: null,
            poolId: null,
            route: null,
            slippageTolerance: slippage,
            networkFeeEstimate: null,
            transactions: null,
            error: errorMsg
          });
          return res.status(400).json(withDiscoveryWarning({
            error: errorMsg,
            searchedDexes: dexList
          }, discoveryStatusAtRequestStart));
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
          const errorMsg = 'Failed to calculate optimal split';
          logQuoteRequest({
            address,
            inputToken: inputTokenStr,
            outputToken: outputTokenStr,
            inputAmount: String(amount),
            outputAmount: null,
            minimumOutputAmount: null,
            rate: null,
            priceImpact: null,
            routeType: null,
            poolId: poolId ? String(poolId) : null,
            route: null,
            slippageTolerance: slippage,
            networkFeeEstimate: null,
            transactions: null,
            error: `${errorMsg}: ${splitError.message}`
          });
          return res.status(500).json(withDiscoveryWarning({
            error: errorMsg,
            message: splitError.message
          }, discoveryStatusAtRequestStart));
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
      // Handle both single-pool hops, split hops, and cross-route splits
      splitDetails = [];
      
      // Check if this is a cross-route split (quote already has splitDetails flattened)
      if (multiHopQuote.splitDetails && Array.isArray(multiHopQuote.splitDetails)) {
        // Cross-route split: splitDetails are already in the correct format
        splitDetails = multiHopQuote.splitDetails;
      } else if (multiHopQuote.hopQuotes && Array.isArray(multiHopQuote.hopQuotes)) {
        // Regular multi-hop: convert hopQuotes to splitDetails.
        //
        // The quote engine (calculateMultiHopQuote) already chains every hop's
        // input to the previous hop's output, and for split hops each split's
        // inputAmount is its proportional share of that hop's input (the shares
        // sum to the hop input). We therefore forward each split's own computed
        // amount unchanged: this forwards exactly the funds each hop receives,
        // with no double-count across splits and no arbitrary per-hop haircut.
        // Because these are the same input amounts the quote engine used to
        // derive expectedOutput/minimumOutputAmount, the reported outputs stay
        // aligned with what is actually forwarded on-chain.
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
      }
      
      platformFee = {
        gain: "0",
        feeAmount: "0",
        feeBps: 0,
        feeAddress: null,
        applied: false
      };
      routeType = 'multi-hop';
      hopQuotes = multiHopQuote.hopQuotes || [];
      multiHopPriceImpact = multiHopQuote.priceImpact;
    } else {
      const errorMsg = 'Failed to determine route: Neither direct nor multi-hop route could be calculated';
      logQuoteRequest({
        address,
        inputToken: inputTokenStr,
        outputToken: outputTokenStr,
        inputAmount: String(amount),
        outputAmount: null,
        minimumOutputAmount: null,
        rate: null,
        priceImpact: null,
        routeType: null,
        poolId: poolId ? String(poolId) : null,
        route: null,
        slippageTolerance: slippage,
        networkFeeEstimate: null,
        transactions: null,
        error: errorMsg
      });
      return res.status(500).json(withDiscoveryWarning({
        error: 'Failed to determine route',
        message: 'Neither direct nor multi-hop route could be calculated'
      }, discoveryStatusAtRequestStart));
    }

    // Fetch token prices
    let tokenPrices = {};
    try {
      const tokensToFetch = new Set([inputTokenStr, outputTokenStr]);
      if (splitDetails && Array.isArray(splitDetails)) {
        for (const split of splitDetails) {
          if (split.inputToken) tokensToFetch.add(String(split.inputToken));
          if (split.outputToken) tokensToFetch.add(String(split.outputToken));
        }
      }
      tokenPrices = await fetchTokenPrices(Array.from(tokensToFetch));
    } catch (priceError) {
      console.warn('Failed to fetch token prices:', priceError);
      // Continue without prices
    }

    // Build transactions (only if address is provided)
    let unsignedTransactions = [];
    let networkFee = 0;
    let simulationError = null;
    const MAX_TRANSACTIONS = 16; // Algorand transaction group limit

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
        simulationError = txnResult.simulationError || null;

        // Validate transaction count doesn't exceed Algorand's limit
        if (unsignedTransactions.length > MAX_TRANSACTIONS) {
          console.error(`[handleQuoteRequest] Transaction count ${unsignedTransactions.length} exceeds Algorand limit of ${MAX_TRANSACTIONS}`);
          return res.status(400).json(withDiscoveryWarning({
            error: 'Transaction group too large',
            message: `This swap requires ${unsignedTransactions.length} transactions, exceeding Algorand's limit of ${MAX_TRANSACTIONS}. Try a simpler route or reduce the number of pools.`,
            transactionCount: unsignedTransactions.length,
            maxTransactions: MAX_TRANSACTIONS
          }, discoveryStatusAtRequestStart));
        }
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
        
        // Calculate rate in normalized units (accounting for decimals) via the
        // shared helper so this error-path rate matches the success path exactly
        // (the previous truncating BigInt division reported 0 for most pairs).
        const inputDecimals = await getTokenDecimals(inputToken);
        const outputDecimals = await getTokenDecimals(outputToken);
        const overallRate = calculateRate(totalOutput, totalInput, inputDecimals, outputDecimals);

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
            networkFee: '0', // No transactions, so no network fee
            tokenValues: tokenPrices
          },
          unsignedTransactions: [],
          error: 'Failed to generate swap transactions: ' + txnError.message,
          route: buildRouteResponse(splitDetails, routeType, hopQuotes),
          // Surface the actual failure reason here instead of hardcoding null - unsignedTransactions
          // is already empty in this path, but a client checking simulationError alone should still
          // see an honest reason rather than a false "no error" signal.
          simulationError: txnError.message
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

        // Log to Supabase (fire and forget)
        logQuoteRequest({
          address,
          inputToken: inputTokenStr,
          outputToken: outputTokenStr,
          inputAmount: totalInput.toString(),
          outputAmount: totalOutput.toString(),
          minimumOutputAmount: totalMinOutput.toString(),
          rate: overallRate,
          priceImpact: weightedPriceImpact,
          routeType: routeType,
          poolId: response.poolId,
          route: response.route,
          slippageTolerance: slippage,
          networkFeeEstimate: '0',
          transactions: [],
          error: 'Failed to generate swap transactions: ' + txnError.message
        });

        // See the comment above handleQuote's discoveryStatusAtRequestStart
        // declaration for why this uses the request-start snapshot.
        return res.status(200).json(withDiscoveryWarning(response, discoveryStatusAtRequestStart));
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
    
    // Calculate rate in normalized units (accounting for decimals) via the
    // shared helper (single source of truth for the reported rate).
    const inputDecimals = await getTokenDecimals(inputToken);
    const outputDecimals = await getTokenDecimals(outputToken);
    const overallRate = calculateRate(totalOutput, totalInput, inputDecimals, outputDecimals);

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
    const quoteTimestamp = Date.now();
    const response = {
      quote: {
        inputAmount: totalInput.toString(),
        outputAmount: totalOutput.toString(),
        minimumOutputAmount: totalMinOutput.toString(),
        rate: overallRate,
        priceImpact: weightedPriceImpact,
        networkFee: networkFee.toString(), // Add network fee in microAlgos
        tokenValues: tokenPrices,
        timestamp: quoteTimestamp, // Unix timestamp in ms when quote was generated
        expiresAt: quoteTimestamp + 30000 // Quote recommended for use within 30 seconds
      },
      unsignedTransactions: unsignedTransactions,
      route: buildRouteResponse(splitDetails, routeType, hopQuotes),
      simulationError: simulationError || null
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

    // Log to Supabase (fire and forget)
    logQuoteRequest({
      address,
      inputToken: inputTokenStr,
      outputToken: outputTokenStr,
      inputAmount: totalInput.toString(),
      outputAmount: totalOutput.toString(),
      minimumOutputAmount: totalMinOutput.toString(),
      rate: overallRate,
      priceImpact: weightedPriceImpact,
      routeType: routeType,
      poolId: response.poolId,
      route: response.route,
      slippageTolerance: slippage,
      networkFeeEstimate: networkFee.toString(),
      transactions: unsignedTransactions,
      error: null
    });

    // Surface partial pool discovery directly on the quote (not just on
    // /health and /config/pools) - a caller hitting only /quote otherwise has
    // no signal that routing was computed over an incomplete pool set, which
    // could mean this quote is missing a better/only route through a pool
    // that's currently down and pending retry (CONVE-35, TASK-19). Uses the
    // request-start snapshot (see comment above handleQuote), not a fresh
    // read, so a background retry that completes mid-request can't make an
    // already-computed quote look falsely complete.
    res.json(withDiscoveryWarning(response, discoveryStatusAtRequestStart));

  } catch (error) {
    console.error('Error generating quote:', error);

    // Log error to Supabase (fire and forget)
    logQuoteRequest({
      address: params.address,
      inputToken: String(params.inputToken),
      outputToken: String(params.outputToken),
      inputAmount: String(params.amount),
      outputAmount: null,
      minimumOutputAmount: null,
      rate: null,
      priceImpact: null,
      routeType: null,
      poolId: params.poolId ? String(params.poolId) : null,
      route: null,
      slippageTolerance: params.slippage,
      networkFeeEstimate: null,
      transactions: null,
      error: error.message
    });

    // discoveryStatusAtRequestStart may still be null if the failure happened
    // before it could be captured (e.g. params itself was malformed) - fall
    // back to a fresh read rather than skip the warning on a 500.
    res.status(500).json(withDiscoveryWarning({
      error: 'Internal server error',
      message: error.message
    }, discoveryStatusAtRequestStart || getDiscoveryStatus()));
  }
}

export { handleQuote };

/**
 * Handle unwrap transaction generation
 * @param {Object} req
 * @param {Object} res
 */
export async function handleUnwrap(req, res) {
  try {
    const { address, items } = req.body || {};

    if (!address) {
      const errorMsg = 'Missing required field: address';
      logUnwrapRequest({
        address: null,
        items: null,
        networkFeeEstimate: null,
        transactions: null,
        error: errorMsg
      });
      return res.status(400).json({ error: errorMsg });
    }
    if (!Array.isArray(items) || items.length === 0) {
      const errorMsg = 'items array is required and must be non-empty';
      logUnwrapRequest({
        address,
        items: null,
        networkFeeEstimate: null,
        transactions: null,
        error: errorMsg
      });
      return res.status(400).json({ error: errorMsg });
    }

    try {
      const { transactions, networkFee, simulationError } = await buildBatchUnwrapTransactions({ address, items });
      const enrichedItems = items.map(i => {
        const info = getUnderlyingForWrapped(i.wrappedTokenId);
        const unwrappedId = info && (info.underlyingId !== null && info.underlyingId !== undefined)
          ? String(info.underlyingId)
          : null;
        return {
          wrappedTokenId: String(i.wrappedTokenId),
          unwrappedTokenId: unwrappedId,
          amount: typeof i.amount === 'bigint' ? i.amount.toString() : String(i.amount)
        };
      });
      const response = {
        success: true,
        address,
        items: enrichedItems,
        unsignedTransactions: transactions,
        networkFee: networkFee != null ? networkFee.toString() : '0',
        simulationError: simulationError || null
      };

      // Log to Supabase (fire and forget)
      logUnwrapRequest({
        address,
        items: enrichedItems,
        networkFeeEstimate: networkFee != null ? networkFee.toString() : '0',
        transactions: transactions,
        error: null
      });

      return res.json(response);
    } catch (error) {
      console.error('Error building unwrap transactions:', error);
      const lower = (error.message || '').toLowerCase();
      const isClientError =
        lower.includes('required') ||
        lower.includes('invalid') ||
        lower.includes('not recognized') ||
        lower.includes('exceeds') ||
        lower.includes('does not');

      const status = isClientError ? 400 : 500;

      // Log error to Supabase (fire and forget)
      const enrichedItems = items.map(i => {
        const info = getUnderlyingForWrapped(i.wrappedTokenId);
        const unwrappedId = info && (info.underlyingId !== null && info.underlyingId !== undefined)
          ? String(info.underlyingId)
          : null;
        return {
          wrappedTokenId: String(i.wrappedTokenId),
          unwrappedTokenId: unwrappedId,
          amount: typeof i.amount === 'bigint' ? i.amount.toString() : String(i.amount)
        };
      });
      logUnwrapRequest({
        address,
        items: enrichedItems,
        networkFeeEstimate: null,
        transactions: null,
        error: error.message
      });

      return res.status(status).json({
        error: status === 400 ? 'Invalid unwrap request' : 'Failed to generate unwrap transactions',
        message: error.message,
        // Keep this field present and honest even on the hard-failure path - a caller checking
        // simulationError alone (as it does on the success path) should still see the reason.
        simulationError: error.message
      });
    }
  } catch (error) {
    console.error('Unexpected error handling unwrap request:', error);
    
    // Log error to Supabase (fire and forget)
    const { address, items } = req.body || {};
    if (address && items) {
      const enrichedItems = items.map(i => {
        const info = getUnderlyingForWrapped(i.wrappedTokenId);
        const unwrappedId = info && (info.underlyingId !== null && info.underlyingId !== undefined)
          ? String(info.underlyingId)
          : null;
        return {
          wrappedTokenId: String(i.wrappedTokenId),
          unwrappedTokenId: unwrappedId,
          amount: typeof i.amount === 'bigint' ? i.amount.toString() : String(i.amount)
        };
      });
      logUnwrapRequest({
        address,
        items: enrichedItems,
        networkFeeEstimate: null,
        transactions: null,
        error: error.message
      });
    }
    
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}

