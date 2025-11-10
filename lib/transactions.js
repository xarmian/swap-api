import algosdk from 'algosdk';
import {
  buildSwapTransactions as buildNomadexSwapTransactions,
  getTokenTypeFromConfig
} from './nomadex.js';
import {
  resolveWrappedTokens,
  getPoolInfo
} from './humbleswap.js';
import {
  buildSwapTransactions as buildHumbleswapSwapTransactionsArccjs
} from './humbleswap-arccjs.js';
import { getTokenDecimals } from './utils.js';
import { getTokenMetaFromConfig } from './config.js';
import { algodClient, indexerClient } from './clients.js';

/**
 * Build a simulate request with allowUnnamedResources enabled
 * This allows us to discover boxes, apps, assets, and accounts that are needed
 * @param {Array<algosdk.Transaction>} transactions - Transactions to simulate
 * @param {Algodv2} algodClient - Algod client
 * @returns {Promise<Object>} Simulate request object
 */
async function buildSimulateRequest(transactions, algodClient) {
  // Get current status for round/timestamp/protocol
  const status = await algodClient.status().do();
  
  // Assign group ID to transactions
  // Transactions should already have group IDs assigned - don't reassign!
  // assignGroupID creates a NEW group ID each time, which would break the group
  // Just use the transactions as-is with their existing group IDs
  
  // Encode transactions for simulation
  // Use SimulateRequestTransactionGroup format
  // Match arccjs 2.11.5 approach: encode as unsigned, decode as obj
  const txnGroup = new algosdk.modelsv2.SimulateRequestTransactionGroup({
    txns: transactions.map((value, index) => {
      // Encode as unsigned transaction for simulation
      const encodedTxn = algosdk.encodeUnsignedSimulateTransaction(value);
      // Decode as object (arccjs uses decodeObj and spreads it)
      const decodedObj = algosdk.decodeObj(encodedTxn);
      // Return the decoded object directly (arccjs spreads it)
      return decodedObj;
    })
  });
  
  // Create simulate request with allowUnnamedResources enabled
  const request = new algosdk.modelsv2.SimulateRequest({
    txnGroups: [txnGroup],
    allowUnnamedResources: true, // This is the key - allows discovery of unnamed resources
    allowEmptySignatures: true,
    fixSigs: true
  });
  
  return request;
}

/**
 * Simulate a chunk of transactions (helper for chunked simulation)
 * @param {Array<algosdk.Transaction>} chunkTransactions - Transactions in this chunk
 * @param {Algodv2} algodClient - Algod client
 * @returns {Promise<Object>} Simulation results with unnamedResourcesAccessed
 */
async function simulateTransactionChunk(chunkTransactions, algodClient) {
  // Verify transactions are proper algosdk.Transaction objects
  for (const txn of chunkTransactions) {
    if (!txn || typeof txn.get_obj_for_encoding !== 'function') {
      throw new Error('Invalid transaction object: missing get_obj_for_encoding method');
    }
  }

  // Build simulate request with allowUnnamedResources
  const simulateRequest = await buildSimulateRequest(chunkTransactions, algodClient);

  // Execute simulation
  const simulateResponse = await algodClient.simulateTransactions(simulateRequest).do();
  
  return simulateResponse;
}

/**
 * Simulate an atomic transaction group using algodClient's simulateTransactions API
 * with allowUnnamedResources enabled to discover boxes, apps, assets, and accounts
 * If the group is too large (413 error), splits into chunks and simulates separately
 * @param {Array<algosdk.Transaction>} transactions - Array of transactions to simulate
 * @param {Algodv2} algodClient - Algod client
 * @returns {Promise<Object>} Simulation results with unnamedResourcesAccessed
 */
async function simulateTransactionGroup(transactions, algodClient) {
  try {
    // Verify transactions are proper algosdk.Transaction objects
    for (const txn of transactions) {
      if (!txn || typeof txn.get_obj_for_encoding !== 'function') {
        throw new Error('Invalid transaction object: missing get_obj_for_encoding method');
      }
    }

    // Build simulate request with allowUnnamedResources enabled
    const simulateRequest = await buildSimulateRequest(transactions, algodClient);

    // Try to execute simulation for the full group
    let simulateResponse;
    try {
      simulateResponse = await algodClient.simulateTransactions(simulateRequest).do();
    } catch (error) {
      // Check if this is a 413 Request Entity Too Large error
      const is413Error = error.statusCode === 413 || 
                        (error.response && error.response.status === 413) ||
                        (error.rawResponse && error.rawResponse.includes('413 Request Entity Too Large'));
      
      if (is413Error) {
        console.warn(`Transaction group too large (${transactions.length} transactions), splitting into chunks for simulation`);
        
        // Split into chunks - try smaller chunks first
        // Start with 10 transactions per chunk, reduce if still too large
        let CHUNK_SIZE = 10;
        const allBoxReferences = [];
        let hasErrors = false;
        let chunkStart = 0;
        
        while (chunkStart < transactions.length) {
          const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, transactions.length);
          const chunk = transactions.slice(chunkStart, chunkEnd);
          
          try {
            const chunkResponse = await simulateTransactionChunk(chunk, algodClient);
            
            // Extract unnamedResourcesAccessed from this chunk
            // The simulate response has txnGroups[0] with unnamedResourcesAccessed
            if (chunkResponse.txnGroups && chunkResponse.txnGroups.length > 0) {
              const txnGroup = chunkResponse.txnGroups[0];
              
              // Get group-level unnamedResourcesAccessed
              const groupUnnamed = txnGroup.unnamedResourcesAccessed || {};
              const groupBoxes = groupUnnamed.boxes || [];
              
              // Get per-transaction unnamedResourcesAccessed
              const txnResults = txnGroup.txnResults || [];
              
              for (let i = 0; i < txnResults.length; i++) {
                const txnResult = txnResults[i];
                const globalIndex = chunkStart + i; // Adjust index to global position
                
                // Get transaction-level unnamedResourcesAccessed
                const txnUnnamed = txnResult.unnamedResourcesAccessed || {};
                const txnBoxes = txnUnnamed.boxes || [];
                
                // Combine group and transaction boxes
                const allBoxes = [...groupBoxes, ...txnBoxes];
                
                for (const box of allBoxes) {
                  if (box.app !== undefined && box.name) {
                    const appIndex = typeof box.app === 'number' ? box.app : Number(box.app);
                    // Box name is already a Uint8Array in the response
                    const boxName = box.name instanceof Uint8Array 
                      ? box.name 
                      : typeof box.name === 'string'
                        ? new Uint8Array(Buffer.from(box.name, 'base64'))
                        : new Uint8Array(box.name);
                    
                    // Check if we already have this box reference
                    const exists = allBoxReferences.some(ref => 
                      ref.txnIndex === globalIndex && 
                      ref.appIndex === appIndex &&
                      ref.name.length === boxName.length &&
                      ref.name.every((val, idx) => val === boxName[idx])
                    );
                    
                    if (!exists) {
                      allBoxReferences.push({
                        txnIndex: globalIndex,
                        appIndex: appIndex,
                        name: boxName
                      });
                    }
                  }
                }
                
                // Check for errors
                if (txnResult.appCallTrace) {
                  for (const trace of txnResult.appCallTrace) {
                    if (trace.error) {
                      hasErrors = true;
                    }
                  }
                }
                if (txnResult.logicSigTrace) {
                  for (const trace of txnResult.logicSigTrace) {
                    if (trace.error) {
                      hasErrors = true;
                    }
                  }
                }
              }
            }
            
            // Successfully simulated this chunk, move to next
            chunkStart = chunkEnd;
          } catch (chunkError) {
            // Check if this chunk is also too large
            const isChunk413 = chunkError.statusCode === 413 || 
                             (chunkError.response && chunkError.response.status === 413) ||
                             (chunkError.rawResponse && chunkError.rawResponse.includes('413 Request Entity Too Large'));
            
            if (isChunk413 && CHUNK_SIZE > 1) {
              // Chunk is still too large, reduce chunk size and retry
              CHUNK_SIZE = Math.max(1, Math.floor(CHUNK_SIZE / 2));
              console.warn(`Chunk still too large, reducing chunk size to ${CHUNK_SIZE} and retrying`);
              // Don't advance chunkStart, retry with smaller chunk
            } else {
              // Other error or chunk size is already 1, log and continue
              console.warn(`Failed to simulate chunk [${chunkStart}-${chunkEnd}]:`, chunkError.message);
              hasErrors = true;
              chunkStart = chunkEnd; // Move to next chunk
            }
          }
        }
        
        return {
          success: !hasErrors,
          boxReferences: allBoxReferences,
          unnamedResourcesAccessed: null, // No single response for chunked simulation
          simulateResponse: null,
          error: hasErrors ? 'Some chunks had simulation errors' : null
        };
      }
      
      // Not a 413 error - log and rethrow
      console.error('=== SIMULATE ERROR - RAW RESPONSE ===');
      if (error.rawResponse !== undefined) {
        console.error('Raw response (from SDK):', error.rawResponse);
        console.error('Raw response length:', error.rawResponse?.length || 0);
      }
      if (error.statusCode !== undefined) {
        console.error('HTTP Status Code:', error.statusCode);
      }
      
      if (error.response) {
        console.error('Error response object exists');
        console.error('Response status:', error.response.status);
        if (error.response.body) {
          let bodyText = '';
          try {
            if (error.response.body instanceof Uint8Array) {
              bodyText = Buffer.from(error.response.body).toString('utf-8');
            } else if (Buffer.isBuffer(error.response.body)) {
              bodyText = error.response.body.toString('utf-8');
            } else {
              bodyText = String(error.response.body);
            }
            console.error('Response body:', bodyText);
          } catch (e) {
            console.error('Could not decode response body:', e.message);
          }
        }
        if (error.response.text) {
          console.error('Response text:', error.response.text);
        }
      }
      
      console.error('Error name:', error.name);
      console.error('Error message:', error.message);
      console.error('=== END SIMULATE ERROR ===');
      
      throw error;
    }

    // Extract unnamedResourcesAccessed from simulation results
    const boxReferences = [];
    let unnamedResourcesAccessed = null;
    
    // Debug: Log the full simulation response structure
    console.log('\n[simulateTransactionGroup] Simulation response structure:');
    console.log('  txnGroups length:', simulateResponse.txnGroups?.length || 0);
    if (simulateResponse.txnGroups && simulateResponse.txnGroups.length > 0) {
      const txnGroup = simulateResponse.txnGroups[0];
      console.log('  txnGroup keys:', Object.keys(txnGroup));
      console.log('  unnamedResourcesAccessed:', !!txnGroup.unnamedResourcesAccessed);
      console.log('  txnResults length:', txnGroup.txnResults?.length || 0);
      
      // Get group-level unnamedResourcesAccessed
      unnamedResourcesAccessed = txnGroup.unnamedResourcesAccessed || {};
      const groupBoxes = unnamedResourcesAccessed.boxes || [];
      const groupApps = unnamedResourcesAccessed.apps || [];
      const groupAssets = unnamedResourcesAccessed.assets || [];
      console.log('  Group-level boxes:', groupBoxes.length);
      console.log('  Group-level apps:', groupApps.length);
      console.log('  Group-level assets:', groupAssets.length);
      
      // Get per-transaction unnamedResourcesAccessed
      const txnResults = txnGroup.txnResults || [];
      
      // Log per-transaction unnamedResourcesAccessed
      for (let i = 0; i < txnResults.length; i++) {
        const txnResult = txnResults[i];
        const txnUnnamed = txnResult.unnamedResourcesAccessed || {};
        const txnBoxes = txnUnnamed.boxes || [];
        const txnApps = txnUnnamed.apps || [];
        const txnAssets = txnUnnamed.assets || [];
        if (txnBoxes.length > 0) {
          console.log(`  Txn ${i} unnamedResourcesAccessed boxes:`, txnBoxes.length);
        }
        if (txnApps.length > 0) {
          console.log(`  Txn ${i} unnamedResourcesAccessed apps:`, txnApps);
        }
        if (txnAssets.length > 0) {
          console.log(`  Txn ${i} unnamedResourcesAccessed assets:`, txnAssets);
        }
      }
      
      for (let i = 0; i < txnResults.length; i++) {
        const txnResult = txnResults[i];
        
        // Get transaction-level unnamedResourcesAccessed
        const txnUnnamed = txnResult.unnamedResourcesAccessed || {};
        const txnBoxes = txnUnnamed.boxes || [];
        
        // Combine group and transaction boxes
        const allBoxes = [...groupBoxes, ...txnBoxes];
        
        for (const box of allBoxes) {
          if (box.app !== undefined && box.name) {
            const appIndex = typeof box.app === 'number' ? box.app : Number(box.app);
            // Box name is already a Uint8Array in the response
            const boxName = box.name instanceof Uint8Array 
              ? box.name 
              : typeof box.name === 'string'
                ? new Uint8Array(Buffer.from(box.name, 'base64'))
                : new Uint8Array(box.name);
            
            // Check if we already have this box reference
            const exists = boxReferences.some(ref => 
              ref.txnIndex === i && 
              ref.appIndex === appIndex &&
              ref.name.length === boxName.length &&
              ref.name.every((val, idx) => val === boxName[idx])
            );
            
            if (!exists) {
              boxReferences.push({
                txnIndex: i,
                appIndex: appIndex,
                name: boxName
              });
            }
          }
        }
      }
    }

    // Check if simulation was successful
    // With allowUnnamedResources: true, we can still get resource information even if there are errors
    // This is especially important for multi-hop routes where intermediate tokens don't exist yet
    const txnGroup = simulateResponse.txnGroups?.[0];
    const failureMessage = txnGroup?.failureMessage;
    const txnResults = txnGroup?.txnResults || [];
    
    // Log detailed error information for debugging
    if (failureMessage) {
      console.error('\n[simulateTransactionGroup] Group-level failure:', failureMessage);
    }
    
    // Extract resources from error messages - this is how we discover what's needed dynamically!
    // Error formats:
    // - "unavailable App {appId}" - missing foreign app
    // - "unavailable Local State {appId}+{accountAddress} would be accessible" - missing account for local state
    const accountsFromErrors = new Set();
    const appsFromErrors = new Set();
    if (failureMessage) {
      // Extract missing apps: "unavailable App {appId}" or "unavailable App {appId}. Details: app={txnAppId}"
      // Try both formats - with and without Details
      const unavailableAppMatches = failureMessage.matchAll(/unavailable App (\d+)(?:\. Details: app=(\d+))?/g);
      for (const match of unavailableAppMatches) {
        const appId = Number(match[1]);
        const txnAppId = match[2] ? Number(match[2]) : null;
        appsFromErrors.add(appId);
        if (txnAppId) {
          console.log(`[simulateTransactionGroup] Extracted missing app ${appId} from group-level error (needed by app ${txnAppId})`);
        } else {
          console.log(`[simulateTransactionGroup] Extracted missing app ${appId} from group-level error`);
        }
      }
      
      // Extract accounts: "unavailable Local State {appId}+{accountAddress}"
      const localStateMatches = failureMessage.matchAll(/unavailable Local State (\d+)\+([A-Z2-7]{58})/g);
      let accountMatchCount = 0;
      for (const match of localStateMatches) {
        const appId = Number(match[1]);
        const accountAddr = match[2];
        accountsFromErrors.add(accountAddr);
        accountMatchCount++;
        console.log(`[simulateTransactionGroup] Extracted account ${accountAddr} from group-level error (needed for app ${appId} local state)`);
      }
      
      if (unavailableAppMatches.length === 0 && accountMatchCount === 0) {
        console.log(`[simulateTransactionGroup] No resources found in failureMessage (checked for "unavailable App" and "unavailable Local State")`);
      }
    } else {
      console.log(`[simulateTransactionGroup] No failureMessage to extract resources from`);
    }
    
    const errors = [];
    for (let i = 0; i < txnResults.length; i++) {
      const txnResult = txnResults[i];
      
      // Check app call traces
      if (txnResult.appCallTrace) {
        for (const trace of txnResult.appCallTrace) {
          if (trace.error) {
            const errorMsg = trace.error || trace.message || '';
            
            // Extract missing apps: "unavailable App {appId}" or "unavailable App {appId}. Details: app={txnAppId}"
            const unavailableAppMatches = errorMsg.matchAll(/unavailable App (\d+)(?:\. Details: app=(\d+))?/g);
            for (const match of unavailableAppMatches) {
              const appId = Number(match[1]);
              const txnAppId = match[2] ? Number(match[2]) : null;
              appsFromErrors.add(appId);
              if (txnAppId) {
                console.log(`[simulateTransactionGroup] Extracted missing app ${appId} from transaction ${i} appCall trace (needed by app ${txnAppId})`);
              } else {
                console.log(`[simulateTransactionGroup] Extracted missing app ${appId} from transaction ${i} appCall trace`);
              }
            }
            
            // Extract accounts: "unavailable Local State {appId}+{accountAddress}"
            const localStateMatches = errorMsg.matchAll(/unavailable Local State (\d+)\+([A-Z2-7]{58})/g);
            for (const match of localStateMatches) {
              const appId = Number(match[1]);
              const accountAddr = match[2];
              accountsFromErrors.add(accountAddr);
              console.log(`[simulateTransactionGroup] Extracted account ${accountAddr} from transaction ${i} appCall trace (needed for app ${appId} local state)`);
            }
            
            errors.push({
              txnIndex: i,
              type: 'appCall',
              error: trace.error,
              message: trace.message || trace.error,
              pc: trace.pc,
              opcodes: trace.opcodes
            });
          }
        }
      }
      
      // Check logic sig traces
      if (txnResult.logicSigTrace) {
        for (const trace of txnResult.logicSigTrace) {
          if (trace.error) {
            const errorMsg = trace.error || trace.message || '';
            
            // Extract missing apps: "unavailable App {appId}" or "unavailable App {appId}. Details: app={txnAppId}"
            const unavailableAppMatches = errorMsg.matchAll(/unavailable App (\d+)(?:\. Details: app=(\d+))?/g);
            for (const match of unavailableAppMatches) {
              const appId = Number(match[1]);
              const txnAppId = match[2] ? Number(match[2]) : null;
              appsFromErrors.add(appId);
              if (txnAppId) {
                console.log(`[simulateTransactionGroup] Extracted missing app ${appId} from transaction ${i} logicSig trace (needed by app ${txnAppId})`);
              } else {
                console.log(`[simulateTransactionGroup] Extracted missing app ${appId} from transaction ${i} logicSig trace`);
              }
            }
            
            // Extract accounts: "unavailable Local State {appId}+{accountAddress}"
            const localStateMatches = errorMsg.matchAll(/unavailable Local State (\d+)\+([A-Z2-7]{58})/g);
            for (const match of localStateMatches) {
              const appId = Number(match[1]);
              const accountAddr = match[2];
              accountsFromErrors.add(accountAddr);
              console.log(`[simulateTransactionGroup] Extracted account ${accountAddr} from transaction ${i} logicSig trace (needed for app ${appId} local state)`);
            }
            
            errors.push({
              txnIndex: i,
              type: 'logicSig',
              error: trace.error,
              message: trace.message || trace.error,
              pc: trace.pc,
              opcodes: trace.opcodes
            });
          }
        }
      }
    }
    
    // Log all errors found
    if (errors.length > 0) {
      console.error(`\n[simulateTransactionGroup] Found ${errors.length} error(s) in simulation:`);
      for (const err of errors) {
        console.error(`  [Txn ${err.txnIndex}] ${err.type} error:`, err.message || err.error);
        if (err.pc !== undefined) {
          console.error(`    PC: ${err.pc}`);
        }
        if (err.opcodes) {
          console.error(`    Opcodes: ${err.opcodes}`);
        }
      }
    }
    
    const hasErrors = !!failureMessage || errors.length > 0;

    // Even if there are errors, if we got box references, consider it a partial success
    // The errors might be expected (e.g., missing intermediate tokens in multi-hop routes)
    // but we still want to extract the box information
    const hasBoxReferences = boxReferences.length > 0;
    const success = !hasErrors || hasBoxReferences; // Success if no errors OR we got box references

    if (hasErrors && !hasBoxReferences) {
      console.error(`[simulateTransactionGroup] Simulation failed with errors and no box references found`);
    } else if (hasErrors && hasBoxReferences) {
      console.warn(`[simulateTransactionGroup] Simulation had errors but found ${boxReferences.length} box reference(s)`);
    }

    return {
      success: success,
      boxReferences: boxReferences,
      unnamedResourcesAccessed: unnamedResourcesAccessed,
      simulateResponse: simulateResponse,
      errors: errors,
      accountsFromErrors: Array.from(accountsFromErrors), // Accounts extracted from error messages
      appsFromErrors: Array.from(appsFromErrors), // Apps extracted from error messages (e.g., "unavailable App {appId}")
      error: hasErrors && !hasBoxReferences ? 'Simulation detected errors and no box references found' : 
             hasErrors ? 'Simulation detected errors but box references were found' : null
    };
  } catch (error) {
    console.warn('Failed to simulate transaction group:', error.message);
    return {
      success: false,
      boxReferences: [],
      error: error.message
    };
  }
}

/**
 * Get ARC200 transfer method (re-exported from nomadex for convenience)
 */
function getARC200TransferMethod() {
  return new algosdk.ABIMethod({
    name: 'arc200_transfer',
    args: [
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'value' }
    ],
    returns: { type: 'bool' }
  });
}

/**
 * Determine output token type for fee payment
 * @param {string|number} outputToken - Output token ID
 * @param {Array<Object>} splitDetails - Split details with pool configs
 * @returns {Promise<string>} Token type: 'native', 'ASA', or 'ARC200'
 */
async function determineOutputTokenType(outputToken, splitDetails) {
  const outputTokenNum = Number(outputToken);
  
  // Native token (VOI)
  if (outputTokenNum === 0) {
    return 'native';
  }
  
  // Try to get token type from pool configs (works for Nomadex)
  for (const split of splitDetails) {
    const poolCfg = split.poolCfg;
    if (poolCfg.dex === 'nomadex') {
      const tokenType = getTokenTypeFromConfig(poolCfg, outputTokenNum);
      if (tokenType) {
        return tokenType;
      }
    }
  }
  
  // For HumbleSwap or if not found in config, try to determine from token metadata
  // Check if it's an ARC200 by looking at token config or trying to fetch as ASA
  try {
    const assetInfo = await indexerClient.lookupAssetByID(outputTokenNum).do();
    if (assetInfo && assetInfo.asset) {
      return 'ASA';
    }
  } catch (error) {
    // Asset not found, might be ARC200
    // For now, assume ARC200 if not found as ASA
    // This is a reasonable assumption since ARC200 tokens are contracts
    return 'ARC200';
  }
  
  return 'ASA'; // Default fallback
}

/**
 * Build transactions for one or more pools and combine into single atomic group
 * @param {Array<Object>} splitDetails - Array from calculateOptimalSplit: { poolCfg, amount, expectedOutput, minOutput, quote }
 * @param {string|number} inputToken - Input token ID (underlying token)
 * @param {string|number} outputToken - Output token ID (underlying token)
 * @param {number} slippage - Slippage tolerance
 * @param {string} address - User's address (optional)
 * @param {Object|null} platformFee - Platform fee info: { feeAmount: string, feeAddress: string } or null
 * @returns {Promise<Array<string>>} Array of base64-encoded unsigned transactions
 */
async function buildSwapTransactions(splitDetails, inputToken, outputToken, slippage, address, platformFee = null) {
  // Return empty array if address is not provided
  if (!address) {
    return [];
  }
  
  const allTransactions = [];
  
  // Detect if this is a multi-hop route (each split has its own input/output tokens)
  const isMultiHop = splitDetails.length > 0 && splitDetails[0].inputToken !== undefined;
  // Check if any hop uses HumbleSwap (these swaps rely on simulation to discover boxes)
  const routeContainsHumbleSwap = splitDetails.some(split => split?.poolCfg?.dex === 'humbleswap');
  
  // For multi-hop routes (and any route containing HumbleSwap swaps),
  // we need to build all transactions first without simulation, then
  // simulate the entire group together to get proper box references
  const shouldSimulateGroup = isMultiHop || routeContainsHumbleSwap;
  
  // Track wrapped tokens produced by each hop for optimization
  // This allows us to skip withdraw/deposit when intermediate tokens are already in wrapped form
  const hopOutputWrappedTokens = new Map(); // hop index -> output wrapped token ID
  
  for (let i = 0; i < splitDetails.length; i++) {
    const split = splitDetails[i];
    const { poolCfg, amount, minOutput, quote } = split;
    const poolId = Number(poolCfg.poolId);
    const dex = poolCfg.dex || 'humbleswap';
    
    // For multi-hop routes, use the split's own tokens; otherwise use the route's tokens
    const splitInputToken = isMultiHop ? split.inputToken : inputToken;
    const splitOutputToken = isMultiHop ? split.outputToken : outputToken;
    
    const inputTokenStr = String(splitInputToken);
    const outputTokenStr = String(splitOutputToken);
    const inputTokenNum = Number(splitInputToken);
    const outputTokenNum = Number(splitOutputToken);
    const amountBigInt = BigInt(amount);
    
    if (dex === 'nomadex') {
      // Build Nomadex transactions
      const inputTokenType = getTokenTypeFromConfig(poolCfg, inputTokenNum);
      const outputTokenType = getTokenTypeFromConfig(poolCfg, outputTokenNum);
      
      if (!inputTokenType || !outputTokenType) {
        throw new Error(`Could not determine token types for pool ${poolId}`);
      }
      
      const isDirectionAlphaToBeta = quote.poolInfo.isDirectionAlphaToBeta;
      
      console.log(`\n[buildSwapTransactions] Building Nomadex swap transaction:`);
      console.log(`  Pool: ${poolId}, Input: ${inputTokenNum} (${inputTokenType}), Output: ${outputTokenNum} (${outputTokenType})`);
      console.log(`  Amount In: ${amountBigInt.toString()}, Min Amount Out: ${minOutput}`);
      console.log(`  Direction: ${isDirectionAlphaToBeta ? 'Alpha->Beta' : 'Beta->Alpha'}\n`);
      
      // Apply safety margin to minimum output
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
      // IMPORTANT: We need to preserve foreignAssets and foreignApps when decoding
      // because they're needed for the app call to access asset/app information
      const decodedTxns = [];
      for (let idx = 0; idx < poolTransactions.length; idx++) {
        const txnBase64 = poolTransactions[idx];
        const txn = algosdk.decodeUnsignedTransaction(Buffer.from(txnBase64, 'base64'));
        
        // For ARC200 transfer transactions (if input is ARC200), preserve boxes
        if (txn.type === 'appl' && inputTokenType === 'ARC200' && inputTokenNum !== 0 && txn.appIndex === inputTokenNum) {
          // This is the ARC200 transfer transaction - preserve its boxes
          if (txn.boxes && txn.boxes.length > 0) {
            // Boxes are already on the transaction, just use it as-is
            decodedTxns.push(txn);
            continue;
          } else {
            // Reconstruct boxes for ARC200 transfer transaction
            const balancesPrefix = Buffer.from('balances', 'utf-8');
            const senderAddressBytes = algosdk.decodeAddress(address).publicKey;
            const poolAddressBytes = algosdk.decodeAddress(algosdk.getApplicationAddress(poolId)).publicKey;
            
            const arc200Boxes = [
              {
                appIndex: inputTokenNum,
                name: new Uint8Array(Buffer.concat([balancesPrefix, senderAddressBytes]))
              },
              {
                appIndex: inputTokenNum,
                name: new Uint8Array(Buffer.concat([balancesPrefix, poolAddressBytes]))
              }
            ];
            
            // Rebuild the transaction with boxes
            const fromAddress = algosdk.encodeAddress(txn.from.publicKey);
            const suggestedParams = await algodClient.getTransactionParams().do();
            
            const arc200TxnObj = {
              from: fromAddress,
              appIndex: txn.appIndex,
              onComplete: txn.appOnComplete,
              appArgs: txn.appArgs,
              foreignApps: txn.foreignApps || [],
              foreignAssets: txn.foreignAssets || [],
              boxes: arc200Boxes,
              suggestedParams: {
                ...suggestedParams,
                fee: txn.fee,
                firstRound: txn.firstRound,
                lastRound: txn.lastRound,
                genesisHash: txn.genesisHash,
                genesisID: txn.genesisID
              }
            };
            
            const rebuiltArc200Txn = algosdk.makeApplicationCallTxnFromObject(arc200TxnObj);
            // Manually set boxes after creation
            rebuiltArc200Txn.boxes = arc200Boxes;
            decodedTxns.push(rebuiltArc200Txn);
            continue;
          }
        }
        
        // For app call transactions, rebuild them properly with foreignAssets/foreignApps
        // Simply setting properties doesn't work - we need to rebuild the transaction
        if (txn.type === 'appl' && txn.appIndex === poolId) {
          // IMPORTANT: Preserve foreignApps from Nomadex transaction (includes factory app 411751)
          // Nomadex sets these in buildNomadexSwapTransactions, and we must preserve them
          const preservedForeignApps = txn.foreignApps || [];
          
          console.log(`[buildSwapTransactions] Decoded Nomadex transaction for app ${poolId}, foreignApps:`, preservedForeignApps);
          
          // Rebuild foreignAssets array based on token types
          const foreignAssets = [];
          if (inputTokenType === 'ASA' && inputTokenNum !== 0) {
            foreignAssets.push(inputTokenNum);
          }
          if (outputTokenType === 'ASA' && outputTokenNum !== 0) {
            foreignAssets.push(outputTokenNum);
          }
          const uniqueForeignAssets = [...new Set(foreignAssets)];
          
          // Use preserved foreignApps from Nomadex (includes factory app 411751)
          // ALWAYS include factory app 411751 for Nomadex pools - it's required!
          const factoryAppId = 411751;
          let foreignApps = preservedForeignApps.length > 0 ? [...preservedForeignApps] : [factoryAppId];
          
          // Ensure factory app is always included
          if (!foreignApps.includes(factoryAppId)) {
            foreignApps.unshift(factoryAppId); // Add to beginning
            console.log(`[buildSwapTransactions] Added factory app ${factoryAppId} to Nomadex transaction (was missing)`);
          }
          
          // Ensure ARC200 contract IDs are included if needed
          if (inputTokenType === 'ARC200' && inputTokenNum !== 0) {
            if (!foreignApps.includes(inputTokenNum)) {
              foreignApps.push(inputTokenNum);
            }
          }
          if (outputTokenType === 'ARC200' && outputTokenNum !== 0) {
            if (!foreignApps.includes(outputTokenNum)) {
              foreignApps.push(outputTokenNum);
            }
          }
          
          console.log(`[buildSwapTransactions] Final Nomadex foreignApps for app ${poolId}:`, foreignApps);
          
          // Rebuild the app call transaction with proper foreignAssets/foreignApps
          // Use makeApplicationCallTxnFromObject to ensure these are properly encoded
          // Convert txn.from (Uint8Array) to address string
          const fromAddress = algosdk.encodeAddress(txn.from.publicKey);
          const suggestedParams = await algodClient.getTransactionParams().do();
          
          // Extract box references from original transaction if present
          // Boxes are stored as an array of { appIndex, name } objects
          let boxes = undefined;
          
          // Check if boxes exist in the decoded transaction
          // Note: algosdk might store boxes differently, so we need to check various properties
          const txnBoxes = txn.boxes || txn.boxReferences || [];
          
          if (txnBoxes && Array.isArray(txnBoxes) && txnBoxes.length > 0) {
            // Preserve boxes from original transaction
            // Ensure appIndex is a number and name is a Uint8Array
            boxes = [];
            for (const box of txnBoxes) {
              try {
                // Convert appIndex to number if needed
                let appIndex;
                if (typeof box.appIndex === 'number') {
                  appIndex = box.appIndex;
                } else if (typeof box.appIndex === 'string' || typeof box.appIndex === 'bigint') {
                  appIndex = Number(box.appIndex);
                } else {
                  appIndex = Number(box.appIndex);
                }
                
                // Ensure appIndex is a valid number
                if (isNaN(appIndex) || appIndex < 0 || !Number.isInteger(appIndex)) {
                  continue;
                }
                
                // Convert name to Uint8Array if needed
                let name;
                if (box.name instanceof Uint8Array) {
                  name = box.name;
                } else if (box.name instanceof Buffer) {
                  name = new Uint8Array(box.name);
                } else if (Array.isArray(box.name)) {
                  name = new Uint8Array(box.name);
                } else if (typeof box.name === 'string') {
                  // If it's a hex string, decode it
                  if (box.name.startsWith('0x')) {
                    name = new Uint8Array(Buffer.from(box.name.slice(2), 'hex'));
                  } else {
                    name = new Uint8Array(Buffer.from(box.name, 'utf-8'));
                  }
                } else {
                  continue;
                }
                
                // Final type check
                if (typeof appIndex !== 'number' || !(name instanceof Uint8Array)) {
                  continue;
                }
                
                boxes.push({
                  appIndex: appIndex,
                  name: name
                });
              } catch (e) {
                continue;
              }
            }
          }
          
          // If no boxes were extracted and ARC200 tokens are involved, reconstruct them
          if ((!boxes || boxes.length === 0) && (inputTokenType === 'ARC200' || outputTokenType === 'ARC200')) {
            // If boxes are missing but ARC200 tokens are involved, reconstruct them
            // ARC200 uses "balances" + address format for balance boxes
            const balancesPrefix = Buffer.from('balances', 'utf-8');
            const poolAddress = algosdk.getApplicationAddress(poolId);
            
            // Initialize boxes array if needed
            if (!boxes) {
              boxes = [];
            }
            
            if (inputTokenType === 'ARC200' && inputTokenNum !== 0) {
              // Add sender's balance box
              const senderAddressBytes = algosdk.decodeAddress(address).publicKey;
              const senderBoxNameBuffer = Buffer.concat([balancesPrefix, senderAddressBytes]);
              const senderBoxName = new Uint8Array(senderBoxNameBuffer);
              
              // Ensure we have valid types
              const inputTokenAppIndex = inputTokenNum;
              if (isNaN(inputTokenAppIndex) || inputTokenAppIndex < 0) {
                throw new Error(`Invalid input token appIndex: ${inputTokenNum}`);
              }
              
              boxes.push({
                appIndex: inputTokenAppIndex,
                name: senderBoxName
              });
              
              // Add pool's balance box
              const poolAddressBytes = algosdk.decodeAddress(poolAddress).publicKey;
              const poolBoxNameBuffer = Buffer.concat([balancesPrefix, poolAddressBytes]);
              const poolBoxName = new Uint8Array(poolBoxNameBuffer);
              
              boxes.push({
                appIndex: inputTokenAppIndex,
                name: poolBoxName
              });
            }
            
            if (outputTokenType === 'ARC200' && outputTokenNum !== 0) {
              const outputTokenAppIndex = outputTokenNum;
              if (isNaN(outputTokenAppIndex) || outputTokenAppIndex < 0) {
                throw new Error(`Invalid output token appIndex: ${outputTokenNum}`);
              }
              
              // Add sender's balance box (if not already added for this contract)
              const senderAddressBytes = algosdk.decodeAddress(address).publicKey;
              const senderBoxNameBuffer = Buffer.concat([balancesPrefix, senderAddressBytes]);
              const senderBoxName = new Uint8Array(senderBoxNameBuffer);
              
              const existingSender = boxes.find(b => {
                if (b.appIndex !== outputTokenAppIndex) return false;
                if (!(b.name instanceof Uint8Array)) return false;
                if (b.name.length !== senderBoxName.length) return false;
                return b.name.every((val, idx) => val === senderBoxName[idx]);
              });
              
              if (!existingSender) {
                boxes.push({
                  appIndex: outputTokenAppIndex,
                  name: senderBoxName
                });
              }
              
              // Add pool's balance box (if not already added for this contract)
              const poolAddressBytes = algosdk.decodeAddress(poolAddress).publicKey;
              const poolBoxNameBuffer = Buffer.concat([balancesPrefix, poolAddressBytes]);
              const poolBoxName = new Uint8Array(poolBoxNameBuffer);
              
              const existingPool = boxes.find(b => {
                if (b.appIndex !== outputTokenAppIndex) return false;
                if (!(b.name instanceof Uint8Array)) return false;
                if (b.name.length !== poolBoxName.length) return false;
                return b.name.every((val, idx) => val === poolBoxName[idx]);
              });
              
              if (!existingPool) {
                boxes.push({
                  appIndex: outputTokenAppIndex,
                  name: poolBoxName
                });
              }
            }
          }
          
          // Validate boxes format before including in transaction
          // Ensure all boxes have valid appIndex (number) and name (Uint8Array)
          if (boxes && boxes.length > 0) {
            // Validate and normalize each box
            const validatedBoxes = [];
            for (const box of boxes) {
              // Ensure appIndex is a number
              let appIndex;
              if (typeof box.appIndex === 'number') {
                appIndex = box.appIndex;
              } else if (typeof box.appIndex === 'string' || typeof box.appIndex === 'bigint') {
                appIndex = Number(box.appIndex);
              } else {
                appIndex = Number(box.appIndex);
              }
              
              if (isNaN(appIndex) || appIndex < 0 || !Number.isInteger(appIndex)) {
                throw new Error(`Invalid box appIndex: ${box.appIndex} (type: ${typeof box.appIndex})`);
              }
              
              // Ensure name is a Uint8Array
              let name;
              if (box.name instanceof Uint8Array) {
                name = box.name;
              } else if (box.name instanceof Buffer) {
                name = new Uint8Array(box.name);
              } else if (Array.isArray(box.name)) {
                name = new Uint8Array(box.name);
              } else {
                throw new Error(`Box name must be Uint8Array, Buffer, or Array, got: ${typeof box.name}, value: ${box.name}`);
              }
              
              // Final validation - ensure types are exactly right
              if (typeof appIndex !== 'number') {
                throw new Error(`Box appIndex is not a number after conversion: ${appIndex} (type: ${typeof appIndex})`);
              }
              if (!(name instanceof Uint8Array)) {
                throw new Error(`Box name is not a Uint8Array after conversion: ${name} (type: ${typeof name})`);
              }
              
              validatedBoxes.push({
                appIndex: appIndex,
                name: name
              });
            }
            boxes = validatedBoxes;
          }
          
          // Build transaction object, only including optional fields if they exist and are valid
          const txnObj = {
            from: fromAddress,
            appIndex: txn.appIndex,
            onComplete: txn.appOnComplete,
            appArgs: txn.appArgs,
            foreignApps: foreignApps.length > 0 ? foreignApps : undefined,
            foreignAssets: uniqueForeignAssets.length > 0 ? uniqueForeignAssets : undefined,
            suggestedParams: {
              ...suggestedParams,
              fee: txn.fee,
              firstRound: txn.firstRound,
              lastRound: txn.lastRound,
              genesisHash: txn.genesisHash,
              genesisID: txn.genesisID
            }
          };
          
          // Only include boxes if they exist and are valid
          // Double-check that all boxes are properly formatted before including
          if (boxes && Array.isArray(boxes) && boxes.length > 0) {
            // Final validation - ensure every box has correct types
            const finalBoxes = [];
            for (const box of boxes) {
              // Strict type checking
              if (!box || typeof box !== 'object' || !('appIndex' in box) || !('name' in box)) {
                continue;
              }
              
              const appIndex = typeof box.appIndex === 'number' ? box.appIndex : Number(box.appIndex);
              if (isNaN(appIndex) || appIndex < 0 || !Number.isInteger(appIndex)) {
                continue;
              }
              
              if (!(box.name instanceof Uint8Array)) {
                continue;
              }
              
              // All checks passed - create a completely fresh object to ensure no prototype issues
              const validBox = {
                appIndex: Number(appIndex),
                name: new Uint8Array(box.name)
              };
              
              // Final verification before adding
              if (typeof validBox.appIndex !== 'number' || !(validBox.name instanceof Uint8Array)) {
                continue;
              }
              
              finalBoxes.push(validBox);
            }
            
            if (finalBoxes.length > 0) {
              // Create a completely fresh array with fresh objects to avoid any reference issues
              const boxesForTxn = [];
              for (const box of finalBoxes) {
                // Create a brand new object with primitive values
                const freshBox = {
                  appIndex: Number(box.appIndex),
                  name: new Uint8Array(box.name)
                };
                
                // Verify one more time
                if (typeof freshBox.appIndex !== 'number' || !(freshBox.name instanceof Uint8Array)) {
                  throw new Error(`Invalid box format: appIndex=${typeof freshBox.appIndex}, name=${freshBox.name instanceof Uint8Array}`);
                }
                
                boxesForTxn.push(freshBox);
              }
              
              txnObj.boxes = boxesForTxn;
            }
          }
          
          // Only include optional fields if they exist and are valid
          if (txn.accounts && txn.accounts.length > 0) {
            txnObj.accounts = txn.accounts.map(acc => {
              // Handle both string addresses and objects with publicKey
              if (typeof acc === 'string') {
                return acc;
              } else if (acc && acc.publicKey) {
                return algosdk.encodeAddress(acc.publicKey);
              } else if (acc instanceof Uint8Array) {
                return algosdk.encodeAddress(acc);
              } else {
                // Try to encode as-is (might already be a valid address)
                return acc;
              }
            });
          }
          if (txn.note && txn.note.length > 0) {
            txnObj.note = txn.note;
          }
          if (txn.lease && txn.lease.length === 32) {
            txnObj.lease = txn.lease;
          }
          if (txn.rekeyTo) {
            txnObj.rekeyTo = algosdk.encodeAddress(txn.rekeyTo.publicKey);
          }
          
          // Remove boxes from txnObj since makeApplicationCallTxnFromObject might not handle them correctly
          const boxesToAdd = txnObj.boxes;
          delete txnObj.boxes;
          
          const rebuiltTxn = algosdk.makeApplicationCallTxnFromObject(txnObj);
          
          // Manually set boxes on the transaction after creation
          if (boxesToAdd && boxesToAdd.length > 0) {
            // Verify boxes one more time before setting
            const verifiedBoxes = boxesToAdd.filter(box => {
              return typeof box.appIndex === 'number' && box.appIndex > 0 && 
                     box.name instanceof Uint8Array;
            });
            
            if (verifiedBoxes.length > 0) {
              // Set boxes directly on the transaction object
              rebuiltTxn.boxes = verifiedBoxes;
            }
          }
          
          decodedTxns.push(rebuiltTxn);
          const summary = getTransactionSummary(rebuiltTxn, allTransactions.length + idx);
          console.log(`  [${allTransactions.length + idx}] ${summary}`);
        } else {
          // For non-app-call transactions, just use the decoded transaction as-is
          decodedTxns.push(txn);
          const summary = getTransactionSummary(txn, allTransactions.length + idx);
          console.log(`  [${allTransactions.length + idx}] ${summary}`);
        }
      }
      
      console.log(`[buildSwapTransactions] Added ${decodedTxns.length} Nomadex transaction(s) to group\n`);
      allTransactions.push(...decodedTxns);
    } else {
      // Build HumbleSwap transactions using humbleswap module
      const { inputWrapped, outputWrapped } = resolveWrappedTokens(poolCfg, splitInputToken, splitOutputToken);
      
      // Get decimals
      const inputDecimals = await getTokenDecimals(inputTokenStr);
      const outputDecimals = await getTokenDecimals(outputTokenStr);
      
      // Build swap transactions using arccjs directly (NO SIMULATION - that's the whole point!)
      // We build all transactions first, then simulate the complete group once at the end
      // to discover boxes via allowUnnamedResources
      
      // Determine swap direction
      const poolInfo = await getPoolInfo(poolId, algodClient, indexerClient);
      const swapAForB = inputWrapped === poolInfo.tokA && outputWrapped === poolInfo.tokB;
      
      // For multi-hop routes, pass previous hop transactions as extraTxns
      // These are the transactions that produce the input token for this HumbleSwap swap
      // Format: array of algosdk.Transaction objects
      let extraTxns = [];
      if (i > 0 && allTransactions.length > 0) {
        // Pass previous transactions as extraTxns for arccjs
        extraTxns = allTransactions;
      }
      
      // Get token metadata for symbols
      const inputTokenMeta = getTokenMetaFromConfig(inputWrapped) || {};
      const outputTokenMeta = getTokenMetaFromConfig(outputWrapped) || {};
      
      // Detect platform transitions for unwrap/wrap logic
      const currentPlatform = poolCfg.dex; // 'humbleswap' or 'nomadex'
      const previousPlatform = i > 0 ? splitDetails[i - 1].poolCfg.dex : null;
      const nextPlatform = i < splitDetails.length - 1 ? splitDetails[i + 1].poolCfg.dex : null;
      
      // Check if we need to unwrap (HumbleSwap -> Nomadex)
      // If previous hop was HumbleSwap and current is Nomadex, we need to unwrap
      const needsUnwrap = previousPlatform === 'humbleswap' && currentPlatform === 'nomadex';
      
      // Check if we need to wrap (Nomadex -> HumbleSwap)
      // If previous hop was Nomadex and current is HumbleSwap, we need to wrap
      const needsWrap = previousPlatform === 'nomadex' && currentPlatform === 'humbleswap';
      
      // Optimization: Check if input wrapped token comes from previous hop
      // If so, we can skip deposit since the token is already in wrapped form
      // BUT: If we're transitioning from Nomadex to HumbleSwap, we MUST wrap (don't skip deposit)
      const previousHopOutputWrapped = i > 0 ? hopOutputWrappedTokens.get(i - 1) : null;
      const inputFromPreviousHop = previousHopOutputWrapped === inputWrapped && !needsWrap;
      
      // Optimization: Check if output wrapped token is needed by next hop
      // If so, we should skip withdraw to keep it in wrapped form
      // BUT: If we're transitioning from HumbleSwap to Nomadex, we MUST unwrap (don't skip withdraw)
      const nextHopInputWrapped = i < splitDetails.length - 1 ? (() => {
        const nextSplit = splitDetails[i + 1];
        const nextPoolCfg = nextSplit.poolCfg;
        const nextSplitInputToken = isMultiHop ? nextSplit.inputToken : inputToken;
        const { inputWrapped: nextInputWrapped } = resolveWrappedTokens(nextPoolCfg, nextSplitInputToken, nextSplit.outputToken);
        return nextInputWrapped;
      })() : null;
      const outputNeededByNextHop = nextHopInputWrapped === outputWrapped && !needsUnwrap;
      
      // Store output wrapped token for next hop optimization
      hopOutputWrappedTokens.set(i, outputWrapped);
      
      // Build swap transactions using arccjs (NO SIMULATION!)
      const decodedTxns = await buildHumbleswapSwapTransactionsArccjs({
        sender: address,
        poolId: poolId,
        inputWrapped: inputWrapped,
        outputWrapped: outputWrapped,
        amountIn: amountBigInt.toString(),
        minAmountOut: minOutput,
        swapAForB: swapAForB,
        algodClient: algodClient,
        indexerClient: indexerClient,
        extraTxns: extraTxns,
        inputTokenId: inputTokenStr, // underlying token ID (0 for VOI, >0 for ASA)
        outputTokenId: outputTokenStr, // underlying token ID (0 for VOI, >0 for ASA)
        inputSymbol: inputTokenMeta.symbol || '',
        outputSymbol: outputTokenMeta.symbol || '',
        slippage: slippage,
        degenMode: false,
        skipWithdraw: outputNeededByNextHop, // Skip withdraw if next hop needs this wrapped token
        skipDeposit: inputFromPreviousHop // Skip deposit if we already have it from previous hop
      });
      
      allTransactions.push(...decodedTxns);
    }
  }
  
  // Add platform fee payment transaction if applicable
  if (platformFee && platformFee.feeAmount && platformFee.feeAddress && BigInt(platformFee.feeAmount) > 0n) {
    const feeAmount = BigInt(platformFee.feeAmount);
    const feeAddress = platformFee.feeAddress;
    const outputTokenNum = Number(outputToken);
    
    // Determine output token type
    const outputTokenType = await determineOutputTokenType(outputToken, splitDetails);
    const suggestedParams = await algodClient.getTransactionParams().do();
    
    let feeTxn;
    
    if (outputTokenType === 'native') {
      // Native token payment
      feeTxn = algosdk.makePaymentTxnWithSuggestedParams(
        address,
        feeAddress,
        feeAmount,
        undefined,
        undefined,
        suggestedParams
      );
    } else if (outputTokenType === 'ASA') {
      // ASA asset transfer
      feeTxn = algosdk.makeAssetTransferTxnWithSuggestedParams(
        address,
        feeAddress,
        undefined,
        undefined,
        feeAmount,
        undefined,
        outputTokenNum,
        suggestedParams
      );
    } else if (outputTokenType === 'ARC200') {
      // ARC200 transfer via application call
      const arc200ContractId = outputTokenNum;
      const arc200TransferMethod = getARC200TransferMethod();
      
      const arc200Atc = new algosdk.AtomicTransactionComposer();
      arc200Atc.addMethodCall({
        appID: arc200ContractId,
        method: arc200TransferMethod,
        methodArgs: [
          feeAddress,  // to: fee address
          feeAmount    // value: fee amount
        ],
        sender: address,
        suggestedParams: suggestedParams
      });
      
      const arc200Txns = arc200Atc.buildGroup();
      if (arc200Txns.length !== 1) {
        throw new Error(`Expected 1 ARC200 transfer transaction, got ${arc200Txns.length}`);
      }
      feeTxn = arc200Txns[0].txn;
      feeTxn.group = undefined; // Will be reassigned with the group
    } else {
      throw new Error(`Unsupported output token type for fee payment: ${outputTokenType}`);
    }
    
    allTransactions.push(feeTxn);
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
  
  // For multi-hop routes, simulate the entire group to discover box references
  // and populate them in the transactions
  // Note: If simulation fails, we'll continue without it - the existing box construction
  // logic for ARC200 tokens should still work
  if (shouldSimulateGroup && allTransactions.length > 0) {
    try {
      // Try to simulate the transaction group
      // This may fail due to SDK version issues, so we catch and continue
      console.log(`\n[buildSwapTransactions] Simulating transaction group (${allTransactions.length} transactions) to discover box references...`);
      
      // Log transaction summary before simulation
      console.log(`[buildSwapTransactions] Transaction group summary before simulation:`);
      for (let i = 0; i < allTransactions.length; i++) {
        const txn = allTransactions[i];
        let summary = `  [${i}] ${txn.type}`;
        if (txn.type === 'appl') {
          summary += ` -> App ${txn.appIndex}`;
          if (txn.boxes && txn.boxes.length > 0) {
            summary += `, ${txn.boxes.length} box(es)`;
          }
          if (txn.foreignApps && txn.foreignApps.length > 0) {
            summary += `, Foreign Apps: [${txn.foreignApps.join(', ')}]`;
          }
          if (txn.foreignAssets && txn.foreignAssets.length > 0) {
            summary += `, Foreign Assets: [${txn.foreignAssets.join(', ')}]`;
          }
          if (txn.appArgs && txn.appArgs.length > 0) {
            const methodSelector = txn.appArgs[0] ? Buffer.from(txn.appArgs[0]).toString('hex').substring(0, 8) : 'none';
            summary += `, Method: 0x${methodSelector}`;
          }
        } else if (txn.type === 'axfer') {
          summary += `, Asset: ${txn.assetIndex}, Amount: ${txn.amount}`;
        } else if (txn.type === 'pay') {
          summary += `, Amount: ${txn.amount} microAlgos`;
        }
        console.log(summary);
      }
      console.log('');
      
      const simulationResult = await simulateTransactionGroup(allTransactions, algodClient);
      
      // Use box references even if simulation had errors (with allowUnnamedResources, we can still get resources)
      // This is important for multi-hop routes where intermediate tokens don't exist yet
      // Also extract foreignApps and foreignAssets from per-transaction unnamedResourcesAccessed
      if (simulationResult && simulationResult.simulateResponse) {
        const simulateResponse = simulationResult.simulateResponse;
        const txnGroup = simulateResponse.txnGroups?.[0];
        const txnResults = txnGroup?.txnResults || [];
        
        // Process per-transaction unnamedResourcesAccessed
        for (let i = 0; i < txnResults.length && i < allTransactions.length; i++) {
          const txnResult = txnResults[i];
          const txn = allTransactions[i];
          
          // Only process app call transactions
          if (txn.type !== 'appl') {
            continue;
          }
          
          // Get per-transaction unnamedResourcesAccessed
          const txnUnnamed = txnResult.unnamedResourcesAccessed || {};
          const txnApps = txnUnnamed.apps || [];
          const txnAssets = txnUnnamed.assets || [];
          
          // Initialize arrays if they don't exist
          if (!txn.foreignApps) {
            txn.foreignApps = [];
          }
          if (!txn.foreignAssets) {
            txn.foreignAssets = [];
          }
          
          // Add apps that this SPECIFIC transaction needs (only if not already present)
          for (const appId of txnApps) {
            const appIdNum = typeof appId === 'number' ? appId : Number(appId);
            if (!txn.foreignApps.includes(appIdNum)) {
              // Check if adding this app would exceed the 8 reference limit
              const currentBoxes = (txn.boxes || []).length;
              const currentForeignApps = txn.foreignApps.length;
              const currentForeignAssets = txn.foreignAssets.length;
              const currentAccounts = (txn.accounts || []).length;
              const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;
              
              if (totalReferences < 8) {
                txn.foreignApps.push(appIdNum);
                console.log(`[buildSwapTransactions] Added foreign app ${appIdNum} to transaction ${i} (from simulation)`);
              } else {
                console.warn(`[buildSwapTransactions] Cannot add foreign app ${appIdNum} to transaction ${i}: would exceed 8 reference limit (current: ${totalReferences})`);
              }
            }
          }
          
          // Add assets that this SPECIFIC transaction needs (only if not already present)
          for (const assetId of txnAssets) {
            const assetIdNum = typeof assetId === 'number' ? assetId : Number(assetId);
            if (!txn.foreignAssets.includes(assetIdNum)) {
              // Check if adding this asset would exceed the 8 reference limit
              const currentBoxes = (txn.boxes || []).length;
              const currentForeignApps = txn.foreignApps.length;
              const currentForeignAssets = txn.foreignAssets.length;
              const currentAccounts = (txn.accounts || []).length;
              const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;
              
              if (totalReferences < 8) {
                txn.foreignAssets.push(assetIdNum);
                console.log(`[buildSwapTransactions] Added foreign asset ${assetIdNum} to transaction ${i} (from simulation)`);
              } else {
                console.warn(`[buildSwapTransactions] Cannot add foreign asset ${assetIdNum} to transaction ${i}: would exceed 8 reference limit (current: ${totalReferences})`);
              }
            }
          }
        }
        
        // GROUP RESOURCE SHARING: Collect all unique boxes/assets/apps/accounts across the entire group
        // Resources only need to be included once in the group, and all transactions can access them
        const uniqueBoxes = new Map(); // key: `${appIndex}:${boxNameHex}`, value: { appIndex, name }
        const uniqueForeignApps = new Set();
        const uniqueForeignAssets = new Set();
        const uniqueAccounts = new Set(); // Account addresses that need to be in accounts array
        
        // Add apps extracted from error messages (e.g., "unavailable App 411751")
        // These are discovered when simulation fails and tells us what apps are needed
        if (simulationResult && simulationResult.appsFromErrors) {
          console.log(`[buildSwapTransactions] Found ${simulationResult.appsFromErrors.length} app(s) from simulation errors:`, simulationResult.appsFromErrors);
          for (const appId of simulationResult.appsFromErrors) {
            uniqueForeignApps.add(appId);
            console.log(`[buildSwapTransactions] Collected missing app ${appId} from simulation error messages`);
          }
        } else {
          console.log(`[buildSwapTransactions] No apps found in simulationResult.appsFromErrors (value: ${simulationResult?.appsFromErrors})`);
        }
        
        // Add accounts extracted from error messages (e.g., "unavailable Local State 395642+3BNBKEC...")
        // These are discovered when simulation fails and tells us what accounts are needed
        if (simulationResult && simulationResult.accountsFromErrors) {
          console.log(`[buildSwapTransactions] Found ${simulationResult.accountsFromErrors.length} account(s) from simulation errors:`, simulationResult.accountsFromErrors);
          for (const accountAddr of simulationResult.accountsFromErrors) {
            uniqueAccounts.add(accountAddr);
            console.log(`[buildSwapTransactions] Collected account ${accountAddr} from simulation error messages`);
          }
        } else {
          console.log(`[buildSwapTransactions] No accounts found in simulationResult.accountsFromErrors (value: ${simulationResult?.accountsFromErrors})`);
        }
        
        // Collect all unique boxes from simulation
        if (simulationResult.boxReferences && simulationResult.boxReferences.length > 0) {
          for (const boxRef of simulationResult.boxReferences) {
            const appIndex = typeof boxRef.appIndex === 'number' ? boxRef.appIndex : Number(boxRef.appIndex);
            const name = boxRef.name instanceof Uint8Array 
              ? boxRef.name 
              : new Uint8Array(boxRef.name);
            const boxNameHex = Buffer.from(name).toString('hex');
            const key = `${appIndex}:${boxNameHex}`;
            
            if (!uniqueBoxes.has(key)) {
              uniqueBoxes.set(key, { appIndex, name });
              uniqueForeignApps.add(appIndex); // Box app must be in foreignApps
            }
          }
        }
        
        // Collect all unique foreignApps, foreignAssets, and accounts from simulation
        // Also check group-level unnamedResourcesAccessed
        const groupUnnamed = txnGroup?.unnamedResourcesAccessed || {};
        const groupApps = groupUnnamed.apps || [];
        const groupAssets = groupUnnamed.assets || [];
        const groupAccounts = groupUnnamed.accounts || [];
        
        for (const appId of groupApps) {
          const appIdNum = typeof appId === 'number' ? appId : Number(appId);
          uniqueForeignApps.add(appIdNum);
          console.log(`[buildSwapTransactions] Collected group-level foreign app ${appIdNum} from simulation`);
        }
        
        for (const assetId of groupAssets) {
          const assetIdNum = typeof assetId === 'number' ? assetId : Number(assetId);
          uniqueForeignAssets.add(assetIdNum);
        }
        
        for (const account of groupAccounts) {
          const accountAddr = typeof account === 'string' ? account : algosdk.encodeAddress(account);
          uniqueAccounts.add(accountAddr);
          console.log(`[buildSwapTransactions] Collected group-level account ${accountAddr} from simulation`);
        }
        
        for (let i = 0; i < txnResults.length && i < allTransactions.length; i++) {
          const txnResult = txnResults[i];
          const txnUnnamed = txnResult.unnamedResourcesAccessed || {};
          const txnApps = txnUnnamed.apps || [];
          const txnAssets = txnUnnamed.assets || [];
          const txnAccounts = txnUnnamed.accounts || [];
          
          for (const appId of txnApps) {
            const appIdNum = typeof appId === 'number' ? appId : Number(appId);
            uniqueForeignApps.add(appIdNum);
            console.log(`[buildSwapTransactions] Collected transaction ${i} foreign app ${appIdNum} from simulation`);
          }
          
          for (const assetId of txnAssets) {
            const assetIdNum = typeof assetId === 'number' ? assetId : Number(assetId);
            uniqueForeignAssets.add(assetIdNum);
          }
          
          for (const account of txnAccounts) {
            const accountAddr = typeof account === 'string' ? account : algosdk.encodeAddress(account);
            uniqueAccounts.add(accountAddr);
            console.log(`[buildSwapTransactions] Collected transaction ${i} account ${accountAddr} from simulation`);
          }
        }
        
        // Also collect foreignApps and foreignAssets that are already in transactions
        // This is important because some foreignApps (like beacon ID, factory app 411751) are set during transaction building
        for (let i = 0; i < allTransactions.length; i++) {
          const txn = allTransactions[i];
          if (txn.type === 'appl') {
            if (txn.foreignApps && Array.isArray(txn.foreignApps) && txn.foreignApps.length > 0) {
              for (const appId of txn.foreignApps) {
                const appIdNum = typeof appId === 'number' ? appId : Number(appId);
                uniqueForeignApps.add(appIdNum);
                console.log(`[buildSwapTransactions] Collected existing foreign app ${appIdNum} from transaction ${i} (App ${txn.appIndex})`);
              }
            } else {
              // Log if transaction has no foreignApps (might indicate a problem)
              if (txn.appIndex === 429995) {
                console.warn(`[buildSwapTransactions] WARNING: Nomadex transaction ${i} (App ${txn.appIndex}) has no foreignApps! This should include app 411751.`);
              }
            }
            if (txn.foreignAssets && Array.isArray(txn.foreignAssets) && txn.foreignAssets.length > 0) {
              for (const assetId of txn.foreignAssets) {
                const assetIdNum = typeof assetId === 'number' ? assetId : Number(assetId);
                uniqueForeignAssets.add(assetIdNum);
              }
            }
          }
        }
        
        // Accounts are already collected from error messages in simulateTransactionGroup
        // The error format "unavailable Local State {appId}+{accountAddress}" tells us exactly what's needed
        // However, if simulation doesn't catch these errors, we can proactively fetch creator addresses
        // for apps that are known to require them (discovered dynamically from foreignApps)
        // This is not hardcoding - we're fetching based on what the simulation tells us we need
        
        // For apps that require local state access, we need their creator addresses
        // Create a map of app ID -> creator account address
        // This allows us to add accounts only to transactions that use the corresponding app
        const appToCreatorAccount = new Map();
        const appsToCheck = Array.from(uniqueForeignApps);
        for (const appId of appsToCheck) {
          try {
            const appInfo = await indexerClient.lookupApplications(appId).do();
            if (appInfo.application && appInfo.application.params && appInfo.application.params.creator) {
              const creatorAddr = appInfo.application.params.creator;
              appToCreatorAccount.set(appId, creatorAddr);
              // Also add to uniqueAccounts for tracking
              uniqueAccounts.add(creatorAddr);
              console.log(`[buildSwapTransactions] Mapped app ${appId} to creator address ${creatorAddr}`);
            }
          } catch (error) {
            // Silently skip if lookup fails - not all apps need creator addresses
            // Only log if it's a real error (not just "app not found")
            if (!error.message.includes('application does not exist')) {
              console.log(`[buildSwapTransactions] Could not fetch creator for app ${appId}:`, error.message);
            }
          }
        }
        
        // Log all collected unique resources for debugging
        console.log(`[buildSwapTransactions] Collected unique foreign apps:`, Array.from(uniqueForeignApps).sort((a, b) => a - b));
        console.log(`[buildSwapTransactions] Collected unique accounts:`, Array.from(uniqueAccounts).sort());
        
        console.log(`[buildSwapTransactions] Group resource sharing: ${uniqueBoxes.size} unique box(es), ${uniqueForeignApps.size} unique foreign app(s), ${uniqueForeignAssets.size} unique foreign asset(s), ${uniqueAccounts.size} unique account(s)`);
        
        // Distribute resources across transactions in the group
        // Each resource only needs to appear once, but we need to stay within 8 references per transaction
        const allUniqueBoxes = Array.from(uniqueBoxes.values());
        const allUniqueForeignApps = Array.from(uniqueForeignApps);
        const allUniqueForeignAssets = Array.from(uniqueForeignAssets);
        const allUniqueAccounts = Array.from(uniqueAccounts);
        
        // Get all app call transactions
        const appCallTxns = allTransactions
          .map((txn, idx) => ({ txn, idx }))
          .filter(({ txn }) => txn.type === 'appl');
        
        // Distribute boxes across transactions (only add if not already present in ANY transaction)
        // With group resource sharing, if it's in one transaction, all can access it
        // Initialize arrays for all transactions first
        for (const { txn } of appCallTxns) {
          if (!txn.boxes) {
            txn.boxes = [];
          }
          if (!txn.foreignApps) {
            txn.foreignApps = [];
          }
          if (!txn.foreignAssets) {
            txn.foreignAssets = [];
          }
        }
        
        // Try to add each box to the first transaction that has room
        for (const box of allUniqueBoxes) {
          // Check if already in any transaction (group resource sharing)
          const boxNameHex = Buffer.from(box.name).toString('hex');
          const alreadyInGroup = appCallTxns.some(({ txn }) => 
            txn.boxes.some(b => {
              const bAppIndex = typeof b.appIndex === 'number' ? b.appIndex : Number(b.appIndex);
              const bNameHex = Buffer.from(b.name).toString('hex');
              return bAppIndex === box.appIndex && bNameHex === boxNameHex;
            })
          );
          if (alreadyInGroup) {
            continue; // Already accessible to all transactions via group sharing
          }
          
          let added = false;
          for (const { txn, idx } of appCallTxns) {
            const currentBoxes = txn.boxes.length;
            const currentForeignApps = txn.foreignApps.length;
            const currentForeignAssets = txn.foreignAssets.length;
            const currentAccounts = (txn.accounts || []).length;
            const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;
            
            // Check if adding this box would exceed the limit
            const needsForeignApp = !txn.foreignApps.includes(box.appIndex);
            const additionalReferences = 1 + (needsForeignApp ? 1 : 0);
            
            if (totalReferences + additionalReferences <= 8) {
              // Add the box
              txn.boxes.push({
                appIndex: box.appIndex,
                name: box.name
              });
              
              // Add foreignApp if needed
              if (needsForeignApp) {
                txn.foreignApps.push(box.appIndex);
              }
              
              added = true;
              break;
            }
          }
          if (!added) {
            console.warn(`[buildSwapTransactions] Could not add box (app ${box.appIndex}) to any transaction - all transactions are full`);
          }
        }
        
        // Distribute foreignApps across transactions
        // IMPORTANT: If an app was discovered from an error message, try to add it to the transaction that needs it
        // Error format: "unavailable App {appId}. Details: app={txnAppId}" tells us which transaction needs which app
        // For now, we'll add apps to transactions that have room, but prioritize transactions that might need them
        
        // Create a map of transaction app ID -> apps it needs (from errors)
        // This will be populated if we can extract this info from errors
        const txnAppToNeededApps = new Map();
        
        // Try to extract transaction-to-app mappings from error messages
        // Error format: "unavailable App {neededAppId}. Details: app={txnAppId}"
        if (simulationResult && simulationResult.errors) {
          for (const err of simulationResult.errors) {
            const errorMsg = err.message || err.error || '';
            // Match "unavailable App {neededAppId}. Details: app={txnAppId}"
            const unavailableAppMatch = errorMsg.match(/unavailable App (\d+)\. Details: app=(\d+)/);
            if (unavailableAppMatch) {
              const neededAppId = Number(unavailableAppMatch[1]);
              const txnAppId = Number(unavailableAppMatch[2]);
              if (!txnAppToNeededApps.has(txnAppId)) {
                txnAppToNeededApps.set(txnAppId, new Set());
              }
              txnAppToNeededApps.get(txnAppId).add(neededAppId);
              console.log(`[buildSwapTransactions] Mapped: transaction app ${txnAppId} needs app ${neededAppId} (from error message)`);
            }
          }
        }
        
        // Distribute foreignApps: prioritize transactions that need them (from errors), then add to any with room
        for (const appId of allUniqueForeignApps) {
          // Check if already in any transaction (group resource sharing)
          const alreadyInGroup = appCallTxns.some(({ txn }) => txn.foreignApps.includes(appId));
          if (alreadyInGroup) {
            console.log(`[buildSwapTransactions] Foreign app ${appId} already in group (group resource sharing)`);
            continue; // Already accessible to all transactions via group sharing
          }
          
          // First, try to add to transactions that need this app (from error messages)
          let added = false;
          for (const { txn, idx } of appCallTxns) {
            const txnAppId = txn.appIndex;
            if (txnAppToNeededApps.has(txnAppId) && txnAppToNeededApps.get(txnAppId).has(appId)) {
              // This transaction needs this app!
              const currentBoxes = txn.boxes.length;
              const currentForeignApps = txn.foreignApps.length;
              const currentForeignAssets = txn.foreignAssets.length;
              const currentAccounts = (txn.accounts || []).length;
              const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;
              
              if (totalReferences < 8) {
                txn.foreignApps.push(appId);
                console.log(`[buildSwapTransactions] Added foreign app ${appId} to transaction ${idx} (App ${txnAppId}) - this transaction needs it!`);
                added = true;
                break;
              } else {
                console.warn(`[buildSwapTransactions] Transaction ${idx} (App ${txnAppId}) needs app ${appId} but is full (${totalReferences} references). Will try other transactions.`);
              }
            }
          }
          
          // If not added to a specific transaction, add to first transaction with room
          if (!added) {
            for (const { txn, idx } of appCallTxns) {
              const currentBoxes = txn.boxes.length;
              const currentForeignApps = txn.foreignApps.length;
              const currentForeignAssets = txn.foreignAssets.length;
              const currentAccounts = (txn.accounts || []).length;
              const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;
              
              if (totalReferences < 8) {
                txn.foreignApps.push(appId);
                console.log(`[buildSwapTransactions] Added foreign app ${appId} to transaction ${idx} (App ${txn.appIndex})`);
                added = true;
                break;
              }
            }
          }
          
          if (!added) {
            console.warn(`[buildSwapTransactions] Could not add foreign app ${appId} to any transaction - all transactions are full`);
          }
        }
        
        // Final check: Log foreignApps for each transaction to verify app 395642 is included
        // Also ensure app 395642 is added to swap transactions (395553) if missing
        console.log(`[buildSwapTransactions] Final foreignApps per transaction:`);
        for (let i = 0; i < allTransactions.length; i++) {
          const txn = allTransactions[i];
          if (txn.type === 'appl') {
            if (!txn.foreignApps) {
              txn.foreignApps = [];
            }
            const foreignApps = [...txn.foreignApps].sort((a, b) => a - b);
            console.log(`  Transaction ${i} (App ${txn.appIndex}): [${foreignApps.join(', ')}]`);
            if (txn.appIndex === 395553 && !txn.foreignApps.includes(395642)) {
              console.error(`[ERROR] Swap transaction (395553) is missing app 395642 in foreignApps!`);
              // Try to add it if we have room
              const currentBoxes = (txn.boxes || []).length;
              const currentForeignApps = txn.foreignApps.length;
              const currentForeignAssets = (txn.foreignAssets || []).length;
              const currentAccounts = (txn.accounts || []).length;
              const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;
              
              if (totalReferences < 8) {
                console.log(`[buildSwapTransactions] Adding missing app 395642 to swap transaction (395553)`);
                txn.foreignApps.push(395642);
                // Also add to uniqueForeignApps so it's tracked
                uniqueForeignApps.add(395642);
              } else {
                console.error(`[ERROR] Cannot add app 395642 to swap transaction - already at ${totalReferences} references`);
                // Try to add it to another transaction in the group (group resource sharing)
                let addedToOther = false;
                for (let j = 0; j < allTransactions.length; j++) {
                  if (j === i) continue;
                  const otherTxn = allTransactions[j];
                  if (otherTxn.type === 'appl' && !otherTxn.foreignApps.includes(395642)) {
                    const otherBoxes = (otherTxn.boxes || []).length;
                    const otherForeignApps = (otherTxn.foreignApps || []).length;
                    const otherForeignAssets = (otherTxn.foreignAssets || []).length;
                    const otherAccounts = (otherTxn.accounts || []).length;
                    const otherTotal = otherBoxes + otherForeignApps + otherForeignAssets + otherAccounts;
                    if (otherTotal < 8) {
                      if (!otherTxn.foreignApps) {
                        otherTxn.foreignApps = [];
                      }
                      otherTxn.foreignApps.push(395642);
                      console.log(`[buildSwapTransactions] Added app 395642 to transaction ${j} (App ${otherTxn.appIndex}) for group resource sharing`);
                      addedToOther = true;
                      break;
                    }
                  }
                }
                if (!addedToOther) {
                  console.error(`[ERROR] Could not add app 395642 to any transaction - all are full!`);
                }
              }
            }
          }
        }
        
        // Distribute foreignAssets across transactions (only add if not already present in ANY transaction)
        // With group resource sharing, if it's in one transaction, all can access it
        // Try to add each asset to the first transaction that has room
        for (const assetId of allUniqueForeignAssets) {
          // Check if already in any transaction (group resource sharing)
          const alreadyInGroup = appCallTxns.some(({ txn }) => txn.foreignAssets.includes(assetId));
          if (alreadyInGroup) {
            continue; // Already accessible to all transactions via group sharing
          }
          
          let added = false;
          for (const { txn, idx } of appCallTxns) {
            const currentBoxes = txn.boxes.length;
            const currentForeignApps = txn.foreignApps.length;
            const currentForeignAssets = txn.foreignAssets.length;
            const currentAccounts = (txn.accounts || []).length;
            const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;
            
            if (totalReferences < 8) {
              txn.foreignAssets.push(assetId);
              added = true;
              break;
            }
          }
          if (!added) {
            console.warn(`[buildSwapTransactions] Could not add foreign asset ${assetId} to any transaction - all transactions are full`);
          }
        }
        
        // Distribute accounts across transactions
        // Use the app-to-creator map to add accounts only to transactions that use the corresponding app
        // This is more efficient than adding all accounts to all transactions
        for (const [appId, creatorAccount] of appToCreatorAccount) {
          // Find all transactions that have this app in their foreignApps
          let transactionsNeedingAccount = appCallTxns.filter(({ txn }) => 
            txn.foreignApps && txn.foreignApps.includes(appId)
          );
          
          // If no transactions have this app in foreignApps, but the app is in uniqueForeignApps,
          // we should add it to at least one transaction's foreignApps (preferably one with room)
          // This handles cases where the app was discovered from simulation but not yet distributed
          if (transactionsNeedingAccount.length === 0 && uniqueForeignApps.has(appId)) {
            console.log(`[buildSwapTransactions] App ${appId} is in uniqueForeignApps but not in any transaction's foreignApps. Adding to a transaction with room.`);
            // Find a transaction with room to add the app
            for (const { txn, idx } of appCallTxns) {
              if (!txn.foreignApps) {
                txn.foreignApps = [];
              }
              if (txn.foreignApps.includes(appId)) {
                transactionsNeedingAccount.push({ txn, idx });
                break; // Already added
              }
              const currentBoxes = txn.boxes.length;
              const currentForeignApps = txn.foreignApps.length;
              const currentForeignAssets = txn.foreignAssets.length;
              const currentAccounts = (txn.accounts || []).length;
              const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;
              if (totalReferences < 8) {
                txn.foreignApps.push(appId);
                transactionsNeedingAccount.push({ txn, idx });
                console.log(`[buildSwapTransactions] Added app ${appId} to transaction ${idx} (App ${txn.appIndex}) foreignApps (needed for local state access)`);
                break; // Added to one transaction, that's enough for group resource sharing
              }
            }
          }
          
          if (transactionsNeedingAccount.length === 0) {
            console.log(`[buildSwapTransactions] No transactions found with app ${appId} in foreignApps and cannot add it, skipping account ${creatorAccount}`);
            continue;
          }
          
          // Add the creator account to all transactions that have the app in foreignApps
          for (const { txn, idx } of transactionsNeedingAccount) {
            if (!txn.accounts) {
              txn.accounts = [];
            }
            
            // Check if already in this transaction
            const alreadyInTxn = txn.accounts.some(acc => {
              const accStr = typeof acc === 'string' ? acc : algosdk.encodeAddress(acc);
              return accStr === creatorAccount;
            });
            if (alreadyInTxn) {
              continue; // Already added
            }
            
            const currentBoxes = txn.boxes.length;
            const currentForeignApps = txn.foreignApps.length;
            const currentForeignAssets = txn.foreignAssets.length;
            const currentAccounts = txn.accounts.length;
            const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;
            
            if (totalReferences < 8) {
              txn.accounts.push(creatorAccount);
              console.log(`[buildSwapTransactions] Added creator account ${creatorAccount} (for app ${appId}) to transaction ${idx} (App ${txn.appIndex})`);
            } else {
              console.warn(`[buildSwapTransactions] Cannot add creator account ${creatorAccount} (for app ${appId}) to transaction ${idx} (App ${txn.appIndex}): would exceed 8 reference limit (current: ${totalReferences})`);
              // Try to add to another transaction that might need it (even if it doesn't have the app in foreignApps yet)
              // This handles cases where the app needs to be added to foreignApps but we haven't done that yet
              for (const { txn: otherTxn, idx: otherIdx } of appCallTxns) {
                if (otherIdx === idx) continue; // Skip the one we just tried
                if (!otherTxn.accounts) {
                  otherTxn.accounts = [];
                }
                const otherAlreadyInTxn = otherTxn.accounts.some(acc => {
                  const accStr = typeof acc === 'string' ? acc : algosdk.encodeAddress(acc);
                  return accStr === creatorAccount;
                });
                if (otherAlreadyInTxn) {
                  continue; // Already added
                }
                const otherBoxes = otherTxn.boxes.length;
                const otherForeignApps = otherTxn.foreignApps.length;
                const otherForeignAssets = otherTxn.foreignAssets.length;
                const otherAccounts = otherTxn.accounts.length;
                const otherTotalReferences = otherBoxes + otherForeignApps + otherForeignAssets + otherAccounts;
                if (otherTotalReferences < 8) {
                  otherTxn.accounts.push(creatorAccount);
                  // Also add the app to foreignApps if not already there (needed for local state access)
                  if (!otherTxn.foreignApps) {
                    otherTxn.foreignApps = [];
                  }
                  if (!otherTxn.foreignApps.includes(appId)) {
                    if (otherTotalReferences + 1 < 8) { // Check if we can add both app and account
                      otherTxn.foreignApps.push(appId);
                      console.log(`[buildSwapTransactions] Added app ${appId} to transaction ${otherIdx} (App ${otherTxn.appIndex}) foreignApps (needed for local state access)`);
                    }
                  }
                  console.log(`[buildSwapTransactions] Added creator account ${creatorAccount} (for app ${appId}) to transaction ${otherIdx} (App ${otherTxn.appIndex}) as fallback`);
                  break; // Found a place, stop looking
                }
              }
            }
          }
        }
        
        // Also handle any accounts that were extracted from error messages but aren't in the app-to-creator map
        // These might be accounts for apps we didn't fetch, or accounts discovered from errors
        for (const accountAddr of allUniqueAccounts) {
          // Check if this account is already in the app-to-creator map
          const isMappedAccount = Array.from(appToCreatorAccount.values()).some(acc => acc === accountAddr);
          if (isMappedAccount) {
            continue; // Already handled above
          }
          
          // This account was extracted from errors but we don't know which app it's for
          // Add it to all transactions with room (fallback)
          let added = false;
          for (const { txn, idx } of appCallTxns) {
            if (!txn.accounts) {
              txn.accounts = [];
            }
            
            const alreadyInTxn = txn.accounts.some(acc => {
              const accStr = typeof acc === 'string' ? acc : algosdk.encodeAddress(acc);
              return accStr === accountAddr;
            });
            if (alreadyInTxn) {
              added = true;
              break;
            }
            
            const currentBoxes = txn.boxes.length;
            const currentForeignApps = txn.foreignApps.length;
            const currentForeignAssets = txn.foreignAssets.length;
            const currentAccounts = txn.accounts.length;
            const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;
            
            if (totalReferences < 8) {
              txn.accounts.push(accountAddr);
              console.log(`[buildSwapTransactions] Added account ${accountAddr} (from errors, unknown app) to transaction ${idx} (App ${txn.appIndex})`);
              added = true;
              break; // Only add to first transaction with room for unknown accounts
            }
          }
          if (!added) {
            console.warn(`[buildSwapTransactions] Could not add account ${accountAddr} (from errors) to any transaction - all transactions are full`);
          }
        }
        
        // Count how many resources were actually added
        let totalBoxesAdded = 0;
        let totalAppsAdded = 0;
        let totalAssetsAdded = 0;
        let totalAccountsAdded = 0;
        for (const { txn } of appCallTxns) {
          totalBoxesAdded += (txn.boxes || []).length;
          totalAppsAdded += (txn.foreignApps || []).length;
          totalAssetsAdded += (txn.foreignAssets || []).length;
          totalAccountsAdded += (txn.accounts || []).length;
        }
        console.log(`[buildSwapTransactions] Distributed resources: ${totalBoxesAdded} boxes across ${appCallTxns.length} transactions, ${totalAppsAdded} foreign apps, ${totalAssetsAdded} foreign assets, ${totalAccountsAdded} accounts`);
        
        // Final validation: Ensure no transaction exceeds the 8 reference limit
        // If a transaction exceeds the limit, we need to trim boxes or foreignApps
        for (let i = 0; i < allTransactions.length; i++) {
          const txn = allTransactions[i];
          if (txn.type === 'appl') {
            const currentBoxes = (txn.boxes || []).length;
            const currentForeignApps = (txn.foreignApps || []).length;
            const currentForeignAssets = (txn.foreignAssets || []).length;
            const currentAccounts = (txn.accounts || []).length;
            const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;
            
            if (totalReferences > 8) {
              console.warn(`[buildSwapTransactions] Transaction ${i} exceeds 8 reference limit: ${totalReferences} references (${currentBoxes} boxes, ${currentForeignApps} foreignApps, ${currentForeignAssets} foreignAssets, ${currentAccounts} accounts). Trimming boxes...`);
              
              // Trim boxes to stay within limit
              // Keep foreignApps and foreignAssets as they're more critical
              const maxBoxes = Math.max(0, 8 - currentForeignApps - currentForeignAssets - currentAccounts);
              if (txn.boxes && txn.boxes.length > maxBoxes) {
                console.warn(`[buildSwapTransactions] Trimming ${txn.boxes.length - maxBoxes} box(es) from transaction ${i} to stay within limit`);
                txn.boxes = txn.boxes.slice(0, maxBoxes);
                
                // Remove foreignApps that are only needed for trimmed boxes
                // Keep only foreignApps that are still referenced by remaining boxes
                if (txn.foreignApps && txn.foreignApps.length > 0) {
                  const remainingBoxAppIds = new Set(txn.boxes.map(box => 
                    typeof box.appIndex === 'number' ? box.appIndex : Number(box.appIndex)
                  ));
                  // Keep the transaction's own appIndex and foreignApps still needed by boxes
                  const txnAppIndex = txn.appIndex;
                  txn.foreignApps = txn.foreignApps.filter(appId => 
                    appId === txnAppIndex || remainingBoxAppIds.has(appId)
                  );
                }
              }
            }
          }
        }
        
        // Rebuild ALL app call transactions to ensure accounts are properly included
        // Even if a transaction doesn't have accounts yet, it might need them via group resource sharing
        // But we need to rebuild transactions that have accounts to ensure they're preserved
        // Also rebuild Nomadex transactions to ensure factory app 411751 is included
        // IMPORTANT: Clear group IDs before rebuilding - we'll assign a new one after
        for (let i = 0; i < allTransactions.length; i++) {
          const txn = allTransactions[i];
          // Clear group ID before rebuilding - we'll assign a new one to all transactions together after
          if (txn.group) {
            txn.group = undefined;
          }
          
          // Check if this is a Nomadex transaction (known Nomadex pool IDs: 429995, 411756)
          // Nomadex pools require factory app 411751 in foreignApps
          const knownNomadexPoolIds = [429995, 411756];
          const isNomadexTxn = txn.type === 'appl' && knownNomadexPoolIds.includes(txn.appIndex);
          const needsRebuild = txn.type === 'appl' && ((txn.boxes && txn.boxes.length > 0) || (txn.accounts && txn.accounts.length > 0) || isNomadexTxn);
          if (needsRebuild) {
            // Rebuild the transaction to ensure boxes are properly encoded
            const fromAddress = algosdk.encodeAddress(txn.from.publicKey);
            const suggestedParams = await algodClient.getTransactionParams().do();
            
            // Ensure foreignApps are preserved, and for Nomadex transactions, always include factory app 411751
            let foreignApps = txn.foreignApps || [];
            if (isNomadexTxn) {
              // This is a Nomadex pool transaction - it MUST have factory app 411751
              const factoryAppId = 411751;
              if (!foreignApps.includes(factoryAppId)) {
                foreignApps = [factoryAppId, ...foreignApps]; // Add to beginning
                console.log(`[buildSwapTransactions] CRITICAL: Added factory app ${factoryAppId} to Nomadex transaction ${i} (App ${txn.appIndex}) during rebuild`);
              } else {
                console.log(`[buildSwapTransactions] Nomadex transaction ${i} (App ${txn.appIndex}) already has factory app ${factoryAppId}`);
              }
            }
            
            const txnObj = {
              from: fromAddress,
              appIndex: txn.appIndex,
              onComplete: txn.appOnComplete,
              appArgs: txn.appArgs,
              foreignApps: foreignApps,
              foreignAssets: txn.foreignAssets || [],
              boxes: txn.boxes,
              suggestedParams: {
                ...suggestedParams,
                fee: txn.fee,
                firstRound: txn.firstRound,
                lastRound: txn.lastRound,
                genesisHash: txn.genesisHash,
                genesisID: txn.genesisID
              }
            };
            
            // Include optional fields
            if (txn.accounts && txn.accounts.length > 0) {
              txnObj.accounts = txn.accounts.map(acc => {
                // Handle both string addresses and objects with publicKey
                if (typeof acc === 'string') {
                  return acc;
                } else if (acc && acc.publicKey) {
                  return algosdk.encodeAddress(acc.publicKey);
                } else if (acc instanceof Uint8Array) {
                  return algosdk.encodeAddress(acc);
                } else {
                  // Try to encode as-is (might already be a valid address)
                  return acc;
                }
              });
            }
            if (txn.note && txn.note.length > 0) {
              txnObj.note = txn.note;
            }
            if (txn.lease && txn.lease.length === 32) {
              txnObj.lease = txn.lease;
            }
            if (txn.rekeyTo) {
              txnObj.rekeyTo = algosdk.encodeAddress(txn.rekeyTo.publicKey);
            }
            
            // Remove boxes from txnObj temporarily (if present)
            const boxesToAdd = txnObj.boxes;
            if (boxesToAdd) {
              delete txnObj.boxes;
            }
            
            // Ensure all box app IDs are in foreignApps (if boxes exist)
            if (boxesToAdd && boxesToAdd.length > 0) {
              if (!txnObj.foreignApps) {
                txnObj.foreignApps = [];
              }
              // Add box app IDs to foreignApps if not already present
              for (const box of boxesToAdd) {
                const boxAppId = typeof box.appIndex === 'number' ? box.appIndex : Number(box.appIndex);
                if (!txnObj.foreignApps.includes(boxAppId)) {
                  txnObj.foreignApps.push(boxAppId);
                }
              }
            }
            
            const rebuiltTxn = algosdk.makeApplicationCallTxnFromObject(txnObj);
            
            // Manually set boxes after creation (if present)
            if (boxesToAdd && boxesToAdd.length > 0) {
              rebuiltTxn.boxes = boxesToAdd;
            }
            
            // Verify accounts were preserved (makeApplicationCallTxnFromObject should handle them, but verify)
            if (txnObj.accounts && txnObj.accounts.length > 0) {
              // Ensure accounts are set on the rebuilt transaction
              if (!rebuiltTxn.accounts || rebuiltTxn.accounts.length !== txnObj.accounts.length) {
                rebuiltTxn.accounts = txnObj.accounts;
                console.log(`[buildSwapTransactions] Manually set ${txnObj.accounts.length} account(s) on rebuilt transaction ${i} (App ${txn.appIndex})`);
              }
            }
            
            // Clear group ID - we'll assign a new one to all transactions together after rebuilding
            rebuiltTxn.group = undefined;
            
            allTransactions[i] = rebuiltTxn;
          }
        }
        
        // Clear group IDs from all transactions (including those that weren't rebuilt)
        for (const txn of allTransactions) {
          if (txn.group) {
            txn.group = undefined;
          }
        }
        
        // Assign a single group ID to ALL transactions together
        // This ensures they all have the same group ID for atomic execution
        algosdk.assignGroupID(allTransactions);
        console.log(`[buildSwapTransactions] Assigned group ID to ${allTransactions.length} transaction(s)`);
      } else if (!simulationResult.success) {
        // Log warning but continue - boxes might still work or we'll get a clearer error
        // Even if simulation had errors, we might have gotten some box references
        if (simulationResult.boxReferences && simulationResult.boxReferences.length > 0) {
          console.warn('Transaction group simulation had issues but found box references:', simulationResult.error);
          console.warn('Using box references from simulation despite errors');
        } else {
          console.warn('Transaction group simulation had issues:', simulationResult.error);
          console.warn('Continuing without box population from simulation');
        }
      }
    } catch (error) {
      // If simulation fails, log warning but continue
      // The transactions might still work, or we'll get a clearer error when they're submitted
      // This is expected if the dryrun API format doesn't match the SDK version
      console.warn('Failed to simulate transaction group for box discovery:', error.message);
      console.warn('Error details:', error);
      console.warn('Continuing without box population from simulation - existing box logic will be used');
      
      // The existing box construction logic in the transaction building code should still work
      // for ARC200 tokens, so transactions should be functional even without simulation
    }
  }
  
  // Log final transaction group summary
  console.log(`\n[buildSwapTransactions] Final transaction group summary:`);
  console.log(`  Total transactions: ${allTransactions.length}`);
  console.log(`  Route: ${splitDetails.length} pool(s)`);
  for (let i = 0; i < allTransactions.length; i++) {
    const txn = allTransactions[i];
    const summary = getTransactionSummary(txn, i);
    console.log(`  [${i}] ${summary}`);
  }
  console.log('');
  
  // Encode all transactions back to base64
  return allTransactions.map(txn => 
    Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64')
  );
}

/**
 * Get a summary string for an algosdk.Transaction
 */
function getTransactionSummary(txn, index) {
  if (txn.type === 'pay') {
    const from = algosdk.encodeAddress(txn.from.publicKey);
    const to = algosdk.encodeAddress(txn.to.publicKey);
    return `Payment: ${from.substring(0, 8)}... -> ${to.substring(0, 8)}..., Amount: ${txn.amount} microAlgos`;
  } else if (txn.type === 'axfer') {
    const from = algosdk.encodeAddress(txn.from.publicKey);
    const to = algosdk.encodeAddress(txn.to.publicKey);
    return `Asset Transfer: ${from.substring(0, 8)}... -> ${to.substring(0, 8)}..., Asset: ${txn.assetIndex}, Amount: ${txn.amount}`;
  } else if (txn.type === 'appl') {
    const from = algosdk.encodeAddress(txn.from.publicKey);
    const noteText = txn.note ? new TextDecoder().decode(txn.note).substring(0, 40) : 'No note';
    let summary = `App Call: ${from.substring(0, 8)}... -> App ${txn.appIndex}`;
    if (txn.boxes && txn.boxes.length > 0) {
      summary += `, ${txn.boxes.length} box(es)`;
    }
    if (txn.foreignApps && txn.foreignApps.length > 0) {
      summary += `, Foreign Apps: [${txn.foreignApps.join(', ')}]`;
    }
    if (txn.foreignAssets && txn.foreignAssets.length > 0) {
      summary += `, Foreign Assets: [${txn.foreignAssets.join(', ')}]`;
    }
    return summary;
  }
  return `Transaction ${index}: ${txn.type || 'unknown'}`;
}

export { buildSwapTransactions };

