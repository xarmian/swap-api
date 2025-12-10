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
import { getTokenMetaFromConfig, getUnderlyingForWrapped } from './config.js';
import { algodClient, indexerClient } from './clients.js';

const ARC200_BALANCES_PREFIX = Buffer.from('balances', 'utf-8');
const ARC200_WITHDRAW_METHOD = new algosdk.ABIMethod({
  name: 'withdraw',
  args: [{ type: 'uint64' }],
  returns: { type: 'uint256' }
});
const UINT64_MAX = (1n << 64n) - 1n;

/**
 * Check if an account is opted into an ASA
 * @param {string} address - Account address
 * @param {number} assetId - ASA ID
 * @returns {Promise<boolean>} True if opted in, false otherwise
 */
async function isAccountOptedIntoAsset(address, assetId) {
  try {
    await algodClient.accountAssetInformation(address, assetId).do();
    return true; // If we get info, account is opted in
  } catch (error) {
    // If asset info lookup fails, account is not opted in
    return false;
  }
}

/**
 * Build ASA opt-in transaction
 * @param {string} address - Account address
 * @param {number} assetId - ASA ID to opt into
 * @returns {Promise<algosdk.Transaction>} Opt-in transaction
 */
async function buildAssetOptInTransaction(address, assetId) {
  const suggestedParams = await algodClient.getTransactionParams().do();

  // ASA opt-in is a 0-amount asset transfer to self
  return algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    from: address,
    to: address,
    amount: 0,
    assetIndex: assetId,
    suggestedParams
  });
}

/**
 * Build a simulate request
 * @param {Array<algosdk.Transaction>} transactions - Transactions to simulate
 * @param {Algodv2} algodClient - Algod client
 * @param {boolean} allowUnnamedResources - If false, simulation will fail on missing resources (useful for discovery)
 * @returns {Promise<Object>} Simulate request object
 */
async function buildSimulateRequest(transactions, algodClient, allowUnnamedResources = true) {
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
    fixSigners: true  // IMPORTANT: Use fixSigners (not fixSigs) to handle rekeyed accounts correctly
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
              // Don't advance chunkStart, retry with smaller chunk
            } else {
              // Other error or chunk size is already 1, continue
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
      
      // Not a 413 error - rethrow
      throw error;
    }

    // Extract unnamedResourcesAccessed from simulation results
    const boxReferences = [];
    let unnamedResourcesAccessed = null;
    
    if (simulateResponse.txnGroups && simulateResponse.txnGroups.length > 0) {
      const txnGroup = simulateResponse.txnGroups[0];
      
      // Get group-level unnamedResourcesAccessed
      unnamedResourcesAccessed = txnGroup.unnamedResourcesAccessed || {};
      const groupBoxes = unnamedResourcesAccessed.boxes || [];
      
      // Get per-transaction unnamedResourcesAccessed
      const txnResults = txnGroup.txnResults || [];
      
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
    
    // Extract resources from error messages - this is how we discover what's needed dynamically!
    // Error formats:
    // - "unavailable App {appId}" - missing foreign app
    // - "unavailable Local State {appId}+{accountAddress} would be accessible" - missing account for local state
    // - "unavailable Holding {assetId}+{accountAddress} would be accessible" - missing asset holding for account
    const accountsFromErrors = new Set();
    const appsFromErrors = new Set();
    const assetsFromErrors = new Set();
    if (failureMessage) {
      // Extract missing apps: "unavailable App {appId}" or "unavailable App {appId}. Details: app={txnAppId}"
      const unavailableAppMatches = failureMessage.matchAll(/unavailable App (\d+)(?:\. Details: app=(\d+))?/g);
      for (const match of unavailableAppMatches) {
        const appId = Number(match[1]);
        appsFromErrors.add(appId);
      }

      // Extract accounts AND apps: "unavailable Local State {appId}+{accountAddress}"
      // Both the app and account are needed - you can't access local state without the app in foreignApps
      const localStateMatches = failureMessage.matchAll(/unavailable Local State (\d+)\+([A-Z2-7]{58})/g);
      for (const match of localStateMatches) {
        const appId = Number(match[1]);
        const accountAddr = match[2];
        appsFromErrors.add(appId); // App must be in foreignApps for local state access
        accountsFromErrors.add(accountAddr);
      }

      // Extract accounts AND assets: "unavailable Holding {assetId}+{accountAddress}"
      // Both the asset and account are needed for asset transfers
      const holdingMatches = failureMessage.matchAll(/unavailable Holding (\d+)\+([A-Z2-7]{58})/g);
      for (const match of holdingMatches) {
        const assetId = Number(match[1]);
        const accountAddr = match[2];
        assetsFromErrors.add(assetId); // Asset must be in foreignAssets
        accountsFromErrors.add(accountAddr);
      }
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
              appsFromErrors.add(appId);
            }
            
            // Extract accounts AND apps: "unavailable Local State {appId}+{accountAddress}"
            // Both the app and account are needed - you can't access local state without the app in foreignApps
            const localStateMatches = errorMsg.matchAll(/unavailable Local State (\d+)\+([A-Z2-7]{58})/g);
            for (const match of localStateMatches) {
              const appId = Number(match[1]);
              const accountAddr = match[2];
              appsFromErrors.add(appId); // App must be in foreignApps for local state access
              accountsFromErrors.add(accountAddr);
            }

            // Extract accounts AND assets: "unavailable Holding {assetId}+{accountAddress}"
            // Both the asset and account are needed for asset transfers
            const holdingMatches = errorMsg.matchAll(/unavailable Holding (\d+)\+([A-Z2-7]{58})/g);
            for (const match of holdingMatches) {
              const assetId = Number(match[1]);
              const accountAddr = match[2];
              assetsFromErrors.add(assetId); // Asset must be in foreignAssets
              accountsFromErrors.add(accountAddr);
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
              appsFromErrors.add(appId);
            }
            
            // Extract accounts AND apps: "unavailable Local State {appId}+{accountAddress}"
            // Both the app and account are needed - you can't access local state without the app in foreignApps
            const localStateMatches = errorMsg.matchAll(/unavailable Local State (\d+)\+([A-Z2-7]{58})/g);
            for (const match of localStateMatches) {
              const appId = Number(match[1]);
              const accountAddr = match[2];
              appsFromErrors.add(appId); // App must be in foreignApps for local state access
              accountsFromErrors.add(accountAddr);
            }

            // Extract accounts AND assets: "unavailable Holding {assetId}+{accountAddress}"
            // Both the asset and account are needed for asset transfers
            const holdingMatches = errorMsg.matchAll(/unavailable Holding (\d+)\+([A-Z2-7]{58})/g);
            for (const match of holdingMatches) {
              const assetId = Number(match[1]);
              const accountAddr = match[2];
              assetsFromErrors.add(assetId); // Asset must be in foreignAssets
              accountsFromErrors.add(accountAddr);
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
    
    const hasErrors = !!failureMessage || errors.length > 0;

    // Even if there are errors, if we got box references, consider it a partial success
    // The errors might be expected (e.g., missing intermediate tokens in multi-hop routes)
    // but we still want to extract the box information
    const hasBoxReferences = boxReferences.length > 0;
    const success = !hasErrors || hasBoxReferences; // Success if no errors OR we got box references

    return {
      success: success,
      boxReferences: boxReferences,
      unnamedResourcesAccessed: unnamedResourcesAccessed,
      simulateResponse: simulateResponse,
      errors: errors,
      accountsFromErrors: Array.from(accountsFromErrors), // Accounts extracted from error messages
      appsFromErrors: Array.from(appsFromErrors), // Apps extracted from error messages (e.g., "unavailable App {appId}")
      assetsFromErrors: Array.from(assetsFromErrors), // Assets extracted from error messages (e.g., "unavailable Holding {assetId}+{address}")
      error: hasErrors && !hasBoxReferences ? 'Simulation detected errors and no box references found' : 
             hasErrors ? 'Simulation detected errors but box references were found' : null
    };
  } catch (error) {
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
 * Build a single application call transaction for unwrapping one wrapped token
 * Internal helper used by batch unwrap
 */
async function buildSingleUnwrapTxn({ address, wrappedTokenId, amount }) {
  const wrappedNum = Number(wrappedTokenId);
  if (!Number.isFinite(wrappedNum) || wrappedNum <= 0) {
    throw new Error(`Invalid wrappedTokenId provided: ${wrappedTokenId}`);
  }
  const amountBigInt = BigInt(amount);
  if (amountBigInt <= 0n || amountBigInt > UINT64_MAX) {
    throw new Error(`Invalid amount for ${wrappedTokenId}: ${amount}`);
  }

  const unwrapInfo = getUnderlyingForWrapped(wrappedNum);
  if (!unwrapInfo || !unwrapInfo.unwrapSupported || unwrapInfo.underlyingId == null) {
    throw new Error(`Wrapped token ${wrappedTokenId} is not recognized as unwrap-capable`);
  }
  const underlyingIdNum = Number(unwrapInfo.underlyingId);
  const inferredUnderlyingType = unwrapInfo.underlyingType || (underlyingIdNum === 0 ? 'native' : 'ASA');
  if (inferredUnderlyingType !== 'native' && inferredUnderlyingType !== 'ASA') {
    throw new Error(`Wrapped token ${wrappedTokenId} does not map to a supported underlying token type`);
  }

  const suggestedParamsRaw = await algodClient.getTransactionParams().do();
  const baseFee = Number(suggestedParamsRaw.minFee || algosdk.ALGORAND_MIN_TX_FEE);
  // Fee will be recalculated after simulation discovers actual boxes needed
  const suggestedParams = { ...suggestedParamsRaw, flatFee: true, fee: baseFee };

  const selector = ARC200_WITHDRAW_METHOD.getSelector();
  const encodedAmount = algosdk.ABIType.from('uint64').encode(amountBigInt);
  const appArgs = [selector, encodedAmount];

  // Optional metadata for clarity (note)
  const wrappedMeta = getTokenMetaFromConfig(wrappedNum);
  const underlyingMeta = underlyingIdNum > 0 ? getTokenMetaFromConfig(underlyingIdNum) : null;
  const wrappedSymbol = wrappedMeta?.symbol || `ARC200-${wrappedNum}`;
  const underlyingSymbol = inferredUnderlyingType === 'native'
    ? 'VOI'
    : underlyingMeta?.symbol || `ASA-${underlyingIdNum}`;
  const note = new TextEncoder().encode(
    `Unwrap ${amountBigInt.toString()} ${wrappedSymbol} -> ${underlyingSymbol} for ${address}`
  );

  // Build transaction without boxes initially - simulation will discover required boxes
  // foreignAssets will also be discovered via simulation
  return algosdk.makeApplicationNoOpTxnFromObject({
    from: address,
    appIndex: wrappedNum,
    suggestedParams,
    appArgs,
    boxes: [], // Start with empty boxes - simulation will discover what's needed
    foreignAssets: undefined, // Will be discovered via simulation
    note
  });
}

/**
 * Build an atomic transaction group to unwrap multiple wrapped tokens
 * @param {Object} params
 * @param {string} params.address
 * @param {Array<{wrappedTokenId: string|number, amount: string|number|bigint}>} params.items
 * @returns {Promise<{transactions: string[], networkFee: number}>}
 */
async function buildBatchUnwrapTransactions({ address, items }) {
  if (!address) {
    throw new Error('Address is required to build unwrap transactions');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('items array is required and must be non-empty');
  }

  // Build individual txns
  const txns = [];
  for (const item of items) {
    if (!item || item.wrappedTokenId === undefined || item.amount === undefined) {
      throw new Error('Each item must include wrappedTokenId and amount');
    }
    const txn = await buildSingleUnwrapTxn({
      address,
      wrappedTokenId: item.wrappedTokenId,
      amount: item.amount
    });
    txns.push(txn);
  }

  // Assign group id to all
  algosdk.assignGroupID(txns);

  // Simulate the transaction group to discover box references, foreign apps, and foreign assets
  // This follows the same pattern as buildSwapTransactions
  try {
    const simulationResult = await simulateTransactionGroup(txns, algodClient);
    
    // Extract resources from simulation results
    if (simulationResult && simulationResult.simulateResponse) {
      const simulateResponse = simulationResult.simulateResponse;
      const txnGroup = simulateResponse.txnGroups?.[0];
      const txnResults = txnGroup?.txnResults || [];
      
      // GROUP RESOURCE SHARING: Collect all unique boxes/apps/assets/accounts across the entire group
      const uniqueBoxes = new Map(); // key: `${appIndex}:${boxNameHex}`, value: { appIndex, name }
      const uniqueForeignApps = new Set();
      const uniqueForeignAssets = new Set();
      const uniqueAccounts = new Set();
      
      // Add apps extracted from error messages
      if (simulationResult.appsFromErrors) {
        for (const appId of simulationResult.appsFromErrors) {
          uniqueForeignApps.add(appId);
        }
      }
      
      // Add accounts extracted from error messages
      if (simulationResult.accountsFromErrors) {
        for (const accountAddr of simulationResult.accountsFromErrors) {
          uniqueAccounts.add(accountAddr);
        }
      }

      // Add assets extracted from error messages (e.g., "unavailable Holding {assetId}+{address}")
      if (simulationResult.assetsFromErrors) {
        for (const assetId of simulationResult.assetsFromErrors) {
          uniqueForeignAssets.add(assetId);
        }
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
      
      // Collect group-level unnamedResourcesAccessed
      const groupUnnamed = txnGroup?.unnamedResourcesAccessed || {};
      const groupApps = groupUnnamed.apps || [];
      const groupAssets = groupUnnamed.assets || [];
      const groupAccounts = groupUnnamed.accounts || [];
      
      for (const appId of groupApps) {
        const appIdNum = typeof appId === 'number' ? appId : Number(appId);
        uniqueForeignApps.add(appIdNum);
      }
      
      for (const assetId of groupAssets) {
        const assetIdNum = typeof assetId === 'number' ? assetId : Number(assetId);
        uniqueForeignAssets.add(assetIdNum);
      }
      
      for (const account of groupAccounts) {
        const accountAddr = typeof account === 'string' ? account : algosdk.encodeAddress(account);
        uniqueAccounts.add(accountAddr);
      }
      
      // Collect per-transaction unnamedResourcesAccessed
      for (let i = 0; i < txnResults.length && i < txns.length; i++) {
        const txnResult = txnResults[i];
        const txnUnnamed = txnResult.unnamedResourcesAccessed || {};
        const txnApps = txnUnnamed.apps || [];
        const txnAssets = txnUnnamed.assets || [];
        const txnAccounts = txnUnnamed.accounts || [];
        
        for (const appId of txnApps) {
          const appIdNum = typeof appId === 'number' ? appId : Number(appId);
          uniqueForeignApps.add(appIdNum);
        }
        
        for (const assetId of txnAssets) {
          const assetIdNum = typeof assetId === 'number' ? assetId : Number(assetId);
          uniqueForeignAssets.add(assetIdNum);
        }
        
        for (const account of txnAccounts) {
          const accountAddr = typeof account === 'string' ? account : algosdk.encodeAddress(account);
          uniqueAccounts.add(accountAddr);
        }
      }
      
      // Also collect foreignApps and foreignAssets that are already in transactions
      for (const txn of txns) {
        if (txn.type === 'appl') {
          if (txn.foreignApps && Array.isArray(txn.foreignApps) && txn.foreignApps.length > 0) {
            for (const appId of txn.foreignApps) {
              const appIdNum = typeof appId === 'number' ? appId : Number(appId);
              uniqueForeignApps.add(appIdNum);
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
      
      // Distribute resources across transactions in the group
      const allUniqueBoxes = Array.from(uniqueBoxes.values());
      const allUniqueForeignApps = Array.from(uniqueForeignApps);
      const allUniqueForeignAssets = Array.from(uniqueForeignAssets);
      const allUniqueAccounts = Array.from(uniqueAccounts);
      
      // Initialize arrays for all transactions
      for (const txn of txns) {
        if (txn.type === 'appl') {
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
      }
      
      // Distribute boxes across transactions
      for (const box of allUniqueBoxes) {
        const boxNameHex = Buffer.from(box.name).toString('hex');
        const alreadyInGroup = txns.some(txn => 
          txn.type === 'appl' && txn.boxes.some(b => {
            const bAppIndex = typeof b.appIndex === 'number' ? b.appIndex : Number(b.appIndex);
            const bNameHex = Buffer.from(b.name).toString('hex');
            return bAppIndex === box.appIndex && bNameHex === boxNameHex;
          })
        );
        if (alreadyInGroup) {
          continue; // Already accessible to all transactions via group sharing
        }
        
        let added = false;
        for (const txn of txns) {
          if (txn.type !== 'appl') continue;
          
          const currentBoxes = txn.boxes.length;
          const currentForeignApps = txn.foreignApps.length;
          const currentForeignAssets = txn.foreignAssets.length;
          const currentAccounts = (txn.accounts || []).length;
          const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;
          
          const needsForeignApp = !txn.foreignApps.includes(box.appIndex);
          const additionalReferences = 1 + (needsForeignApp ? 1 : 0);
          
          if (totalReferences + additionalReferences <= 8) {
            txn.boxes.push({
              appIndex: box.appIndex,
              name: box.name
            });
            
            if (needsForeignApp) {
              txn.foreignApps.push(box.appIndex);
            }
            
            added = true;
            break;
          }
        }
      }
      
      // Distribute foreignApps across transactions
      for (const appId of allUniqueForeignApps) {
        const alreadyInGroup = txns.some(txn => 
          txn.type === 'appl' && txn.foreignApps.includes(appId)
        );
        if (alreadyInGroup) {
          continue; // Already accessible to all transactions via group sharing
        }
        
        let added = false;
        for (const txn of txns) {
          if (txn.type !== 'appl') continue;
          
          const currentBoxes = txn.boxes.length;
          const currentForeignApps = txn.foreignApps.length;
          const currentForeignAssets = txn.foreignAssets.length;
          const currentAccounts = (txn.accounts || []).length;
          const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;
          
          if (totalReferences < 8) {
            txn.foreignApps.push(appId);
            added = true;
            break;
          }
        }
      }
      
      // Distribute foreignAssets across transactions
      for (const assetId of allUniqueForeignAssets) {
        const alreadyInGroup = txns.some(txn => 
          txn.type === 'appl' && txn.foreignAssets.includes(assetId)
        );
        if (alreadyInGroup) {
          continue; // Already accessible to all transactions via group sharing
        }
        
        let added = false;
        for (const txn of txns) {
          if (txn.type !== 'appl') continue;
          
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
      }
      
      // Distribute accounts across transactions (for local state access)
      // Map apps to their creator accounts if needed
      const appToCreatorAccount = new Map();
      for (const appId of allUniqueForeignApps) {
        try {
          const appInfo = await indexerClient.lookupApplications(appId).do();
          if (appInfo.application && appInfo.application.params && appInfo.application.params.creator) {
            const creatorAddr = appInfo.application.params.creator;
            appToCreatorAccount.set(appId, creatorAddr);
            uniqueAccounts.add(creatorAddr);
          }
        } catch (error) {
          // Silently skip if lookup fails
        }
      }
      
      for (const accountAddr of allUniqueAccounts) {
        const alreadyInGroup = txns.some(txn => 
          txn.type === 'appl' && txn.accounts && txn.accounts.some(acc => {
            const accStr = typeof acc === 'string' ? acc : algosdk.encodeAddress(acc);
            return accStr === accountAddr;
          })
        );
        if (alreadyInGroup) {
          continue; // Already accessible to all transactions via group sharing
        }
        
        // Find transactions that need this account (transactions with apps that have this creator)
        const transactionsNeedingAccount = [];
        for (let i = 0; i < txns.length; i++) {
          const txn = txns[i];
          if (txn.type !== 'appl') continue;
          
          // Check if this transaction has any app that needs this account
          const needsAccount = txn.foreignApps && txn.foreignApps.some(appId => {
            const creatorAccount = appToCreatorAccount.get(appId);
            return creatorAccount === accountAddr;
          });
          
          if (needsAccount) {
            transactionsNeedingAccount.push({ txn, idx: i });
          }
        }
        
        // If no transactions need it but it's in uniqueAccounts, add to first transaction with room
        if (transactionsNeedingAccount.length === 0) {
          for (const txn of txns) {
            if (txn.type !== 'appl') continue;
            
            const currentBoxes = txn.boxes.length;
            const currentForeignApps = txn.foreignApps.length;
            const currentForeignAssets = txn.foreignAssets.length;
            const currentAccounts = (txn.accounts || []).length;
            const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;
            
            // Check both total references (8) and accounts limit (4)
            if (totalReferences < 8 && currentAccounts < 4) {
              if (!txn.accounts) {
                txn.accounts = [];
              }
              txn.accounts.push(accountAddr);
              break;
            }
          }
        } else {
          // Add to transactions that need it
          for (const { txn } of transactionsNeedingAccount) {
            if (!txn.accounts) {
              txn.accounts = [];
            }

            const alreadyInTxn = txn.accounts.some(acc => {
              const accStr = typeof acc === 'string' ? acc : algosdk.encodeAddress(acc);
              return accStr === accountAddr;
            });
            if (!alreadyInTxn) {
              const currentBoxes = txn.boxes.length;
              const currentForeignApps = txn.foreignApps.length;
              const currentForeignAssets = txn.foreignAssets.length;
              const currentAccounts = txn.accounts.length;
              const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;

              // Check both total references (8) and accounts limit (4)
              if (totalReferences < 8 && currentAccounts < 4) {
                txn.accounts.push(accountAddr);
              }
            }
          }
        }
      }
    }
  } catch (error) {
    // If simulation fails, continue - transactions may still work
  }

  // Recalculate fees based on actual boxes/resources discovered
  // Base fee: 1000 microAlgos per transaction
  // Box fee: 2500 microAlgos per box reference
  // Inner transaction fee: 1000 microAlgos (ARC200 withdraw creates an inner transaction to transfer underlying token)
  for (const txn of txns) {
    if (txn.type === 'appl') {
      const baseFee = 1000;
      const boxFee = (txn.boxes?.length || 0) * 2500;
      const innerTxnFee = 1000; // ARC200 withdraw creates inner transaction for transfer
      const totalFee = baseFee + boxFee + innerTxnFee;
      txn.fee = totalFee;
      // Update suggestedParams if it exists
      if (txn.suggestedParams) {
        txn.suggestedParams.fee = totalFee;
        txn.suggestedParams.flatFee = true;
      }
    }
  }

  // Clear group IDs from all transactions before reassigning
  // This is necessary because we modified transactions (added boxes, foreignApps, etc.)
  for (const txn of txns) {
    if (txn.group) {
      txn.group = undefined;
    }
  }

  // Reassign group ID to all transactions together
  // This ensures they all have the same group ID for atomic execution
  algosdk.assignGroupID(txns);

  // Aggregate fees
  let totalFees = 0;
  for (const t of txns) {
    totalFees += Number(t.fee || 0);
  }

  const encodedTransactions = txns.map(t =>
    Buffer.from(algosdk.encodeUnsignedTransaction(t)).toString('base64')
  );

  return {
    transactions: encodedTransactions,
    networkFee: totalFees
  };
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
  
  // Track swap amounts and addresses for native VOI swaps to exclude from network fee calculation
  // When swapping FROM native VOI, payment transactions with swap amounts should NOT be counted as fees
  const swapAmountsToExclude = new Set(); // Set of BigInt amounts that are swap amounts, not fees
  const swapRecipientAddresses = new Set(); // Set of addresses that receive swap amounts (pool addresses, wrapped token contracts)

  // Track Nomadex pool IDs dynamically (to ensure factory app 411751 is added to foreignApps)
  const nomadexPoolIds = new Set();

  // For multi-hop routes, check if intermediate tokens are ASAs that need opt-in
  // Intermediate tokens are output tokens of all hops EXCEPT the final hop
  // We need to opt-in BEFORE the swap happens because the pool's inner transaction
  // will try to send the ASA to the user's account
  if (isMultiHop && splitDetails.length > 1) {
    const intermediateAsaOptIns = [];

    for (let i = 0; i < splitDetails.length - 1; i++) {
      const split = splitDetails[i];
      const { poolCfg } = split;
      const dex = poolCfg.dex || 'humbleswap';
      const splitOutputToken = split.outputToken;
      const outputTokenNum = Number(splitOutputToken);

      // Skip native token (VOI = 0)
      if (outputTokenNum === 0) {
        continue;
      }

      // Determine output token type
      let outputTokenType = null;
      if (dex === 'nomadex') {
        outputTokenType = getTokenTypeFromConfig(poolCfg, outputTokenNum);
      } else {
        // For HumbleSwap, intermediate tokens between Nomadex pools are ASAs
        // Check if the next hop is also Nomadex - if so, the token is likely an ASA
        const nextSplit = splitDetails[i + 1];
        const nextDex = nextSplit?.poolCfg?.dex || 'humbleswap';
        if (nextDex === 'nomadex') {
          outputTokenType = getTokenTypeFromConfig(nextSplit.poolCfg, outputTokenNum);
        }
      }

      // Only need opt-in for ASA tokens (not ARC200 or native)
      if (outputTokenType === 'ASA') {
        // Check if user is already opted in
        const isOptedIn = await isAccountOptedIntoAsset(address, outputTokenNum);

        if (!isOptedIn) {
          console.log(`[MultiHop] Account not opted into intermediate ASA ${outputTokenNum}, adding opt-in transaction`);
          const optInTxn = await buildAssetOptInTransaction(address, outputTokenNum);
          intermediateAsaOptIns.push(optInTxn);
        } else {
          console.log(`[MultiHop] Account already opted into intermediate ASA ${outputTokenNum}`);
        }
      }
    }

    // Prepend opt-in transactions to allTransactions
    if (intermediateAsaOptIns.length > 0) {
      console.log(`[MultiHop] Adding ${intermediateAsaOptIns.length} ASA opt-in transaction(s) to start of group`);
      allTransactions.push(...intermediateAsaOptIns);
    }
  }

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
      // Track this Nomadex pool ID for factory app inclusion later
      nomadexPoolIds.add(poolId);

      // Build Nomadex transactions
      const inputTokenType = getTokenTypeFromConfig(poolCfg, inputTokenNum);
      const outputTokenType = getTokenTypeFromConfig(poolCfg, outputTokenNum);
      
      if (!inputTokenType || !outputTokenType) {
        throw new Error(`Could not determine token types for pool ${poolId}`);
      }
      
      const isDirectionAlphaToBeta = quote.poolInfo.isDirectionAlphaToBeta;
      
      // Track swap amount and pool address for native VOI swaps to exclude from network fee
      if (inputTokenType === 'native' && inputTokenNum === 0) {
        const poolAddress = algosdk.getApplicationAddress(poolId);
        swapAmountsToExclude.add(amountBigInt);
        swapRecipientAddresses.add(poolAddress);
      }
      
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
        } else {
          // For non-app-call transactions, just use the decoded transaction as-is
          decodedTxns.push(txn);
        }
      }
      
      allTransactions.push(...decodedTxns);
      // Resources for Nomadex are added in the centralized distribution phase after simulation
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
      
      // Track swap amount and wrapped token contract address for native VOI swaps to exclude from network fee
      if (inputTokenNum === 0 && !inputFromPreviousHop) {
        // When swapping FROM native VOI, the deposit payment goes to the wrapped token contract
        const wrappedTokenContractAddress = algosdk.getApplicationAddress(inputWrapped);
        swapAmountsToExclude.add(amountBigInt);
        swapRecipientAddresses.add(wrappedTokenContractAddress);
      }

      // Apply safety margin to minimum output (same as Nomadex)
      // The contract's calculation may differ slightly due to rounding, so we need to be more conservative
      const safetyMargin = BigInt(99); // 99% of minimum (1% buffer)
      const adjustedMinOutput = (BigInt(minOutput) * safetyMargin) / BigInt(100);

      // Build swap transactions using arccjs (NO SIMULATION!)
      const decodedTxns = await buildHumbleswapSwapTransactionsArccjs({
        sender: address,
        poolId: poolId,
        inputWrapped: inputWrapped,
        outputWrapped: outputWrapped,
        amountIn: amountBigInt.toString(),
        minAmountOut: adjustedMinOutput.toString(),
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
      // Resources for HumbleSwap are added in the centralized distribution phase after simulation
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
  //
  // ITERATIVE SIMULATION: We loop because simulation with allowUnnamedResources may fail
  // at the first unavailable resource. After adding that resource, we re-simulate to discover
  // more resources. This continues until simulation passes or no new resources are found.
  if (shouldSimulateGroup && allTransactions.length > 0) {
    try {
      // Track cumulative resources discovered across all iterations
      const cumulativeAppsFromErrors = new Set();
      const cumulativeAccountsFromErrors = new Set();
      const cumulativeAssetsFromErrors = new Set();

      const MAX_SIMULATION_ITERATIONS = 5;
      let simulationResult = null;
      let lastSimulationPassed = false;

      for (let simIteration = 0; simIteration < MAX_SIMULATION_ITERATIONS; simIteration++) {
        // Clear group IDs before simulation
        for (const txn of allTransactions) {
          if (txn.group) {
            txn.group = undefined;
          }
        }
        algosdk.assignGroupID(allTransactions);

        simulationResult = await simulateTransactionGroup(allTransactions, algodClient);

        // Check if simulation passed (no errors)
        const txnGroup = simulationResult?.simulateResponse?.txnGroups?.[0];
        const failureMessage = txnGroup?.failureMessage;
        const hasErrors = !!failureMessage || (simulationResult?.errors && simulationResult.errors.length > 0);

        if (!hasErrors) {
          lastSimulationPassed = true;
          break; // Simulation passed, no need to iterate further
        }

        // Extract new resources from errors
        const newApps = simulationResult?.appsFromErrors || [];
        const newAccounts = simulationResult?.accountsFromErrors || [];
        const newAssets = simulationResult?.assetsFromErrors || [];

        // Count how many genuinely NEW resources we found this iteration
        let newResourceCount = 0;
        for (const app of newApps) {
          if (!cumulativeAppsFromErrors.has(app)) {
            cumulativeAppsFromErrors.add(app);
            newResourceCount++;
          }
        }
        for (const account of newAccounts) {
          if (!cumulativeAccountsFromErrors.has(account)) {
            cumulativeAccountsFromErrors.add(account);
            newResourceCount++;
          }
        }
        for (const asset of newAssets) {
          if (!cumulativeAssetsFromErrors.has(asset)) {
            cumulativeAssetsFromErrors.add(asset);
            newResourceCount++;
          }
        }

        // If no new resources found, stop iterating (we're not making progress)
        if (newResourceCount === 0) {
          break;
        }

        // Apply newly discovered resources to transactions
        // Find app call transactions to distribute resources to
        const appCallTxnsForDistribution = [];
        for (let i = 0; i < allTransactions.length; i++) {
          const txn = allTransactions[i];
          if (txn.type === 'appl') {
            if (!txn.foreignApps) txn.foreignApps = [];
            if (!txn.foreignAssets) txn.foreignAssets = [];
            if (!txn.accounts) txn.accounts = [];
            appCallTxnsForDistribution.push({ txn, idx: i });
          }
        }

        // Add apps from errors to transactions
        for (const appId of newApps) {
          if (!appCallTxnsForDistribution.some(({ txn }) => txn.foreignApps.includes(appId))) {
            for (const { txn } of appCallTxnsForDistribution) {
              const currentRefs = (txn.boxes?.length || 0) + txn.foreignApps.length + txn.foreignAssets.length + txn.accounts.length;
              if (currentRefs < 8 && !txn.foreignApps.includes(appId)) {
                txn.foreignApps.push(appId);
                break;
              }
            }
          }
        }

        // Add assets from errors to transactions
        for (const assetId of newAssets) {
          if (!appCallTxnsForDistribution.some(({ txn }) => txn.foreignAssets.includes(assetId))) {
            for (const { txn } of appCallTxnsForDistribution) {
              const currentRefs = (txn.boxes?.length || 0) + txn.foreignApps.length + txn.foreignAssets.length + txn.accounts.length;
              if (currentRefs < 8 && !txn.foreignAssets.includes(assetId)) {
                txn.foreignAssets.push(assetId);
                break;
              }
            }
          }
        }

        // Add accounts from errors to transactions
        for (const accountAddr of newAccounts) {
          const isInGroup = appCallTxnsForDistribution.some(({ txn }) =>
            txn.accounts.some(acc => {
              const accStr = typeof acc === 'string' ? acc : algosdk.encodeAddress(acc);
              return accStr === accountAddr;
            })
          );
          if (!isInGroup) {
            for (const { txn } of appCallTxnsForDistribution) {
              const currentRefs = (txn.boxes?.length || 0) + txn.foreignApps.length + txn.foreignAssets.length + txn.accounts.length;
              const currentAccounts = txn.accounts.length;
              // Check both total references (8) and accounts limit (4)
              if (currentRefs < 8 && currentAccounts < 4) {
                txn.accounts.push(accountAddr);
                break;
              }
            }
          }
        }

      }

      // Update simulationResult with cumulative resources for later processing
      if (simulationResult) {
        simulationResult.appsFromErrors = Array.from(cumulativeAppsFromErrors);
        simulationResult.accountsFromErrors = Array.from(cumulativeAccountsFromErrors);
        simulationResult.assetsFromErrors = Array.from(cumulativeAssetsFromErrors);
      }

      // VERIFICATION SIMULATION: Run a strict simulation (allowUnnamedResources: false)
      // to catch resources that were silently allowed but not reported in unnamedResourcesAccessed.
      // This is critical for catching inner transaction targets that the permissive simulation misses.
      if (lastSimulationPassed) {
        const MAX_VERIFY_ITERATIONS = 3;
        for (let verifyIteration = 0; verifyIteration < MAX_VERIFY_ITERATIONS; verifyIteration++) {
          try {
            // Clear and reassign group IDs
            for (const txn of allTransactions) {
              if (txn.group) {
                txn.group = undefined;
              }
            }
            algosdk.assignGroupID(allTransactions);

            // Build strict simulation request (allowUnnamedResources: false)
            const verifyTxnGroup = new algosdk.modelsv2.SimulateRequestTransactionGroup({
              txns: allTransactions.map((value) => {
                const encodedTxn = algosdk.encodeUnsignedSimulateTransaction(value);
                const decodedObj = algosdk.decodeObj(encodedTxn);
                return decodedObj;
              })
            });

            const verifyRequest = new algosdk.modelsv2.SimulateRequest({
              txnGroups: [verifyTxnGroup],
              allowUnnamedResources: false, // STRICT mode - will fail on missing resources
              allowEmptySignatures: true,
              fixSigners: true  // IMPORTANT: Use fixSigners (not fixSigs) to handle rekeyed accounts correctly
            });

            const verifyResponse = await algodClient.simulateTransactions(verifyRequest).do();
            const verifyGroup = verifyResponse.txnGroups?.[0];
            const verifyFailure = verifyGroup?.failureMessage;

            if (!verifyFailure) {
              // Verification passed - all resources are properly declared
              console.log(`[Verification] Passed on iteration ${verifyIteration + 1}`);
              break;
            }

            // Parse error messages for missing resources
            // Track newly discovered resources THIS iteration (not cumulative) for efficient distribution
            const newlyDiscoveredApps = new Set();
            const newlyDiscoveredAssets = new Set();
            const newlyDiscoveredAccounts = new Set();

            // Extract missing apps: "unavailable App {appId}"
            const unavailableAppMatches = verifyFailure.matchAll(/unavailable App (\d+)(?:\. Details: app=(\d+))?/g);
            for (const match of unavailableAppMatches) {
              const appId = Number(match[1]);
              if (appId > 0 && !cumulativeAppsFromErrors.has(appId)) {
                cumulativeAppsFromErrors.add(appId);
                newlyDiscoveredApps.add(appId);
                console.log(`[Verification] Discovered missing app: ${appId}`);
              }
            }

            // Extract accounts AND apps: "unavailable Local State {appId}+{accountAddress}"
            const localStateMatches = verifyFailure.matchAll(/unavailable Local State (\d+)\+([A-Z2-7]{58})/g);
            for (const match of localStateMatches) {
              const appId = Number(match[1]);
              const accountAddr = match[2];
              if (appId > 0 && !cumulativeAppsFromErrors.has(appId)) {
                cumulativeAppsFromErrors.add(appId);
                newlyDiscoveredApps.add(appId);
                console.log(`[Verification] Discovered missing app from local state: ${appId}`);
              }
              if (accountAddr && !cumulativeAccountsFromErrors.has(accountAddr)) {
                cumulativeAccountsFromErrors.add(accountAddr);
                newlyDiscoveredAccounts.add(accountAddr);
                console.log(`[Verification] Discovered missing account: ${accountAddr}`);
              }
            }

            // Extract accounts AND assets: "unavailable Holding {assetId}+{accountAddress}"
            const holdingMatches = verifyFailure.matchAll(/unavailable Holding (\d+)\+([A-Z2-7]{58})/g);
            for (const match of holdingMatches) {
              const assetId = Number(match[1]);
              const accountAddr = match[2];
              if (assetId > 0 && !cumulativeAssetsFromErrors.has(assetId)) {
                cumulativeAssetsFromErrors.add(assetId);
                newlyDiscoveredAssets.add(assetId);
                console.log(`[Verification] Discovered missing asset: ${assetId}`);
              }
              if (accountAddr && !cumulativeAccountsFromErrors.has(accountAddr)) {
                cumulativeAccountsFromErrors.add(accountAddr);
                newlyDiscoveredAccounts.add(accountAddr);
                console.log(`[Verification] Discovered missing account from holding: ${accountAddr}`);
              }
            }

            const newResourcesFound = newlyDiscoveredApps.size + newlyDiscoveredAssets.size + newlyDiscoveredAccounts.size;

            if (newResourcesFound === 0) {
              // No new resources found but verification still failing - other issue
              console.log(`[Verification] No new resources found but verification failed: ${verifyFailure.substring(0, 200)}`);
              break;
            }

            // Add newly discovered resources to transactions
            const appCallTxnsForVerify = [];
            for (let i = 0; i < allTransactions.length; i++) {
              const txn = allTransactions[i];
              if (txn.type === 'appl') {
                if (!txn.foreignApps) txn.foreignApps = [];
                if (!txn.foreignAssets) txn.foreignAssets = [];
                if (!txn.accounts) txn.accounts = [];
                appCallTxnsForVerify.push({ txn, idx: i });
              }
            }

            // Distribute only newly discovered apps (not all cumulative)
            for (const appId of newlyDiscoveredApps) {
              let distributed = false;
              for (const { txn } of appCallTxnsForVerify) {
                const currentRefs = (txn.boxes?.length || 0) + txn.foreignApps.length + txn.foreignAssets.length + txn.accounts.length;
                if (currentRefs < 8 && !txn.foreignApps.includes(appId)) {
                  txn.foreignApps.push(appId);
                  distributed = true;
                  break;
                }
              }
              if (!distributed) {
                console.warn(`[Verification] Could not distribute app ${appId} - all transactions at reference limit`);
              }
            }

            // Distribute only newly discovered assets (not all cumulative)
            for (const assetId of newlyDiscoveredAssets) {
              let distributed = false;
              for (const { txn } of appCallTxnsForVerify) {
                const currentRefs = (txn.boxes?.length || 0) + txn.foreignApps.length + txn.foreignAssets.length + txn.accounts.length;
                if (currentRefs < 8 && !txn.foreignAssets.includes(assetId)) {
                  txn.foreignAssets.push(assetId);
                  distributed = true;
                  break;
                }
              }
              if (!distributed) {
                console.warn(`[Verification] Could not distribute asset ${assetId} - all transactions at reference limit`);
              }
            }

            // Distribute only newly discovered accounts (not all cumulative)
            for (const accountAddr of newlyDiscoveredAccounts) {
              let distributed = false;
              for (const { txn } of appCallTxnsForVerify) {
                const currentRefs = (txn.boxes?.length || 0) + txn.foreignApps.length + txn.foreignAssets.length + txn.accounts.length;
                const currentAccounts = txn.accounts.length;
                if (currentRefs < 8 && currentAccounts < 4) {
                  txn.accounts.push(accountAddr);
                  distributed = true;
                  break;
                }
              }
              if (!distributed) {
                console.warn(`[Verification] Could not distribute account ${accountAddr} - all transactions at reference/account limit`);
              }
            }

            console.log(`[Verification] Iteration ${verifyIteration + 1}: Found ${newResourcesFound} new resources, retrying...`);
          } catch (verifyError) {
            // Verification simulation failed (might be 413 or other error) - continue without it
            console.log(`[Verification] Simulation error: ${verifyError.message}`);
            break;
          }
        }

        // Update simulationResult with any newly discovered resources from verification
        if (simulationResult) {
          simulationResult.appsFromErrors = Array.from(cumulativeAppsFromErrors);
          simulationResult.accountsFromErrors = Array.from(cumulativeAccountsFromErrors);
          simulationResult.assetsFromErrors = Array.from(cumulativeAssetsFromErrors);
        }
      }

      // Use box references even if simulation had errors (with allowUnnamedResources, we can still get resources)
      // This is important for multi-hop routes where intermediate tokens don't exist yet
      // Also extract foreignApps and foreignAssets from per-transaction unnamedResourcesAccessed
      if (simulationResult && simulationResult.simulateResponse) {
        const simulateResponse = simulationResult.simulateResponse;
        const txnGroup = simulateResponse.txnGroups?.[0];
        const txnResults = txnGroup?.txnResults || [];
        
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
          const txnAccounts = txnUnnamed.accounts || [];

          // Log per-transaction resources
          if (txnApps.length > 0 || txnAssets.length > 0 || txnAccounts.length > 0) {
            console.log(`[Simulation] Txn ${i} (app ${txn.appIndex}) unnamedResourcesAccessed: apps=${JSON.stringify(txnApps)}, assets=${JSON.stringify(txnAssets)}, accounts=${JSON.stringify(txnAccounts)}`);
          }

          // Initialize arrays if they don't exist
          if (!txn.foreignApps) {
            txn.foreignApps = [];
          }
          if (!txn.foreignAssets) {
            txn.foreignAssets = [];
          }
          if (!txn.accounts) {
            txn.accounts = [];
          }

          // Add apps that this SPECIFIC transaction needs (only if not already present)
          for (const appId of txnApps) {
            const appIdNum = typeof appId === 'number' ? appId : Number(appId);
            if (!txn.foreignApps.includes(appIdNum)) {
              // Check if adding this app would exceed the 8 reference limit
              const currentBoxes = (txn.boxes || []).length;
              const currentForeignApps = txn.foreignApps.length;
              const currentForeignAssets = txn.foreignAssets.length;
              const currentAccounts = txn.accounts.length;
              const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;

              if (totalReferences < 8) {
                txn.foreignApps.push(appIdNum);
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
              const currentAccounts = txn.accounts.length;
              const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;

              if (totalReferences < 8) {
                txn.foreignAssets.push(assetIdNum);
              }
            }
          }

          // Add accounts that this SPECIFIC transaction needs (only if not already present)
          // This is CRITICAL for asset holdings - the account must be in the accounts array
          for (const account of txnAccounts) {
            const accountAddr = typeof account === 'string' ? account : algosdk.encodeAddress(account);
            const alreadyInTxn = txn.accounts.some(acc => {
              const accStr = typeof acc === 'string' ? acc : algosdk.encodeAddress(acc);
              return accStr === accountAddr;
            });
            if (!alreadyInTxn) {
              // Check if adding this account would exceed limits
              const currentBoxes = (txn.boxes || []).length;
              const currentForeignApps = txn.foreignApps.length;
              const currentForeignAssets = txn.foreignAssets.length;
              const currentAccounts = txn.accounts.length;
              const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;

              // Check both total references (8) and accounts limit (4)
              if (totalReferences < 8 && currentAccounts < 4) {
                txn.accounts.push(accountAddr);
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
          for (const appId of simulationResult.appsFromErrors) {
            uniqueForeignApps.add(appId);
          }
        }
        
        // Add accounts extracted from error messages (e.g., "unavailable Local State 395642+3BNBKEC...")
        // These are discovered when simulation fails and tells us what accounts are needed
        if (simulationResult && simulationResult.accountsFromErrors) {
          for (const accountAddr of simulationResult.accountsFromErrors) {
            uniqueAccounts.add(accountAddr);
          }
        }

        // Add assets extracted from error messages (e.g., "unavailable Holding {assetId}+{address}")
        // These are discovered when simulation fails and tells us what assets are needed
        if (simulationResult && simulationResult.assetsFromErrors) {
          for (const assetId of simulationResult.assetsFromErrors) {
            uniqueForeignAssets.add(assetId);
          }
        }

        // Collect all unique boxes from simulation AND extract app addresses
        // Box references tell us which apps are involved - their addresses are needed for inner transactions
        // IMPORTANT: Preserve txnIndex to know which transaction accessed each box
        // This is critical for boxes that are CREATED by one transaction and READ by another
        const boxAppIds = new Set();
        if (simulationResult.boxReferences && simulationResult.boxReferences.length > 0) {
          for (const boxRef of simulationResult.boxReferences) {
            const appIndex = typeof boxRef.appIndex === 'number' ? boxRef.appIndex : Number(boxRef.appIndex);
            const name = boxRef.name instanceof Uint8Array
              ? boxRef.name
              : new Uint8Array(boxRef.name);
            const boxNameHex = Buffer.from(name).toString('hex');
            const key = `${appIndex}:${boxNameHex}`;

            if (!uniqueBoxes.has(key)) {
              // Store the txnIndex along with box info - use the EARLIEST transaction that accessed it
              // This ensures boxes are added to the transaction that creates them (which comes first)
              const txnIndex = typeof boxRef.txnIndex === 'number' ? boxRef.txnIndex : 0;
              uniqueBoxes.set(key, { appIndex, name, txnIndex });
              uniqueForeignApps.add(appIndex); // Box app must be in foreignApps
              boxAppIds.add(appIndex); // Track for address extraction
            } else {
              // Box already seen - update txnIndex if this reference is from an earlier transaction
              // This ensures the box is placed on the earliest transaction that needs it
              const existing = uniqueBoxes.get(key);
              const newTxnIndex = typeof boxRef.txnIndex === 'number' ? boxRef.txnIndex : 0;
              if (newTxnIndex < existing.txnIndex) {
                existing.txnIndex = newTxnIndex;
              }
            }
          }
        }

        // CRITICAL: Get application addresses for all box apps
        // These are needed for inner transactions (axfer, app calls with local state)
        for (const appId of boxAppIds) {
          if (appId > 0) {
            const appAddress = algosdk.getApplicationAddress(appId);
            uniqueAccounts.add(appAddress);
          }
        }

        // Also add application addresses for apps discovered in unnamedResourcesAccessed
        const groupUnnamedApps = txnGroup?.unnamedResourcesAccessed?.apps || [];
        for (const appId of groupUnnamedApps) {
          const appIdNum = typeof appId === 'number' ? appId : Number(appId);
          if (appIdNum > 0) {
            uniqueForeignApps.add(appIdNum);
            const appAddress = algosdk.getApplicationAddress(appIdNum);
            uniqueAccounts.add(appAddress);
          }
        }

        // Add the sender's address - inner transactions may need to access sender's holdings
        uniqueAccounts.add(address);

        // Add resources from splitDetails
        for (const split of splitDetails) {
          const splitInputToken = isMultiHop ? split.inputToken : inputToken;
          const splitOutputToken = isMultiHop ? split.outputToken : outputToken;
          const inputNum = Number(splitInputToken);
          const outputNum = Number(splitOutputToken);
          const dex = split.poolCfg?.dex;
          const poolId = Number(split.poolCfg?.poolId);

          // Add pool app and address for all DEXes
          if (poolId > 0) {
            uniqueForeignApps.add(poolId);
            uniqueAccounts.add(algosdk.getApplicationAddress(poolId));
          }

          if (dex === 'nomadex') {
            const tokA = split.poolCfg?.tokens?.tokA;
            const tokB = split.poolCfg?.tokens?.tokB;
            // Add ASA IDs only (type === 'ASA'), not ARC200 apps
            if (tokA?.type === 'ASA' && tokA.id > 0) uniqueForeignAssets.add(tokA.id);
            if (tokB?.type === 'ASA' && tokB.id > 0) uniqueForeignAssets.add(tokB.id);
            // Add factory app and address (holds assets for Nomadex)
            const factoryAppId = 411751;
            uniqueForeignApps.add(factoryAppId);
            uniqueAccounts.add(algosdk.getApplicationAddress(factoryAppId));
          } else if (dex === 'humbleswap') {
            // For HumbleSwap, add wrapped token contract addresses and underlying ASAs
            const underlyingToWrapped = split.poolCfg?.tokens?.underlyingToWrapped || {};
            for (const [underlying, wrapped] of Object.entries(underlyingToWrapped)) {
              const underlyingNum = Number(underlying);
              const wrappedNum = Number(wrapped);
              // Add underlying ASA IDs (not VOI=0)
              if (underlyingNum > 0) uniqueForeignAssets.add(underlyingNum);
              // Add wrapped token contract app and address (for inner axfer)
              if (wrappedNum > 0) {
                uniqueForeignApps.add(wrappedNum);
                uniqueAccounts.add(algosdk.getApplicationAddress(wrappedNum));
              }
            }
            // Also add wrappedPair tokens
            const wrappedPair = split.poolCfg?.tokens?.wrappedPair || {};
            if (wrappedPair.tokA > 0) {
              uniqueForeignApps.add(wrappedPair.tokA);
              uniqueAccounts.add(algosdk.getApplicationAddress(wrappedPair.tokA));
            }
            if (wrappedPair.tokB > 0) {
              uniqueForeignApps.add(wrappedPair.tokB);
              uniqueAccounts.add(algosdk.getApplicationAddress(wrappedPair.tokB));
            }
          }
        }

        // Log what we've collected
        console.log(`[Resources] Collected: apps=${Array.from(uniqueForeignApps).length}, assets=${Array.from(uniqueForeignAssets).length}, accounts=${Array.from(uniqueAccounts).length}`);

        // Collect all unique foreignApps, foreignAssets, and accounts from simulation
        // Also check group-level unnamedResourcesAccessed
        const groupUnnamed = txnGroup?.unnamedResourcesAccessed || {};
        const groupApps = groupUnnamed.apps || [];
        const groupAssets = groupUnnamed.assets || [];
        const groupAccounts = groupUnnamed.accounts || [];
        
        for (const appId of groupApps) {
          const appIdNum = typeof appId === 'number' ? appId : Number(appId);
          uniqueForeignApps.add(appIdNum);
        }
        
        for (const assetId of groupAssets) {
          const assetIdNum = typeof assetId === 'number' ? assetId : Number(assetId);
          uniqueForeignAssets.add(assetIdNum);
        }
        
        for (const account of groupAccounts) {
          const accountAddr = typeof account === 'string' ? account : algosdk.encodeAddress(account);
          uniqueAccounts.add(accountAddr);
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
          }
          
          for (const assetId of txnAssets) {
            const assetIdNum = typeof assetId === 'number' ? assetId : Number(assetId);
            uniqueForeignAssets.add(assetIdNum);
          }
          
          for (const account of txnAccounts) {
            const accountAddr = typeof account === 'string' ? account : algosdk.encodeAddress(account);
            uniqueAccounts.add(accountAddr);
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
            }
          } catch (error) {
            // Silently skip if lookup fails - not all apps need creator addresses
          }
        }
        
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
        
        // Track overflow boxes that couldn't be added to any transaction
        // These will be handled by creating a resource carrier transaction
        let overflowBoxes = [];

        // Sort boxes by txnIndex to ensure boxes are added to their originating transaction first
        // This is CRITICAL for boxes that are CREATED by one transaction - they MUST be declared
        // on that transaction, not just any transaction in the group (group sharing only works for reads)
        const sortedBoxes = [...allUniqueBoxes].sort((a, b) => {
          // Sort by txnIndex first (earliest transaction first)
          const txnDiff = (a.txnIndex || 0) - (b.txnIndex || 0);
          if (txnDiff !== 0) return txnDiff;
          // Then by appIndex for consistency
          return a.appIndex - b.appIndex;
        });

        // Try to add each box, prioritizing the transaction that originally accessed it
        for (const box of sortedBoxes) {
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

          // Helper function to try adding box to a specific transaction
          const tryAddBoxToTxn = (txn) => {
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

              return true;
            }
            return false;
          };

          let added = false;

          // FIRST: Try to add to the transaction that originally accessed this box (by txnIndex)
          // This is critical for boxes that are CREATED - they must be on the creating transaction
          if (box.txnIndex !== undefined) {
            // Find the app call transaction at or near the txnIndex
            // The txnIndex from simulation refers to the position in the transaction group
            // We need to map this to our appCallTxns array
            const targetTxn = appCallTxns.find(({ idx }) => idx === box.txnIndex);
            if (targetTxn) {
              added = tryAddBoxToTxn(targetTxn.txn);
              if (added) {
                // Log for debugging
                const boxPrefix = Buffer.from(box.name).slice(0, 9).toString('utf8').replace(/[^\x20-\x7E]/g, '?');
                console.log(`[BoxDistribution] Added box (${boxPrefix}...) to txn ${box.txnIndex} (target)`);
              }
            }
          }

          // FALLBACK: If couldn't add to target, try EARLIER transactions first
          // This is important because boxes need to be available BEFORE they're accessed
          // Group resource sharing allows later transactions to access boxes declared in earlier ones
          if (!added) {
            // Sort appCallTxns by index to try earlier transactions first
            const sortedAppCallTxns = [...appCallTxns].sort((a, b) => a.idx - b.idx);

            // Only try transactions at or before the target index
            const targetIdx = box.txnIndex !== undefined ? box.txnIndex : Infinity;
            for (const { txn, idx } of sortedAppCallTxns) {
              if (idx <= targetIdx) {
                added = tryAddBoxToTxn(txn);
                if (added) {
                  const boxPrefix = Buffer.from(box.name).slice(0, 9).toString('utf8').replace(/[^\x20-\x7E]/g, '?');
                  console.log(`[BoxDistribution] Added box (${boxPrefix}...) to txn ${idx} (earlier fallback, wanted ${box.txnIndex})`);
                  break;
                }
              }
            }
          }

          // LAST RESORT: Try any transaction if still not added
          if (!added) {
            for (const { txn, idx } of appCallTxns) {
              added = tryAddBoxToTxn(txn);
              if (added) {
                const boxPrefix = Buffer.from(box.name).slice(0, 9).toString('utf8').replace(/[^\x20-\x7E]/g, '?');
                console.log(`[BoxDistribution] Added box (${boxPrefix}...) to txn ${idx} (last resort fallback, wanted ${box.txnIndex})`);
                break;
              }
            }
          }

          if (!added) {
            const boxPrefix = Buffer.from(box.name).slice(0, 9).toString('utf8').replace(/[^\x20-\x7E]/g, '?');
            console.log(`[BoxDistribution] WARNING: Could not add box (${boxPrefix}...) to any transaction - will create resource carrier`);
            // Track this box as needing a resource carrier transaction
            overflowBoxes.push(box);
          }
        }

        // SAFETY MEASURE: If we have overflow boxes that couldn't be added to any transaction,
        // create a "resource carrier" app call transaction and PREPEND it to the group.
        // This transaction carries the box references so they're available to all subsequent
        // transactions via group resource sharing.
        let resourceCarrierTxn = null;
        if (overflowBoxes.length > 0) {
          console.log(`[ResourceCarrier] Creating resource carrier transaction for ${overflowBoxes.length} overflow box(es)`);

          // Get suggested params for the new transaction
          const suggestedParams = await algodClient.getTransactionParams().do();

          // Find a suitable app to use for the carrier transaction
          // We'll use one of the apps from the overflow boxes
          // Prefer ARC200 token apps as they have predictable methods
          let carrierAppId = overflowBoxes[0].appIndex;

          // Build the carrier transaction as an app call
          // For ARC200 tokens, we use arc200_balanceOf(address) which is a read-only method
          // Method selector for arc200_balanceOf: first 4 bytes of sha256("arc200_balanceOf(address)")
          const arc200BalanceOfSelector = new Uint8Array([0x0e, 0x7f, 0x69, 0x2c]); // arc200_balanceOf selector

          const carrierBoxes = overflowBoxes.map(box => ({
            appIndex: box.appIndex,
            name: box.name
          }));

          // Collect foreign apps needed for the boxes
          const carrierForeignApps = [...new Set(overflowBoxes.map(b => b.appIndex))];

          // Calculate fee: base + box fees
          const carrierFee = 1000 + (carrierBoxes.length * 2500);

          // Create app args: method selector + address argument (sender's address as balance query target)
          // This creates a valid arc200_balanceOf call that will succeed on ARC200 tokens
          const addressArg = algosdk.decodeAddress(address).publicKey;

          resourceCarrierTxn = algosdk.makeApplicationCallTxnFromObject({
            from: address,
            appIndex: carrierAppId,
            onComplete: algosdk.OnApplicationComplete.NoOpOC,
            appArgs: [arc200BalanceOfSelector, addressArg],
            boxes: carrierBoxes,
            foreignApps: carrierForeignApps.filter(id => id !== carrierAppId), // Don't include self
            suggestedParams: {
              ...suggestedParams,
              fee: carrierFee,
              flatFee: true
            },
            note: new Uint8Array(Buffer.from('Resource carrier: arc200_balanceOf for box references'))
          });

          console.log(`[ResourceCarrier] Created carrier txn with ${carrierBoxes.length} boxes, app ${carrierAppId} (arc200_balanceOf)`);

          // PREPEND the resource carrier to the transaction list
          // This ensures all boxes are available to subsequent transactions
          allTransactions.unshift(resourceCarrierTxn);

          // Update appCallTxns to include the new carrier transaction
          // Re-map indices since we prepended a transaction
          appCallTxns.unshift({ txn: resourceCarrierTxn, idx: 0 });
          for (let i = 1; i < appCallTxns.length; i++) {
            appCallTxns[i].idx += 1; // Shift all other indices by 1
          }

          console.log(`[ResourceCarrier] Prepended carrier txn, group now has ${allTransactions.length} transactions`);
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
            }
          }
        }
        
        // Distribute foreignApps: prioritize transactions that need them (from errors), then add to any with room
        for (const appId of allUniqueForeignApps) {
          // Check if already in any transaction (group resource sharing)
          const alreadyInGroup = appCallTxns.some(({ txn }) => txn.foreignApps.includes(appId));
          if (alreadyInGroup) {
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
                added = true;
                break;
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
                added = true;
                break;
              }
            }
          }
        }
        
        // Ensure app 395642 is added to swap transactions (395553) if missing
        for (let i = 0; i < allTransactions.length; i++) {
          const txn = allTransactions[i];
          if (txn.type === 'appl') {
            if (!txn.foreignApps) {
              txn.foreignApps = [];
            }
            if (txn.appIndex === 395553 && !txn.foreignApps.includes(395642)) {
              // Try to add it if we have room
              const currentBoxes = (txn.boxes || []).length;
              const currentForeignApps = txn.foreignApps.length;
              const currentForeignAssets = (txn.foreignAssets || []).length;
              const currentAccounts = (txn.accounts || []).length;
              const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;
              
              if (totalReferences < 8) {
                txn.foreignApps.push(395642);
                uniqueForeignApps.add(395642);
              } else {
                // Try to add it to another transaction in the group (group resource sharing)
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
                      break;
                    }
                  }
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
                break; // Added to one transaction, that's enough for group resource sharing
              }
            }
          }
          
          if (transactionsNeedingAccount.length === 0) {
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

            // Check both total references (8) and accounts limit (4)
            if (totalReferences < 8 && currentAccounts < 4) {
              txn.accounts.push(creatorAccount);
            } else {
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
                // Check both total references (8) and accounts limit (4)
                if (otherTotalReferences < 8 && otherAccounts < 4) {
                  otherTxn.accounts.push(creatorAccount);
                  // Also add the app to foreignApps if not already there (needed for local state access)
                  if (!otherTxn.foreignApps) {
                    otherTxn.foreignApps = [];
                  }
                  if (!otherTxn.foreignApps.includes(appId)) {
                    if (otherTotalReferences + 1 < 8) { // Check if we can add both app and account
                      otherTxn.foreignApps.push(appId);
                    }
                  }
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

            // Check both total references (8) and accounts limit (4)
            if (totalReferences < 8 && currentAccounts < 4) {
              txn.accounts.push(accountAddr);
              added = true;
              break; // Only add to first transaction with room for unknown accounts
            }
          }
        }

        // Final validation: Ensure no transaction exceeds limits
        // - Total references: 8
        // - Accounts: 4
        // If limits exceeded, trim in order: accounts (if >4), then boxes
        for (let i = 0; i < allTransactions.length; i++) {
          const txn = allTransactions[i];
          if (txn.type === 'appl') {
            // First check accounts limit (max 4)
            if (txn.accounts && txn.accounts.length > 4) {
              console.log(`[Warning] Txn ${i} has ${txn.accounts.length} accounts, trimming to 4`);
              txn.accounts = txn.accounts.slice(0, 4);
            }

            const currentBoxes = (txn.boxes || []).length;
            const currentForeignApps = (txn.foreignApps || []).length;
            const currentForeignAssets = (txn.foreignAssets || []).length;
            const currentAccounts = (txn.accounts || []).length;
            const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;

            if (totalReferences > 8) {
              // Trim boxes to stay within limit
              // Keep foreignApps and foreignAssets as they're more critical
              const maxBoxes = Math.max(0, 8 - currentForeignApps - currentForeignAssets - currentAccounts);
              if (txn.boxes && txn.boxes.length > maxBoxes) {
                console.log(`[Warning] Txn ${i} has ${txn.boxes.length} boxes, trimming to ${maxBoxes}`);
                txn.boxes = txn.boxes.slice(0, maxBoxes);
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
          
          // Check if this is a Nomadex transaction (uses dynamically tracked pool IDs)
          // Nomadex pools require factory app 411751 in foreignApps
          const isNomadexTxn = txn.type === 'appl' && nomadexPoolIds.has(txn.appIndex);
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
              }
            }
            
            // Calculate correct fee: base fee (1000) + box fee (2500 per box)
            const boxesCount = txn.boxes?.length || 0;
            const correctFee = 1000 + (boxesCount * 2500);
            
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
                fee: correctFee, // Use calculated fee instead of preserving original
                flatFee: true, // Ensure flat fee is set
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
              // Recalculate fee after boxes are added: base fee (1000) + box fee (2500 per box)
              const finalBoxesCount = boxesToAdd.length;
              const finalFee = 1000 + (finalBoxesCount * 2500);
              rebuiltTxn.fee = finalFee;
              // Also update suggestedParams if it exists
              if (rebuiltTxn.suggestedParams) {
                rebuiltTxn.suggestedParams.fee = finalFee;
                rebuiltTxn.suggestedParams.flatFee = true;
              }
            } else {
              // No boxes, ensure fee is correct (base fee only)
              if (rebuiltTxn.fee !== 1000) {
                rebuiltTxn.fee = 1000;
                if (rebuiltTxn.suggestedParams) {
                  rebuiltTxn.suggestedParams.fee = 1000;
                  rebuiltTxn.suggestedParams.flatFee = true;
                }
              }
            }
            
            // Verify accounts were preserved (makeApplicationCallTxnFromObject should handle them, but verify)
            if (txnObj.accounts && txnObj.accounts.length > 0) {
              // Ensure accounts are set on the rebuilt transaction
              if (!rebuiltTxn.accounts || rebuiltTxn.accounts.length !== txnObj.accounts.length) {
                rebuiltTxn.accounts = txnObj.accounts;
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
      }
    } catch (error) {
      // If simulation fails, continue - transactions might still work
      // The existing box construction logic should still work for ARC200 tokens
    }
  }
  
  // Calculate total fees
  let totalFees = 0;
  for (let i = 0; i < allTransactions.length; i++) {
    const txn = allTransactions[i];
    // Calculate total fees
    const fee = txn.fee !== undefined ? txn.fee : (txn.suggestedParams?.fee || 0);
    totalFees += fee;
    
    // Include payment transaction amounts in total fees
    // Payment transactions (like 28500 for wVOI approval, 28501 for balance box creation)
    // are part of the cost to the user and should be included in networkFee
    // However, we should NOT include payment transactions that represent the actual swap amount
    // (e.g., when swapping FROM native VOI, the payment transaction with the swap amount)
    if (txn.type === 'pay' && txn.amount !== undefined) {
      const paymentAmount = BigInt(txn.amount);
      
      // Get recipient address if available
      let recipientAddress = null;
      if (txn.to) {
        if (typeof txn.to === 'string') {
          recipientAddress = txn.to;
        } else if (txn.to.publicKey) {
          recipientAddress = algosdk.encodeAddress(txn.to.publicKey);
        } else if (txn.to instanceof Uint8Array) {
          recipientAddress = algosdk.encodeAddress(txn.to);
        }
      }
      
      // Check if this payment transaction is a swap amount (not a fee)
      // A payment is a swap amount if:
      // 1. The amount matches a tracked swap amount, AND
      // 2. The recipient is a tracked swap recipient address (pool or wrapped token contract)
      const isSwapAmount = recipientAddress && 
                           swapAmountsToExclude.has(paymentAmount) && 
                           swapRecipientAddresses.has(recipientAddress);
      
      // Only include payment transactions that are NOT swap amounts (i.e., they are fees)
      if (!isSwapAmount) {
        totalFees += Number(paymentAmount);
      }
    }
  }
  
  // Encode all transactions back to base64
  const encodedTransactions = allTransactions.map(txn => 
    Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64')
  );
  
  // Return both transactions and total network fees
  return {
    transactions: encodedTransactions,
    networkFee: totalFees
  };
}

/**
 * Get a summary string for an algosdk.Transaction
 */
function getTransactionSummary(txn, index) {
  // Get fee from transaction (try txn.fee first, then suggestedParams.fee as fallback)
  const fee = txn.fee !== undefined ? txn.fee : (txn.suggestedParams?.fee || 0);
  const feeStr = `, Fee: ${fee} microAlgos`;
  
  if (txn.type === 'pay') {
    const from = algosdk.encodeAddress(txn.from.publicKey);
    const to = algosdk.encodeAddress(txn.to.publicKey);
    return `Payment: ${from.substring(0, 8)}... -> ${to.substring(0, 8)}..., Amount: ${txn.amount} microAlgos${feeStr}`;
  } else if (txn.type === 'axfer') {
    const from = algosdk.encodeAddress(txn.from.publicKey);
    const to = algosdk.encodeAddress(txn.to.publicKey);
    return `Asset Transfer: ${from.substring(0, 8)}... -> ${to.substring(0, 8)}..., Asset: ${txn.assetIndex}, Amount: ${txn.amount}${feeStr}`;
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
    return summary + feeStr;
  }
  return `Transaction ${index}: ${txn.type || 'unknown'}${feeStr}`;
}

export { buildSwapTransactions, buildBatchUnwrapTransactions };

