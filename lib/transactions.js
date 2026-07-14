import algosdk from 'algosdk';
import {
  buildSwapTransactions as buildNomadexSwapTransactions,
  getTokenTypeFromConfig
} from './nomadex.js';
import {
  resolveWrappedTokens,
  calculateOutputAmount as calculateHumbleswapOutput
} from './humbleswap.js';
import {
  buildSwapTransactions as buildHumbleswapSwapTransactionsArccjs
} from './humbleswap-arccjs.js';
import { getTokenDecimals } from './utils.js';
import { getTokenMetaFromConfig, getUnderlyingForWrapped } from './config.js';
import { algodClient, indexerClient } from './clients.js';

// Debug flag for verbose logging
// Set via environment variable: DEBUG=1 or DEBUG=true
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

// Process-lifetime cache of app creator addresses. An application's creator is
// immutable, so once resolved it is safe to reuse for the life of the process.
// Keyed by the string form of the app id (String(123) === String(123n), so a
// Number and BigInt for the same app share one entry with no precision loss and
// no cross-key collisions - even for uint64 ids beyond Number.MAX_SAFE_INTEGER).
// Only successful lookups are cached; a failed/absent lookup returns null WITHOUT
// caching so it can retry.
const appCreatorCache = new Map();

async function getAppCreatorAddress(appId) {
  const key = String(appId);
  if (appCreatorCache.has(key)) {
    return appCreatorCache.get(key);
  }
  try {
    const appInfo = await indexerClient.lookupApplications(appId).do();
    if (appInfo.application && appInfo.application.params && appInfo.application.params.creator) {
      // algosdk 3.x indexer responses can decode `creator` as an Address object
      // rather than a base32 string - normalize to a string so downstream
      // Address.fromString(creator) calls don't throw "expected string, got object".
      const rawCreator = appInfo.application.params.creator;
      const creatorAddr = typeof rawCreator === 'string' ? rawCreator : rawCreator.toString();
      appCreatorCache.set(key, creatorAddr);
      return creatorAddr;
    }
    return null;
  } catch (error) {
    // Silently skip if lookup fails - not all apps need creator addresses.
    // Do not cache the failure so a transient error can be retried later.
    return null;
  }
}

/**
 * The on-chain enforced minimum output (minAmountOut) for a split.
 *
 * This is the SINGLE source of every swap's enforced minimum, and it MUST equal
 * the split's reported (GROSS) `minOutput` with NO extra buffer. Under Option C
 * `minOutput` is the gross slippage min M_i (NOT fee-reduced); the platform fee
 * is taken separately as one aggregate transfer of `platformFee.feeAmount` (F).
 * So the worst-case ENFORCED NET floor the user can end up with is
 * `Σ split.minOutput − platformFee.feeAmount` (== the reported minimumOutputAmount
 * from lib/handlers.js). A prior bug applied a 0.99 haircut here, so the user
 * could receive ~1% below the reported floor undisclosed (TASK-6). Slippage is
 * already baked into `minOutput` upstream, so this must be a pure pass-through.
 * Kept as a named boundary (rather than an inline `BigInt(minOutput).toString()`
 * at each call site) so a regression that reintroduces a haircut is caught by a
 * unit test.
 * @param {BigInt|string|number} minOutput - the split's reported minimum output
 * @returns {string} minAmountOut as a base-10 string, unbuffered
 */
function enforcedMinAmountOut(minOutput) {
  return BigInt(minOutput).toString();
}

// Tag a thrown Error as client-caused (bad input), not an internal/upstream
// failure. lib/handlers.js's /unwrap error handling trusts this explicit
// flag - rather than guessing from the message TEXT via substring matching -
// to decide whether to echo the message verbatim (400) or genericize it with
// an errorId (500) to the caller. A text-based heuristic (e.g. matching the
// substring "invalid") would also match inside a genuine internal/algod
// error message (like "invalid Box reference" from a simulation failure),
// wrongly treating it as safe to echo (TASK-27).
function clientError(message) {
  const err = new Error(message);
  err.isClientError = true;
  return err;
}

/**
 * Log a summary of resource distribution across transactions
 * Useful for debugging resource limit issues
 * @param {string} label - Label for the summary (e.g., 'Pre-Distribution', 'Verification Failed')
 * @param {Array} transactions - Array of transactions to analyze
 */
function logResourceSummary(label, transactions) {
  if (!DEBUG) return;
  console.log(`\n[${label}] Resource Distribution Summary:`);
  let totalSlots = 0, usedSlots = 0;
  for (let i = 0; i < transactions.length; i++) {
    const txn = transactions[i];
    if (txn.type === 'appl') {
      const appCall = txn.applicationCall || txn;
      const apps = (appCall.foreignApps || []).length;
      const assets = (appCall.foreignAssets || []).length;
      const accounts = (appCall.accounts || []).length;
      const boxes = (appCall.boxes || []).length;
      const total = apps + assets + accounts + boxes;
      const status = total > 8 ? 'OVER' : total === 8 ? 'FULL' : `${8 - total} free`;
      console.log(`  Txn ${i} (app ${appCall.appIndex}): apps=${apps} assets=${assets} accts=${accounts} boxes=${boxes} => ${total}/8 [${status}]`);
      totalSlots += 8;
      usedSlots += total;
    }
  }
  console.log(`  Total: ${usedSlots}/${totalSlots} slots used\n`);
}

const ARC200_BALANCES_PREFIX = Buffer.from('balances', 'utf-8');
const ARC200_WITHDRAW_METHOD = new algosdk.ABIMethod({
  name: 'withdraw',
  args: [{ type: 'uint64' }],
  returns: { type: 'uint256' }
});
const UINT64_MAX = (1n << 64n) - 1n;

// Algorand/Voi transaction groups are capped at 16 transactions, and each
// unwrap item becomes exactly one application call transaction (see
// buildBatchUnwrapTransactions below) — so 16 items is the most that can
// ever fit in one group. Exported so route-level validation (index.js) can
// fail fast on the same authoritative limit instead of duplicating (and
// risking drifting from) this number.
const MAX_UNWRAP_GROUP_SIZE = 16;

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
 * Determine the token type for HumbleSwap transactions
 * @param {string|number} tokenId - The token ID being used in the route
 * @param {number} wrappedId - The wrapped token ID resolved for the pool
 * @returns {string} Token type: "native", "ASA", or "ARC200"
 */
function determineTokenTypeForHumbleswap(tokenId, wrappedId) {
  const tokenNum = Number(tokenId);
  const wrappedNum = Number(wrappedId);

  // Native VOI
  if (tokenNum === 0) {
    return 'native';
  }

  // If tokenId equals wrappedId, it's already ARC200 (pure ARC200)
  // This happens when the route uses an ARC200 token directly (e.g., from Nomadex output)
  if (tokenNum === wrappedNum) {
    return 'ARC200';
  }

  // Otherwise, tokenId is the underlying ASA and wrappedId is different
  // This means it's an ASA that wraps to ARC200
  return 'ASA';
}

/**
 * Build ASA opt-in transaction
 * @param {string} address - Account address
 * @param {number} assetId - ASA ID to opt into
 * @returns {Promise<algosdk.Transaction>} Opt-in transaction
 */
async function buildAssetOptInTransaction(address, assetId, suggestedParams = null) {
  // Reuse caller-supplied request-scoped params when provided (params are stable
  // within a request); only fetch when called standalone without them.
  const params = suggestedParams || await algodClient.getTransactionParams().do();

  // ASA opt-in is a 0-amount asset transfer to self
  return algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    amount: 0,
    assetIndex: assetId,
    suggestedParams: params
  });
}

/**
 * Build a simulate request
 * @param {Array<algosdk.Transaction>} transactions - Transactions to simulate
 * @param {Algodv2} algodClient - Algod client
 * @param {boolean} allowUnnamedResources - If false, simulation will fail on missing resources (useful for discovery)
 * @returns {Promise<Object>} Simulate request object
 */
/**
 * Simulate transactions using AtomicTransactionComposer (algosdk 3.x compatible)
 * @param {Array<algosdk.Transaction>} transactions - Transactions to simulate
 * @param {Algodv2} algodClient - Algod client
 * @param {boolean} allowUnnamedResources - Whether to allow unnamed resources discovery
 * @param {boolean} fixSigners - Whether to fix signers for rekeyed accounts
 * @returns {Promise<Object>} Simulation response
 */
async function simulateWithATC(transactions, algodClient, allowUnnamedResources = true, fixSigners = true) {
  const atc = new algosdk.AtomicTransactionComposer();

  // Add all transactions to the composer with empty signer
  // ATC requires transactions to have no group ID - it will assign its own
  for (const txn of transactions) {
    // Clone the transaction and clear group ID if present
    // We need to clear it because ATC.addTransaction() rejects txns with group IDs
    const txnCopy = algosdk.decodeUnsignedTransaction(algosdk.encodeUnsignedTransaction(txn));
    txnCopy.group = undefined;

    atc.addTransaction({
      txn: txnCopy,
      signer: algosdk.makeEmptyTransactionSigner()
    });
  }

  // Create simulate request
  const simulateRequest = new algosdk.modelsv2.SimulateRequest({
    allowUnnamedResources: allowUnnamedResources,
    allowEmptySignatures: true,
    fixSigners: fixSigners
  });

  // Execute simulation via ATC
  const result = await atc.simulate(algodClient, simulateRequest);
  return result.simulateResponse;
}

/**
 * Simulate a chunk of transactions (helper for chunked simulation)
 * @param {Array<algosdk.Transaction>} chunkTransactions - Transactions in this chunk
 * @param {Algodv2} algodClient - Algod client
 * @returns {Promise<Object>} Simulation results with unnamedResourcesAccessed
 */
async function simulateTransactionChunk(chunkTransactions, algodClient) {
  return await simulateWithATC(chunkTransactions, algodClient, true, true);
}

/**
 * Simulate an atomic transaction group using AtomicTransactionComposer (algosdk 3.x)
 * with allowUnnamedResources enabled to discover boxes, apps, assets, and accounts
 * If the group is too large (413 error), splits into chunks and simulates separately
 * @param {Array<algosdk.Transaction>} transactions - Array of transactions to simulate
 * @param {Algodv2} algodClient - Algod client
 * @returns {Promise<Object>} Simulation results with unnamedResourcesAccessed
 */
async function simulateTransactionGroup(transactions, algodClient) {
  try {
    // Try to execute simulation for the full group using ATC
    let simulateResponse;
    try {
      simulateResponse = await simulateWithATC(transactions, algodClient, true, true);
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
async function buildSingleUnwrapTxn({ address, wrappedTokenId, amount, suggestedParams: suggestedParamsIn = null }) {
  const wrappedNum = Number(wrappedTokenId);
  if (!Number.isFinite(wrappedNum) || wrappedNum <= 0) {
    throw clientError(`Invalid wrappedTokenId provided: ${wrappedTokenId}`);
  }
  // BigInt() throws a native, unlabeled SyntaxError/TypeError for a
  // non-numeric/malformed `amount` (e.g. "abc") - a client input mistake,
  // not an internal failure, so it's re-thrown as a tagged clientError with
  // the same descriptive text the range check below already uses, rather
  // than propagating uncaught and being genericized as a 500.
  let amountBigInt;
  try {
    amountBigInt = BigInt(amount);
  } catch {
    throw clientError(`Invalid amount for ${wrappedTokenId}: ${amount}`);
  }
  if (amountBigInt <= 0n || amountBigInt > UINT64_MAX) {
    throw clientError(`Invalid amount for ${wrappedTokenId}: ${amount}`);
  }

  const unwrapInfo = getUnderlyingForWrapped(wrappedNum);
  if (!unwrapInfo || !unwrapInfo.unwrapSupported || unwrapInfo.underlyingId == null) {
    throw clientError(`Wrapped token ${wrappedTokenId} is not recognized as unwrap-capable`);
  }
  const underlyingIdNum = Number(unwrapInfo.underlyingId);
  const inferredUnderlyingType = unwrapInfo.underlyingType || (underlyingIdNum === 0 ? 'native' : 'ASA');
  if (inferredUnderlyingType !== 'native' && inferredUnderlyingType !== 'ASA') {
    throw clientError(`Wrapped token ${wrappedTokenId} does not map to a supported underlying token type`);
  }

  // Reuse caller-supplied request-scoped params when provided (params are stable
  // within a request); only fetch when called standalone without them.
  const suggestedParamsRaw = suggestedParamsIn || await algodClient.getTransactionParams().do();
  const baseFee = Number(suggestedParamsRaw.minFee || 1000);
  // ARC200 withdraw creates an inner transaction to transfer the underlying token
  // Fee needs to cover: base fee (1000) + inner txn fee (1000) + box fees (added later after simulation)
  const initialFee = baseFee + 1000; // Base + inner txn
  const suggestedParams = { ...suggestedParamsRaw, flatFee: true, fee: initialFee };

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
    sender: address,
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
 * @returns {Promise<{transactions: string[], networkFee: number, simulationError: string|null}>}
 */
async function buildBatchUnwrapTransactions({ address, items }) {
  if (!address) {
    throw clientError('Address is required to build unwrap transactions');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw clientError('items array is required and must be non-empty');
  }
  // Validate up front (using the module-level MAX_UNWRAP_GROUP_SIZE above)
  // rather than letting group assignment/simulation fail obscurely deep
  // inside resource discovery.
  if (items.length > MAX_UNWRAP_GROUP_SIZE) {
    throw clientError(`Too many items: ${items.length} exceeds the maximum transaction group size of ${MAX_UNWRAP_GROUP_SIZE}`);
  }

  // Suggested transaction params are stable within a single request, so fetch
  // them at most once and reuse across every transaction we build here (the
  // per-item build loop and the post-simulation rebuild loop would otherwise
  // call getTransactionParams() once per transaction). Call sites spread this
  // object into a fresh suggestedParams to override fee/rounds; none mutate it
  // in place, so sharing keeps the whole group on one valid-round window.
  let _cachedSuggestedParams = null;
  const getSuggestedParams = async () => {
    if (!_cachedSuggestedParams) {
      _cachedSuggestedParams = await algodClient.getTransactionParams().do();
    }
    return _cachedSuggestedParams;
  };

  // Build individual txns
  const txns = [];
  for (const item of items) {
    if (!item || item.wrappedTokenId === undefined || item.amount === undefined) {
      throw clientError('Each item must include wrappedTokenId and amount');
    }
    const txn = await buildSingleUnwrapTxn({
      address,
      wrappedTokenId: item.wrappedTokenId,
      amount: item.amount,
      suggestedParams: await getSuggestedParams()
    });
    txns.push(txn);
  }

  // Assign group id to all
  algosdk.assignGroupID(txns);

  // Track simulation error message to return to the caller (mirrors buildSwapTransactions)
  let simulationErrorMessage = null;

  // Simulate the transaction group to discover box references, foreign apps, and foreign assets
  // This follows the same pattern as buildSwapTransactions
  try {
    const simulationResult = await simulateTransactionGroup(txns, algodClient);

    // A failed simulate CALL (algod timeout/5xx/429, or the 413-chunked fallback path
    // exhausting with chunk errors) returns { success: false } with no simulateResponse and no
    // usable box/app/asset references. Continuing would silently return unwrap transaction(s)
    // that never had their required boxes discovered - an ARC200 withdraw missing its box refs
    // simply reverts on submission. Prefer failing the request over returning a known-incomplete
    // group.
    if (simulationResult?.success === false) {
      throw new Error(simulationResult.error || 'Simulation failed while discovering required resources for unwrap');
    }
    if (simulationResult?.error) {
      // Non-fatal: simulation still ran and yielded usable resources (see the success check
      // above), but flagged errors along the way - surface this honestly to the caller.
      simulationErrorMessage = simulationResult.error;
    }

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
      // Track which transactions access each box (for group resource sharing)
      if (simulationResult.boxReferences && simulationResult.boxReferences.length > 0) {
        for (const boxRef of simulationResult.boxReferences) {
          const appIndex = typeof boxRef.appIndex === 'number' ? boxRef.appIndex : Number(boxRef.appIndex);
          const name = boxRef.name instanceof Uint8Array
            ? boxRef.name
            : new Uint8Array(boxRef.name);
          const boxNameHex = Buffer.from(name).toString('hex');
          const key = `${appIndex}:${boxNameHex}`;
          const txnIndex = boxRef.txnIndex;

          if (!uniqueBoxes.has(key)) {
            uniqueBoxes.set(key, { appIndex, name, accessingTxns: new Set([txnIndex]) });
            uniqueForeignApps.add(appIndex); // Box app must be in foreignApps
          } else {
            // Box already exists, add this txnIndex to the set of accessing transactions
            uniqueBoxes.get(key).accessingTxns.add(txnIndex);
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
        const accountAddr = typeof account === 'string' ? account : new algosdk.Address(account).toString();
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
          const accountAddr = typeof account === 'string' ? account : new algosdk.Address(account).toString();
          uniqueAccounts.add(accountAddr);
        }
      }
      
      // Also collect foreignApps and foreignAssets that are already in transactions
      // In algosdk 3.x, these are under txn.applicationCall, not directly on txn
      for (let i = 0; i < txns.length; i++) {
        const txn = txns[i];
        if (txn.type === 'appl') {
          const appCall = txn.applicationCall || txn;
          const txnForeignApps = appCall.foreignApps || [];
          const txnForeignAssets = appCall.foreignAssets || [];
          // DEBUG: Log what we're finding
          if (DEBUG) console.log(`[CollectResources] Txn ${i} (app ${appCall.appIndex}): foreignApps=${txnForeignApps.map(a => Number(a))}`);
          if (txnForeignApps.length > 0) {
            for (const appId of txnForeignApps) {
              const appIdNum = typeof appId === 'number' ? appId : Number(appId);
              uniqueForeignApps.add(appIdNum);
            }
          }
          if (txnForeignAssets.length > 0) {
            for (const assetId of txnForeignAssets) {
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
      // In algosdk 3.x, resources are under txn.applicationCall
      for (const txn of txns) {
        if (txn.type === 'appl') {
          const appCall = txn.applicationCall || txn;
          if (!appCall.boxes) appCall.boxes = [];
          if (!appCall.foreignApps) appCall.foreignApps = [];
          if (!appCall.foreignAssets) appCall.foreignAssets = [];
          if (!appCall.accounts) appCall.accounts = [];
        }
      }

      // Pre-distribution budget check: Calculate if there's theoretically enough room
      let availableSlots = 0;
      let availableAccountSlots = 0;
      for (const txn of txns) {
        if (txn.type === 'appl') {
          const appCall = txn.applicationCall || txn;
          const used = (appCall.boxes || []).length + (appCall.foreignApps || []).length +
                       (appCall.foreignAssets || []).length + (appCall.accounts || []).length;
          availableSlots += (8 - used);
          availableAccountSlots += (4 - (appCall.accounts || []).length);
        }
      }
      const totalNeeded = allUniqueBoxes.length + allUniqueForeignApps.size +
                          allUniqueForeignAssets.size + allUniqueAccounts.size;
      if (DEBUG) {
        if (DEBUG) console.log(`[Distribution] Pre-check: need ${totalNeeded} slots, have ${availableSlots} available (${allUniqueBoxes.length} boxes, ${allUniqueForeignApps.size} apps, ${allUniqueForeignAssets.size} assets, ${allUniqueAccounts.size} accounts)`);
      }
      if (totalNeeded > availableSlots) {
        console.warn(`[Distribution] WARNING: Need ${totalNeeded} resource slots but only ${availableSlots} available across ${txns.filter(t => t.type === 'appl').length} app txns`);
      }

      // Distribute boxes across transactions
      // In algosdk 3.x, boxes are under txn.applicationCall
      for (const box of allUniqueBoxes) {
        const boxNameHex = Buffer.from(box.name).toString('hex');
        const alreadyInGroup = txns.some(txn => {
          if (txn.type !== 'appl') return false;
          const appCall = txn.applicationCall || txn;
          const boxes = appCall.boxes || [];
          return boxes.some(b => {
            const bAppIndex = typeof b.appIndex === 'number' ? b.appIndex : Number(b.appIndex);
            const bNameHex = Buffer.from(b.name).toString('hex');
            return bAppIndex === box.appIndex && bNameHex === boxNameHex;
          });
        });
        if (alreadyInGroup) {
          continue; // Already accessible to all transactions via group sharing
        }

        let added = false;
        for (const txn of txns) {
          if (txn.type !== 'appl') continue;
          const appCall = txn.applicationCall || txn;

          const currentBoxes = (appCall.boxes || []).length;
          const currentForeignApps = (appCall.foreignApps || []).length;
          const currentForeignAssets = (appCall.foreignAssets || []).length;
          const currentAccounts = (appCall.accounts || []).length;
          const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;

          const boxAppIdBigInt = BigInt(box.appIndex);
          const needsForeignApp = !(appCall.foreignApps || []).some(a => BigInt(a) === boxAppIdBigInt);
          const additionalReferences = 1 + (needsForeignApp ? 1 : 0);

          if (totalReferences + additionalReferences <= 8) {
            appCall.boxes.push({
              appIndex: boxAppIdBigInt,
              name: box.name
            });

            if (needsForeignApp) {
              appCall.foreignApps.push(boxAppIdBigInt);
            }

            // CRITICAL: All transactions that access this box need the box's app in their foreignApps
            // for group resource sharing to work
            if (box.accessingTxns && box.accessingTxns.size > 0) {
              for (const accessingTxnIndex of box.accessingTxns) {
                if (accessingTxnIndex === undefined) continue;
                const accessingTxn = txns[accessingTxnIndex];
                if (accessingTxn && accessingTxn.type === 'appl') {
                  const accessingAppCall = accessingTxn.applicationCall || accessingTxn;
                  if (!accessingAppCall.foreignApps) accessingAppCall.foreignApps = [];
                  const boxAppIdBigInt = BigInt(box.appIndex);
                  const alreadyHasForeignApp = accessingAppCall.foreignApps.some(a => BigInt(a) === boxAppIdBigInt);
                  if (!alreadyHasForeignApp) {
                    accessingAppCall.foreignApps.push(boxAppIdBigInt);
                  }
                }
              }
            }

            added = true;
            break;
          }
        }
        if (!added) {
          console.warn(`[Distribution] Could not distribute box (app=${box.appIndex}) - no transaction has room`);
        }
      }

      // Distribute foreignApps across transactions
      // In algosdk 3.x, foreignApps are under txn.applicationCall
      for (const appId of allUniqueForeignApps) {
        const appIdBigInt = BigInt(appId);
        const alreadyInGroup = txns.some(txn => {
          if (txn.type !== 'appl') return false;
          const appCall = txn.applicationCall || txn;
          return (appCall.foreignApps || []).some(a => BigInt(a) === appIdBigInt);
        });
        if (alreadyInGroup) {
          continue; // Already accessible to all transactions via group sharing
        }

        let added = false;
        for (const txn of txns) {
          if (txn.type !== 'appl') continue;
          const appCall = txn.applicationCall || txn;

          const currentBoxes = (appCall.boxes || []).length;
          const currentForeignApps = (appCall.foreignApps || []).length;
          const currentForeignAssets = (appCall.foreignAssets || []).length;
          const currentAccounts = (appCall.accounts || []).length;
          const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;

          if (totalReferences < 8) {
            appCall.foreignApps.push(appIdBigInt);
            added = true;
            break;
          }
        }
        if (!added) {
          console.warn(`[Distribution] Could not distribute foreignApp ${appId} - no transaction has room`);
        }
      }

      // Distribute foreignAssets across transactions
      // In algosdk 3.x, foreignAssets are under txn.applicationCall
      for (const assetId of allUniqueForeignAssets) {
        const assetIdBigInt = BigInt(assetId);
        const alreadyInGroup = txns.some(txn => {
          if (txn.type !== 'appl') return false;
          const appCall = txn.applicationCall || txn;
          return (appCall.foreignAssets || []).some(a => BigInt(a) === assetIdBigInt);
        });
        if (alreadyInGroup) {
          continue; // Already accessible to all transactions via group sharing
        }

        let added = false;
        for (const txn of txns) {
          if (txn.type !== 'appl') continue;
          const appCall = txn.applicationCall || txn;

          const currentBoxes = (appCall.boxes || []).length;
          const currentForeignApps = (appCall.foreignApps || []).length;
          const currentForeignAssets = (appCall.foreignAssets || []).length;
          const currentAccounts = (appCall.accounts || []).length;
          const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;

          if (totalReferences < 8) {
            appCall.foreignAssets.push(assetIdBigInt);
            added = true;
            break;
          }
        }
        if (!added) {
          console.warn(`[Distribution] Could not distribute foreignAsset ${assetId} - no transaction has room`);
        }
      }

      // Distribute accounts across transactions (for local state access)
      // Map apps to their creator accounts if needed
      const appToCreatorAccount = new Map();
      for (const appId of allUniqueForeignApps) {
        const creatorAddr = await getAppCreatorAddress(appId);
        if (creatorAddr) {
          appToCreatorAccount.set(appId, creatorAddr);
          uniqueAccounts.add(creatorAddr);
        }
      }

      for (const accountAddr of allUniqueAccounts) {
        const alreadyInGroup = txns.some(txn => {
          if (txn.type !== 'appl') return false;
          const appCall = txn.applicationCall || txn;
          const accounts = appCall.accounts || [];
          return accounts.some(acc => {
            const accStr = typeof acc === 'string' ? acc : acc.toString();
            return accStr === accountAddr;
          });
        });
        if (alreadyInGroup) {
          continue; // Already accessible to all transactions via group sharing
        }

        // Find transactions that need this account (transactions with apps that have this creator)
        const transactionsNeedingAccount = [];
        for (let i = 0; i < txns.length; i++) {
          const txn = txns[i];
          if (txn.type !== 'appl') continue;
          const appCall = txn.applicationCall || txn;

          // Check if this transaction has any app that needs this account
          const foreignApps = appCall.foreignApps || [];
          const needsAccount = foreignApps.some(appId => {
            const creatorAccount = appToCreatorAccount.get(Number(appId));
            return creatorAccount === accountAddr;
          });

          if (needsAccount) {
            transactionsNeedingAccount.push({ txn, appCall, idx: i });
          }
        }

        // If no transactions need it but it's in uniqueAccounts, add to first transaction with room
        let accountAdded = false;
        if (transactionsNeedingAccount.length === 0) {
          for (const txn of txns) {
            if (txn.type !== 'appl') continue;
            const appCall = txn.applicationCall || txn;

            const currentBoxes = (appCall.boxes || []).length;
            const currentForeignApps = (appCall.foreignApps || []).length;
            const currentForeignAssets = (appCall.foreignAssets || []).length;
            const currentAccounts = (appCall.accounts || []).length;
            const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;

            // Check both total references (8) and accounts limit (4)
            if (totalReferences < 8 && currentAccounts < 4) {
              if (!appCall.accounts) appCall.accounts = [];
              appCall.accounts.push(algosdk.Address.fromString(accountAddr));
              accountAdded = true;
              break;
            }
          }
        } else {
          // Add to transactions that need it
          for (const { appCall } of transactionsNeedingAccount) {
            if (!appCall.accounts) appCall.accounts = [];

            const alreadyInTxn = appCall.accounts.some(acc => {
              const accStr = typeof acc === 'string' ? acc : acc.toString();
              return accStr === accountAddr;
            });
            if (!alreadyInTxn) {
              const currentBoxes = (appCall.boxes || []).length;
              const currentForeignApps = (appCall.foreignApps || []).length;
              const currentForeignAssets = (appCall.foreignAssets || []).length;
              const currentAccounts = appCall.accounts.length;
              const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;

              // Check both total references (8) and accounts limit (4)
              if (totalReferences < 8 && currentAccounts < 4) {
                appCall.accounts.push(algosdk.Address.fromString(accountAddr));
                accountAdded = true;
              }
            } else {
              accountAdded = true; // Already in this txn
            }
          }
        }
        if (!accountAdded) {
          console.warn(`[Distribution] Could not distribute account ${accountAddr.substring(0, 8)}... - no transaction has room (ref limit 8 or account limit 4)`);
        }
      }
    }
  } catch (error) {
    // This block performs the discovery of box/foreignApp/foreignAsset/account references
    // needed for the ARC200 withdraw call(s). Any exception here means those references were
    // NOT fully discovered - silently continuing would return unwrap transactions that look
    // valid but are missing required references, which simply revert on submission. Log loudly
    // and fail the request instead of returning a known-incomplete group.
    console.error(`[buildBatchUnwrapTransactions] Resource discovery failed: ${error.message}\n${error.stack}`);
    simulationErrorMessage = simulationErrorMessage || error.message || 'Resource discovery failed';
    throw new Error(`Failed to build unwrap transactions: resource discovery failed (${error.message})`);
  }

  // Recalculate fees based on actual boxes/resources discovered
  // Base fee: 1000 microAlgos per transaction
  // Box fee: 2500 microAlgos per box reference
  // Inner transaction fee: 1000 microAlgos (ARC200 withdraw creates an inner transaction to transfer underlying token)
  for (const txn of txns) {
    if (txn.type === 'appl') {
      const appCall = txn.applicationCall || txn;
      const baseFee = 1000;
      const boxFee = (appCall.boxes?.length || 0) * 2500;
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

  // CRITICAL: Rebuild ALL app call transactions to ensure resources are properly encoded (algosdk 3.x)
  // Simply setting properties on txn.applicationCall does NOT persist when encoding
  // We must rebuild each transaction using makeApplicationCallTxnFromObject and then
  // manually set the resources on applicationCall
  for (let i = 0; i < txns.length; i++) {
    const txn = txns[i];
    if (txn.type !== 'appl') continue;

    const appCall = txn.applicationCall || txn;
    const appCallBoxes = appCall.boxes || [];
    const appCallAccounts = appCall.accounts || [];
    const appCallForeignApps = appCall.foreignApps || [];
    const appCallForeignAssets = appCall.foreignAssets || [];

    if (DEBUG) {
      if (DEBUG) console.log(`[Rebuild] Txn ${i} (app ${appCall.appIndex}): rebuilding with ${appCallBoxes.length} boxes, ${appCallForeignApps.length} foreignApps, ${appCallForeignAssets.length} foreignAssets, ${appCallAccounts.length} accounts`);
    }

    // Rebuild the transaction to ensure resources are properly encoded
    const fromAddress = txn.sender.toString();
    const suggestedParams = await getSuggestedParams();

    // Calculate correct fee: base fee (1000) + box fee (2500 per box) + inner txn fee (1000)
    const boxesCount = appCallBoxes.length;
    const correctFee = 1000 + (boxesCount * 2500) + 1000;

    const txnObj = {
      sender: fromAddress,
      appIndex: appCall.appIndex,
      onComplete: appCall.onComplete,
      appArgs: appCall.appArgs,
      foreignApps: appCallForeignApps,
      foreignAssets: appCallForeignAssets,
      suggestedParams: {
        ...suggestedParams,
        fee: correctFee,
        flatFee: true
      }
    };

    // Include optional fields - get accounts from applicationCall
    if (appCallAccounts.length > 0) {
      txnObj.accounts = appCallAccounts.map(acc => {
        // Handle both string addresses and objects with publicKey
        if (typeof acc === 'string') {
          return acc;
        } else if (acc && acc.publicKey) {
          return acc.toString();
        } else if (acc instanceof Uint8Array) {
          return new algosdk.Address(acc).toString();
        } else if (acc && acc.toString) {
          return acc.toString();
        } else {
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
      txnObj.rekeyTo = txn.rekeyTo.toString();
    }

    // Remove boxes from txnObj temporarily - we'll set them manually on applicationCall
    // (makeApplicationCallTxnFromObject may not handle boxes correctly in algosdk 3.x)
    const boxesToAdd = appCallBoxes;

    // Ensure all box app IDs are in foreignApps (if boxes exist)
    if (boxesToAdd && boxesToAdd.length > 0) {
      if (!txnObj.foreignApps) {
        txnObj.foreignApps = [];
      }
      // Add box app IDs to foreignApps if not already present
      for (const box of boxesToAdd) {
        const boxAppId = typeof box.appIndex === 'number' ? box.appIndex : Number(box.appIndex);
        if (!txnObj.foreignApps.some(a => Number(a) === boxAppId)) {
          txnObj.foreignApps.push(boxAppId);
        }
      }
    }

    const rebuiltTxn = algosdk.makeApplicationCallTxnFromObject(txnObj);
    // In algosdk 3.x, boxes/accounts/foreignApps are under applicationCall
    const rebuiltAppCall = rebuiltTxn.applicationCall || rebuiltTxn;

    // CRITICAL: Set foreignApps on applicationCall (makeApplicationCallTxnFromObject may not do this correctly in algosdk 3.x)
    // Use txnObj.foreignApps which includes the box app IDs that were added
    if (txnObj.foreignApps && txnObj.foreignApps.length > 0) {
      rebuiltAppCall.foreignApps = txnObj.foreignApps.map(a => BigInt(a));
    }

    // Set foreignAssets on applicationCall
    if (txnObj.foreignAssets && txnObj.foreignAssets.length > 0) {
      rebuiltAppCall.foreignAssets = txnObj.foreignAssets.map(a => BigInt(a));
    }

    // Set accounts on applicationCall
    if (appCallAccounts && appCallAccounts.length > 0) {
      rebuiltAppCall.accounts = appCallAccounts.map(acc => {
        if (typeof acc === 'string') return algosdk.Address.fromString(acc);
        if (acc && acc.publicKey) return acc;
        if (acc instanceof Uint8Array) return new algosdk.Address(acc);
        if (acc && acc.toString) return algosdk.Address.fromString(acc.toString());
        return acc;
      });
    }

    // CRITICAL: Manually set boxes on applicationCall after creation
    if (boxesToAdd && boxesToAdd.length > 0) {
      // Verify boxes one more time before setting
      const verifiedBoxes = boxesToAdd.filter(box => {
        const appIdx = typeof box.appIndex === 'number' ? box.appIndex : Number(box.appIndex);
        return appIdx >= 0 && box.name instanceof Uint8Array;
      }).map(box => ({
        appIndex: BigInt(box.appIndex),
        name: box.name
      }));

      if (verifiedBoxes.length > 0) {
        rebuiltAppCall.boxes = verifiedBoxes;
      }
    }

    // Replace original transaction
    txns[i] = rebuiltTxn;

    // DEBUG: Log what was actually set on the rebuilt transaction
    const finalAppCall = rebuiltTxn.applicationCall || rebuiltTxn;
    if (DEBUG) console.log(`[Rebuild] Txn ${i} FINAL: appIndex=${finalAppCall.appIndex}, boxes=${(finalAppCall.boxes || []).map(b => ({ app: Number(b.appIndex), name: Buffer.from(b.name).toString('hex').substring(0, 20) }))}, foreignApps=${(finalAppCall.foreignApps || []).map(a => Number(a))}`);
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

  // FINAL STRICT VERIFICATION: the discovery pass above uses allowUnnamedResources: true, which
  // legitimately reports "unavailable ..." errors WHILE also telling us what to add (that's how
  // resource discovery works, and why simulationErrorMessage can be non-null on an otherwise
  // healthy request above). What we haven't confirmed yet is that the REBUILT group - with all
  // those newly-discovered boxes/foreignApps/foreignAssets actually applied - passes a strict
  // simulation (allowUnnamedResources: false). Encoding and returning without this check would
  // mean a bug anywhere in the distribution/rebuild logic silently ships a transaction group that
  // looks complete but reverts on submission. Fail the request instead.
  try {
    const verifyResponse = await simulateWithATC(txns, algodClient, false, true);
    const verifyFailure = verifyResponse.txnGroups?.[0]?.failureMessage;
    if (verifyFailure) {
      throw new Error(verifyFailure);
    }
  } catch (verifyError) {
    console.error(`[buildBatchUnwrapTransactions] Final strict verification failed: ${verifyError.stack || verifyError.message}`);
    throw new Error(`Failed to build unwrap transactions: final verification failed (${verifyError.message})`);
  }

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
    networkFee: totalFees,
    simulationError: simulationErrorMessage
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

  // Suggested transaction params are stable within a single request, so fetch
  // them at most once and reuse across every transaction we build/rebuild here
  // (the rebuild loop near the end would otherwise call getTransactionParams()
  // once per transaction). Call sites that need to override fee/rounds spread
  // this object into a fresh suggestedParams; none mutate it in place, and
  // algosdk's txn builders read from it without mutating it, so sharing is safe.
  let _cachedSuggestedParams = null;
  const getSuggestedParams = async () => {
    if (!_cachedSuggestedParams) {
      _cachedSuggestedParams = await algodClient.getTransactionParams().do();
    }
    return _cachedSuggestedParams;
  };

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
  
  // Track swap deposit amounts per recipient for native VOI swaps to exclude from network fee calculation.
  // When swapping FROM native VOI, the deposit payment carries the swap amount (which must NOT be counted
  // as a fee) and may ALSO bundle a genuine minimum-balance/box cost (e.g. 28500 microVOI to create the
  // user's balance box on a first-time swap). We key by recipient address and accumulate the deposit
  // amount(s) so the fee loop can subtract only the swap portion, leaving any bundled MBR/box surcharge
  // counted as a real network cost (consistent with how other balance-box payments are reported).
  const swapDepositByRecipient = new Map(); // recipient address -> total swap deposit amount (BigInt)

  // Track Nomadex pool IDs dynamically (to ensure factory app 411751 is added to foreignApps)
  const nomadexPoolIds = new Set();

  // Track simulation error message to return to frontend
  let simulationErrorMessage = null;

  // For multi-hop routes, check if intermediate AND final tokens are ASAs that need opt-in
  // We need to opt-in BEFORE the swap happens because the pool's inner transaction
  // will try to send the ASA to the user's account
  if (isMultiHop && splitDetails.length > 1) {
    const asaOptIns = [];

    // Check ALL hops (including final) for ASA output tokens that need opt-in
    for (let i = 0; i < splitDetails.length; i++) {
      const split = splitDetails[i];
      const { poolCfg } = split;
      const dex = poolCfg.dex || 'humbleswap';
      const splitOutputToken = split.outputToken;
      const outputTokenNum = Number(splitOutputToken);
      const isFinalHop = i === splitDetails.length - 1;

      // Skip native token (VOI = 0)
      if (outputTokenNum === 0) {
        continue;
      }

      // Determine output token type
      let outputTokenType = null;
      if (DEBUG) console.log(`[MultiHop OptIn] Hop ${i} (${isFinalHop ? 'final' : 'intermediate'}): dex=${dex}, outputToken=${outputTokenNum}, poolId=${poolCfg.poolId}`);
      if (dex === 'nomadex') {
        outputTokenType = getTokenTypeFromConfig(poolCfg, outputTokenNum);
        if (DEBUG) console.log(`[MultiHop OptIn] Nomadex pool token type from config: ${outputTokenType}`);
      } else {
        // For HumbleSwap, check if the output token is an ASA
        // For intermediate hops, check if the next hop is Nomadex
        // For the final hop, check the token directly
        if (!isFinalHop) {
          const nextSplit = splitDetails[i + 1];
          const nextDex = nextSplit?.poolCfg?.dex || 'humbleswap';
          if (nextDex === 'nomadex') {
            outputTokenType = getTokenTypeFromConfig(nextSplit.poolCfg, outputTokenNum);
          }
        }
      }

      // For final hop, also check if output token is an ASA from ANY pool config in splitDetails
      // This handles cases where the final output is an ASA but HumbleSwap doesn't have type info
      if (isFinalHop && !outputTokenType) {
        // Check all pool configs in splitDetails to find the token type
        for (const split of splitDetails) {
          if (split.poolCfg) {
            const tokenType = getTokenTypeFromConfig(split.poolCfg, outputTokenNum);
            if (tokenType === 'ASA') {
              outputTokenType = 'ASA';
              break;
            }
          }
        }
      }

      // Only need opt-in for ASA tokens (not ARC200 or native)
      if (outputTokenType === 'ASA') {
        // Check if user is already opted in
        const isOptedIn = await isAccountOptedIntoAsset(address, outputTokenNum);

        if (!isOptedIn) {
          if (DEBUG) console.log(`[MultiHop] Account not opted into ${isFinalHop ? 'final' : 'intermediate'} ASA ${outputTokenNum}, adding opt-in transaction`);
          const optInTxn = await buildAssetOptInTransaction(address, outputTokenNum, await getSuggestedParams());
          asaOptIns.push(optInTxn);
        } else {
          if (DEBUG) console.log(`[MultiHop] Account already opted into ${isFinalHop ? 'final' : 'intermediate'} ASA ${outputTokenNum}`);
        }
      }
    }

    // Prepend opt-in transactions to allTransactions
    if (asaOptIns.length > 0) {
      if (DEBUG) console.log(`[MultiHop] Adding ${asaOptIns.length} ASA opt-in transaction(s) to start of group`);
      allTransactions.push(...asaOptIns);
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
        const poolAddress = algosdk.getApplicationAddress(poolId).toString();
        swapDepositByRecipient.set(poolAddress, (swapDepositByRecipient.get(poolAddress) || 0n) + amountBigInt);
      }
      
      // Enforce the exact GROSS slippage minimum on-chain (Option C). Each leg
      // enforces its raw split.minOutput (M_i); the platform fee is taken
      // separately as one aggregate transfer of platformFee.feeAmount (F). So the
      // worst-case enforced NET floor is Σ split.minOutput − F, which equals the
      // reported minimumOutputAmount. Slippage is already applied in split.minOutput,
      // so no hidden margin here.
      const poolTransactions = await buildNomadexSwapTransactions({
        sender: address,
        poolId: poolId,
        inputToken: inputTokenNum,
        outputToken: outputTokenNum,
        amountIn: amountBigInt.toString(),
        minAmountOut: enforcedMinAmountOut(minOutput),
        isDirectionAlphaToBeta,
        inputTokenType,
        outputTokenType,
        algodClient,
        suggestedParams: await getSuggestedParams()
      });

      // Decode transactions to add to group
      // IMPORTANT: We need to preserve foreignAssets and foreignApps when decoding
      // because they're needed for the app call to access asset/app information
      const decodedTxns = [];
      for (let idx = 0; idx < poolTransactions.length; idx++) {
        const txnBase64 = poolTransactions[idx];
        const txn = algosdk.decodeUnsignedTransaction(Buffer.from(txnBase64, 'base64'));
        
        // For ARC200 transfer transactions (if input is ARC200), preserve boxes
        // In algosdk 3.x, appIndex/boxes/foreignApps/etc are under txn.applicationCall (there is no
        // top-level txn.appIndex - it's always undefined, so appIndex checks against it never matched
        // and appIndex: txn.appIndex below always encoded as undefined).
        const txnAppCall = txn.applicationCall || txn;
        if (txn.type === 'appl' && inputTokenType === 'ARC200' && inputTokenNum !== 0 && Number(txnAppCall.appIndex) === inputTokenNum) {
          // This is the ARC200 transfer transaction - preserve its boxes
          const existingBoxes = txnAppCall.boxes || [];
          if (existingBoxes.length > 0) {
            // Boxes are already on the transaction, just use it as-is
            decodedTxns.push(txn);
            continue;
          } else {
            // Reconstruct boxes for ARC200 transfer transaction
            const balancesPrefix = Buffer.from('balances', 'utf-8');
            const senderAddressBytes = algosdk.Address.fromString(address).publicKey;
            const poolAddressBytes = algosdk.Address.fromString(algosdk.getApplicationAddress(poolId).toString()).publicKey;

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
            const fromAddress = txn.sender.toString();
            const suggestedParams = await getSuggestedParams();

            // Get existing foreignApps/foreignAssets from applicationCall
            const existingForeignApps = txnAppCall.foreignApps || [];
            const existingForeignAssets = txnAppCall.foreignAssets || [];

            const arc200TxnObj = {
              sender: fromAddress,
              appIndex: txnAppCall.appIndex,
              // In algosdk 3.x, onComplete lives on txn.applicationCall.onComplete, not a
              // top-level txn.appOnComplete (which doesn't exist and is always undefined) -
              // using the latter made makeApplicationCallTxnFromObject throw "onComplete must
              // be provided" whenever this rebuild path actually ran.
              onComplete: txnAppCall.onComplete,
              appArgs: txnAppCall.appArgs,
              foreignApps: existingForeignApps,
              foreignAssets: existingForeignAssets,
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
            // Manually set resources after creation - in algosdk 3.x, these are under applicationCall
            const arc200AppCall = rebuiltArc200Txn.applicationCall || rebuiltArc200Txn;
            arc200AppCall.boxes = arc200Boxes.map(b => ({
              appIndex: BigInt(b.appIndex),
              name: b.name
            }));
            if (existingForeignApps.length > 0) {
              arc200AppCall.foreignApps = existingForeignApps.map(a => BigInt(a));
            }
            if (existingForeignAssets.length > 0) {
              arc200AppCall.foreignAssets = existingForeignAssets.map(a => BigInt(a));
            }
            decodedTxns.push(rebuiltArc200Txn);
            continue;
          }
        }

        // For app call transactions, rebuild them properly with foreignAssets/foreignApps
        // Simply setting properties doesn't work - we need to rebuild the transaction
        // (appIndex lives on applicationCall, not a top-level txn.appIndex - see note above)
        if (txn.type === 'appl' && Number(txnAppCall.appIndex) === poolId) {
          // IMPORTANT: Preserve foreignApps from Nomadex transaction (includes factory app 411751)
          // Nomadex sets these in buildNomadexSwapTransactions, and we must preserve them
          // In algosdk 3.x, foreignApps are under applicationCall
          const preservedForeignApps = txnAppCall.foreignApps || [];
          
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
          const fromAddress = txn.sender.toString();
          const suggestedParams = await getSuggestedParams();
          
          // Extract box references from original transaction if present
          // Boxes are stored as an array of { appIndex, name } objects
          let boxes = undefined;
          
          // Check if boxes exist in the decoded transaction
          // In algosdk 3.x, boxes are under txn.applicationCall
          const txnBoxes = txnAppCall.boxes || [];
          
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
            const poolAddress = algosdk.getApplicationAddress(poolId).toString();
            
            // Initialize boxes array if needed
            if (!boxes) {
              boxes = [];
            }
            
            if (inputTokenType === 'ARC200' && inputTokenNum !== 0) {
              // Add sender's balance box
              const senderAddressBytes = algosdk.Address.fromString(address).publicKey;
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
              const poolAddressBytes = algosdk.Address.fromString(poolAddress).publicKey;
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
              const senderAddressBytes = algosdk.Address.fromString(address).publicKey;
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
              const poolAddressBytes = algosdk.Address.fromString(poolAddress).publicKey;
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
            sender: fromAddress,
            appIndex: txnAppCall.appIndex,
            // See note above: onComplete lives on applicationCall in algosdk 3.x, not txn.appOnComplete.
            onComplete: txnAppCall.onComplete,
            appArgs: txnAppCall.appArgs,
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
          // In algosdk 3.x, accounts are under txn.applicationCall
          const existingAccounts = txnAppCall.accounts || [];
          if (existingAccounts.length > 0) {
            txnObj.accounts = existingAccounts.map(acc => {
              // Handle both string addresses and objects with publicKey
              if (typeof acc === 'string') {
                return acc;
              } else if (acc && acc.publicKey) {
                return acc.toString();
              } else if (acc instanceof Uint8Array) {
                return new algosdk.Address(acc).toString();
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
            txnObj.rekeyTo = txn.rekeyTo.toString();
          }
          
          // Remove boxes from txnObj since makeApplicationCallTxnFromObject might not handle them correctly
          const boxesToAdd = txnObj.boxes;
          delete txnObj.boxes;
          
          const rebuiltTxn = algosdk.makeApplicationCallTxnFromObject(txnObj);
          
          // Manually set boxes on the transaction after creation
          // In algosdk 3.x, boxes are under applicationCall
          if (boxesToAdd && boxesToAdd.length > 0) {
            // Verify boxes one more time before setting
            const verifiedBoxes = boxesToAdd.filter(box => {
              const appIdx = typeof box.appIndex === 'number' ? box.appIndex : Number(box.appIndex);
              return appIdx >= 0 && box.name instanceof Uint8Array;
            }).map(box => ({
              appIndex: BigInt(box.appIndex),
              name: box.name
            }));

            if (verifiedBoxes.length > 0) {
              // Set boxes on applicationCall for algosdk 3.x
              const appCall = rebuiltTxn.applicationCall || rebuiltTxn;
              appCall.boxes = verifiedBoxes;
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
      
      // Reuse the swap direction the quote already resolved against live pool
      // token order (quotes.js computes swapAForB as inputWrapped === tokA &&
      // outputWrapped === tokB, and throws when neither orientation matches).
      // BUILD MUST be consistent with QUOTE - the amounts were priced for this
      // exact orientation - so we reuse the quoted direction instead of
      // re-fetching Info() (a re-fetch could read a different snapshot than the
      // one that was priced). Authenticate the quote against THIS split before
      // trusting its direction: require a HumbleSwap quote FOR THIS pool id
      // (tokA/tokB order is per-pool, so a same-pair quote from a different pool
      // could carry the opposite orientation) that carries a concrete boolean
      // direction for the exact wrapped tokens we are building. This preserves
      // the token-identity guard the removed re-fetch provided (a stale/mismatched
      // quote can no longer silently select the wrong swap direction) at no
      // network cost.
      if (
        quote?.dex !== 'humbleswap' ||
        String(quote?.poolId) !== String(poolId) ||
        typeof quote?.poolInfo?.swapAForB !== 'boolean' ||
        String(quote.poolInfo.inputWrapped) !== String(inputWrapped) ||
        String(quote.poolInfo.outputWrapped) !== String(outputWrapped)
      ) {
        throw new Error(`Quoted pool info does not match build for pool ${poolId} (wrapped ${inputWrapped} -> ${outputWrapped})`);
      }
      const swapAForB = quote.poolInfo.swapAForB;

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
        // When swapping FROM native VOI, the deposit payment goes to the wrapped token contract.
        // On a first-time swap this payment also bundles a 28500 microVOI balance-box (MBR) cost, so
        // the fee loop subtracts the swap amount and keeps only the surcharge as a real network fee.
        const wrappedTokenContractAddress = algosdk.getApplicationAddress(inputWrapped).toString();
        swapDepositByRecipient.set(wrappedTokenContractAddress, (swapDepositByRecipient.get(wrappedTokenContractAddress) || 0n) + amountBigInt);
      }

      // Enforce the exact GROSS slippage minimum on-chain (Option C). Each leg
      // enforces its raw split.minOutput (M_i); the platform fee is taken
      // separately as one aggregate transfer of platformFee.feeAmount (F). So the
      // worst-case enforced NET floor is Σ split.minOutput − F, which equals the
      // reported minimumOutputAmount. Slippage is already applied in split.minOutput,
      // so no hidden margin here.

      // Determine actual token types for HumbleSwap
      // For multi-hop, the input might be a pure ARC200 from a previous Nomadex hop
      const humbleInputTokenType = determineTokenTypeForHumbleswap(inputTokenStr, inputWrapped);
      const humbleOutputTokenType = determineTokenTypeForHumbleswap(outputTokenStr, outputWrapped);

      // Build swap transactions using arccjs (NO SIMULATION!)
      const decodedTxns = await buildHumbleswapSwapTransactionsArccjs({
        sender: address,
        poolId: poolId,
        inputWrapped: inputWrapped,
        outputWrapped: outputWrapped,
        amountIn: amountBigInt.toString(),
        minAmountOut: enforcedMinAmountOut(minOutput),
        // Expected (actual) raw pool output for THIS hop's actual input amount. The builder
        // withdraws a value buffered just below this (bounded by minAmountOut on the low side)
        // so micro reserve-drift between quote-time and submission doesn't over-withdraw and
        // revert the swap (TASK-41: withdraw reverts on amount > balance, verified on-chain).
        // We recompute from amountBigInt (the exact amount this hop swaps) using the quote's
        // reserves/fee, rather than reusing quote.outputAmount, so the withdraw stays bound to
        // the actual swap input even if hop-input forwarding changes. This yields the raw pool
        // output BEFORE platform fee (the fee is charged as a separate transaction from the
        // withdrawn underlying token).
        expectedAmountOut: calculateHumbleswapOutput(
          amountBigInt,
          quote.poolInfo.reserveA,
          quote.poolInfo.reserveB,
          quote.poolInfo.fee
        ).toString(),
        swapAForB: swapAForB,
        algodClient: algodClient,
        indexerClient: indexerClient,
        extraTxns: extraTxns,
        inputTokenId: inputTokenStr, // underlying token ID (0 for VOI, >0 for ASA)
        outputTokenId: outputTokenStr, // underlying token ID (0 for VOI, >0 for ASA)
        inputTokenType: humbleInputTokenType, // explicit type: "native", "ASA", or "ARC200"
        outputTokenType: humbleOutputTokenType, // explicit type: "native", "ASA", or "ARC200"
        inputSymbol: inputTokenMeta.symbol || '',
        outputSymbol: outputTokenMeta.symbol || '',
        slippage: slippage,
        degenMode: false,
        skipWithdraw: outputNeededByNextHop, // Skip withdraw if next hop needs this wrapped token
        skipDeposit: inputFromPreviousHop, // Skip deposit if we already have it from previous hop
        suggestedParams: await getSuggestedParams()
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
    const suggestedParams = await getSuggestedParams();
    
    let feeTxn;
    
    if (outputTokenType === 'native') {
      // Native token payment
      feeTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: address,
        receiver: feeAddress,
        amount: feeAmount,
        suggestedParams
      });
    } else if (outputTokenType === 'ASA') {
      // ASA asset transfer
      feeTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: address,
        receiver: feeAddress,
        amount: feeAmount,
        assetIndex: outputTokenNum,
        suggestedParams
      });
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
      // Track appLocal pairs (app + account that MUST be in the same transaction for local state access)
      const cumulativeAppLocalPairs = [];
      // Track holding pairs (asset + account that MUST be in the same transaction for asset holding access)
      const cumulativeHoldingPairs = [];

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

        // Check if simulation passed (no errors).
        // IMPORTANT: simulateTransactionGroup can fail the *call itself* (algod timeout/5xx/429,
        // or the 413-chunked fallback path exhausting with chunk errors). In that case it returns
        // { success: false, ... } with NO simulateResponse and NO `errors` array - if we only
        // checked `failureMessage`/`errors` here, that would be misread as "no errors" (a pass),
        // even though box/app/asset references were never discovered. Treat success === false
        // with no txnGroup as a hard failure too.
        const txnGroup = simulationResult?.simulateResponse?.txnGroups?.[0];
        const simulateCallFailed = simulationResult?.success === false && !txnGroup;
        const failureMessage = txnGroup?.failureMessage || (simulateCallFailed ? simulationResult?.error : null);
        const hasErrors = simulateCallFailed || !!failureMessage || (simulationResult?.errors && simulationResult.errors.length > 0);

        if (!hasErrors) {
          if (DEBUG) console.log(`[Simulation] Passed on iteration ${simIteration + 1}`);
          lastSimulationPassed = true;
          simulationErrorMessage = null; // Clear any previous error since simulation passed
          break; // Simulation passed, no need to iterate further
        }

        // Log simulation failure (including simulate-call failures, not just on-chain errors)
        console.error(`[Simulation] Failed on iteration ${simIteration + 1}: ${failureMessage?.substring?.(0, 300) || failureMessage || 'Unknown error'}`);
        simulationErrorMessage = failureMessage || simulationResult?.error || 'Unknown simulation error';

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
        // In algosdk 3.x, resources are under txn.applicationCall
        const appCallTxnsForDistribution = [];
        for (let i = 0; i < allTransactions.length; i++) {
          const txn = allTransactions[i];
          if (txn.type === 'appl') {
            const appCall = txn.applicationCall || txn;
            if (!appCall.foreignApps) appCall.foreignApps = [];
            if (!appCall.foreignAssets) appCall.foreignAssets = [];
            if (!appCall.accounts) appCall.accounts = [];
            if (!appCall.boxes) appCall.boxes = [];
            appCallTxnsForDistribution.push({ txn, appCall, idx: i });
          }
        }

        // Add apps from errors to transactions
        for (const appId of newApps) {
          const appIdBigInt = BigInt(appId);
          if (!appCallTxnsForDistribution.some(({ appCall }) => appCall.foreignApps.some(a => BigInt(a) === appIdBigInt))) {
            for (const { appCall } of appCallTxnsForDistribution) {
              const currentRefs = (appCall.boxes?.length || 0) + appCall.foreignApps.length + appCall.foreignAssets.length + appCall.accounts.length;
              if (currentRefs < 8 && !appCall.foreignApps.some(a => BigInt(a) === appIdBigInt)) {
                appCall.foreignApps.push(appIdBigInt);
                break;
              }
            }
          }
        }

        // Add assets from errors to transactions
        for (const assetId of newAssets) {
          const assetIdBigInt = BigInt(assetId);
          if (!appCallTxnsForDistribution.some(({ appCall }) => appCall.foreignAssets.some(a => BigInt(a) === assetIdBigInt))) {
            for (const { appCall } of appCallTxnsForDistribution) {
              const currentRefs = (appCall.boxes?.length || 0) + appCall.foreignApps.length + appCall.foreignAssets.length + appCall.accounts.length;
              if (currentRefs < 8 && !appCall.foreignAssets.some(a => BigInt(a) === assetIdBigInt)) {
                appCall.foreignAssets.push(assetIdBigInt);
                break;
              }
            }
          }
        }

        // Add accounts from errors to transactions
        for (const accountAddr of newAccounts) {
          const isInGroup = appCallTxnsForDistribution.some(({ appCall }) =>
            appCall.accounts.some(acc => {
              const accStr = typeof acc === 'string' ? acc : acc.toString();
              return accStr === accountAddr;
            })
          );
          if (!isInGroup) {
            for (const { appCall } of appCallTxnsForDistribution) {
              const currentRefs = (appCall.boxes?.length || 0) + appCall.foreignApps.length + appCall.foreignAssets.length + appCall.accounts.length;
              const currentAccounts = appCall.accounts.length;
              // Check both total references (8) and accounts limit (4)
              if (currentRefs < 8 && currentAccounts < 4) {
                appCall.accounts.push(algosdk.Address.fromString(accountAddr));
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

      // If permissive simulation never actually succeeded (every iteration kept hitting errors, or
      // we stopped making progress before it did), the group's required box/app/asset references
      // were NOT confirmed. Routes that reach this block (multi-hop / HumbleSwap) rely entirely on
      // this simulation to discover those references - there's no fallback construction path for
      // them. Fail the whole request rather than encode and return a group known to be incomplete.
      if (!lastSimulationPassed) {
        const reason = simulationErrorMessage || 'permissive simulation never converged';
        throw new Error(`Unable to confirm required transaction resources via simulation: ${reason}`);
      }

      // CRITICAL: Apply resources from successful permissive simulation BEFORE running strict verification
      // When permissive simulation passes, unnamedResourcesAccessed contains resources that were used
      // We must add these to transactions now, or verification will fail and iterate to find them one by one
      if (lastSimulationPassed && simulationResult) {
        // Extract all resources from unnamedResourcesAccessed
        const txnGroup = simulationResult.simulateResponse?.txnGroups?.[0];
        const groupUnnamed = txnGroup?.unnamedResourcesAccessed || {};
        const txnResults = txnGroup?.txnResults || [];

        // Collect all resources from group and per-transaction unnamedResourcesAccessed
        const preVerifyApps = new Set();
        const preVerifyAssets = new Set();
        const preVerifyAccounts = new Set();
        const preVerifyHoldings = []; // {asset, account} pairs

        try {
          // Group-level resources
          for (const app of (groupUnnamed.apps || [])) {
            preVerifyApps.add(typeof app === 'number' ? app : Number(app));
          }
          for (const asset of (groupUnnamed.assets || [])) {
            preVerifyAssets.add(typeof asset === 'number' ? asset : Number(asset));
          }
          for (const account of (groupUnnamed.accounts || [])) {
            // Account can be a string, an Address object with toString, or a Uint8Array
            let accountAddr;
            if (typeof account === 'string') {
              accountAddr = account;
            } else if (account && typeof account.toString === 'function' && account.toString().length === 58) {
              accountAddr = account.toString();
            } else if (account instanceof Uint8Array) {
              accountAddr = new algosdk.Address(account).toString();
            } else {
              continue;
            }
            preVerifyAccounts.add(accountAddr);
          }
          for (const holding of (groupUnnamed.assetHoldings || [])) {
            const assetId = typeof holding.asset === 'number' ? holding.asset : Number(holding.asset);
            let accountAddr;
            if (typeof holding.account === 'string') {
              accountAddr = holding.account;
            } else if (holding.account && typeof holding.account.toString === 'function' && holding.account.toString().length === 58) {
              accountAddr = holding.account.toString();
            } else if (holding.account instanceof Uint8Array) {
              accountAddr = new algosdk.Address(holding.account).toString();
            } else {
              continue;
            }
            preVerifyHoldings.push({ asset: assetId, account: accountAddr });
          }
          // Per-transaction resources
          for (let ti = 0; ti < txnResults.length; ti++) {
            const txnResult = txnResults[ti];
            const txnUnnamed = txnResult?.unnamedResourcesAccessed || {};
            for (const app of (txnUnnamed.apps || [])) {
              preVerifyApps.add(typeof app === 'number' ? app : Number(app));
            }
            for (const asset of (txnUnnamed.assets || [])) {
              preVerifyAssets.add(typeof asset === 'number' ? asset : Number(asset));
            }
            for (const account of (txnUnnamed.accounts || [])) {
              let accountAddr;
              if (typeof account === 'string') {
                accountAddr = account;
              } else if (account && typeof account.toString === 'function' && account.toString().length === 58) {
                accountAddr = account.toString();
              } else if (account instanceof Uint8Array) {
                accountAddr = new algosdk.Address(account).toString();
              } else {
                continue;
              }
              preVerifyAccounts.add(accountAddr);
            }
            for (const holding of (txnUnnamed.assetHoldings || [])) {
              const assetId = typeof holding.asset === 'number' ? holding.asset : Number(holding.asset);
              let accountAddr;
              if (typeof holding.account === 'string') {
                accountAddr = holding.account;
              } else if (holding.account && typeof holding.account.toString === 'function' && holding.account.toString().length === 58) {
                accountAddr = holding.account.toString();
              } else if (holding.account instanceof Uint8Array) {
                accountAddr = new algosdk.Address(holding.account).toString();
              } else {
                continue;
              }
              preVerifyHoldings.push({ asset: assetId, account: accountAddr });
            }
          }
        } catch (extractError) {
          console.error(`[Pre-Verification] Error extracting resources: ${extractError.message}`);
        }

        if (DEBUG) {
          if (DEBUG) console.log(`[Pre-Verification] Discovered from simulation: apps=${preVerifyApps.size}, assets=${preVerifyAssets.size}, accounts=${preVerifyAccounts.size}, holdings=${preVerifyHoldings.length}, boxes=${simulationResult.boxReferences?.length || 0}`);
        }

        // Find app call transactions for distributing resources
        const appCallTxnsForPreVerify = [];
        for (let i = 0; i < allTransactions.length; i++) {
          const txn = allTransactions[i];
          if (txn.type === 'appl') {
            const appCall = txn.applicationCall || txn;
            if (!appCall.boxes) appCall.boxes = [];
            if (!appCall.foreignApps) appCall.foreignApps = [];
            if (!appCall.foreignAssets) appCall.foreignAssets = [];
            if (!appCall.accounts) appCall.accounts = [];
            appCallTxnsForPreVerify.push({ txn, appCall, idx: i });
          }
        }

        // Apply apps
        for (const appId of preVerifyApps) {
          const appIdBigInt = BigInt(appId);
          const alreadyInGroup = appCallTxnsForPreVerify.some(({ appCall }) =>
            appCall.foreignApps.some(a => BigInt(a) === appIdBigInt)
          );
          if (!alreadyInGroup) {
            for (const { appCall, idx } of appCallTxnsForPreVerify) {
              const currentRefs = appCall.boxes.length + appCall.foreignApps.length + appCall.foreignAssets.length + appCall.accounts.length;
              if (currentRefs < 8) {
                appCall.foreignApps.push(appIdBigInt);
                break;
              }
            }
          }
        }

        // Apply assets
        for (const assetId of preVerifyAssets) {
          const assetIdBigInt = BigInt(assetId);
          const alreadyInGroup = appCallTxnsForPreVerify.some(({ appCall }) =>
            appCall.foreignAssets.some(a => BigInt(a) === assetIdBigInt)
          );
          if (!alreadyInGroup) {
            for (const { appCall, idx } of appCallTxnsForPreVerify) {
              const currentRefs = appCall.boxes.length + appCall.foreignApps.length + appCall.foreignAssets.length + appCall.accounts.length;
              if (currentRefs < 8) {
                appCall.foreignAssets.push(assetIdBigInt);
                break;
              }
            }
          }
        }

        // Apply accounts
        for (const accountAddr of preVerifyAccounts) {
          const alreadyInGroup = appCallTxnsForPreVerify.some(({ appCall }) =>
            appCall.accounts.some(a => {
              const aStr = typeof a === 'string' ? a : a.toString();
              return aStr === accountAddr;
            })
          );
          if (!alreadyInGroup) {
            for (const { appCall, idx } of appCallTxnsForPreVerify) {
              const currentRefs = appCall.boxes.length + appCall.foreignApps.length + appCall.foreignAssets.length + appCall.accounts.length;
              if (currentRefs < 8 && appCall.accounts.length < 4) {
                appCall.accounts.push(algosdk.Address.fromString(accountAddr));
                break;
              }
            }
          }
        }

        // Apply holdings - BOTH asset AND account MUST be in the SAME transaction
        for (const { asset: assetId, account: accountAddr } of preVerifyHoldings) {
          const assetIdBigInt = BigInt(assetId);

          // Check if pair already exists
          let pairExists = false;
          for (const { appCall } of appCallTxnsForPreVerify) {
            const hasAsset = appCall.foreignAssets.some(a => BigInt(a) === assetIdBigInt);
            const hasAccount = appCall.accounts.some(a => {
              const aStr = typeof a === 'string' ? a : a.toString();
              return aStr === accountAddr;
            });
            if (hasAsset && hasAccount) {
              pairExists = true;
              break;
            }
          }

          if (!pairExists) {
            // Try to find matching pool transaction first
            let targetPoolAppIndex = null;
            for (const { txn, appCall } of appCallTxnsForPreVerify) {
              const appIndex = txn.appIndex || appCall.appIndex;
              if (appIndex) {
                try {
                  const poolAppAddress = algosdk.getApplicationAddress(Number(appIndex)).toString();
                  if (poolAppAddress === accountAddr) {
                    targetPoolAppIndex = Number(appIndex);
                    break;
                  }
                } catch (e) { /* ignore */ }
              }
            }

            let added = false;
            // First try matching pool transaction
            if (targetPoolAppIndex !== null) {
              for (const { txn, appCall, idx } of appCallTxnsForPreVerify) {
                const appIndex = Number(txn.appIndex || appCall.appIndex || 0);
                if (appIndex !== targetPoolAppIndex) continue;

                const hasAsset = appCall.foreignAssets.some(a => BigInt(a) === assetIdBigInt);
                const hasAccount = appCall.accounts.some(a => (typeof a === 'string' ? a : a.toString()) === accountAddr);
                const needsAssetSlot = !hasAsset ? 1 : 0;
                const needsAccountSlot = !hasAccount ? 1 : 0;
                const currentRefs = appCall.boxes.length + appCall.foreignApps.length + appCall.foreignAssets.length + appCall.accounts.length;
                const slotsNeeded = needsAssetSlot + needsAccountSlot;

                if (currentRefs + slotsNeeded <= 8 && appCall.accounts.length + needsAccountSlot <= 4) {
                  if (needsAssetSlot > 0) appCall.foreignAssets.push(assetIdBigInt);
                  if (needsAccountSlot > 0) appCall.accounts.push(algosdk.Address.fromString(accountAddr));
                  added = true;
                  break;
                }
              }
            }

            // Fallback to any transaction with room
            if (!added) {
              for (const { appCall, idx } of appCallTxnsForPreVerify) {
                const hasAsset = appCall.foreignAssets.some(a => BigInt(a) === assetIdBigInt);
                const hasAccount = appCall.accounts.some(a => (typeof a === 'string' ? a : a.toString()) === accountAddr);
                const needsAssetSlot = !hasAsset ? 1 : 0;
                const needsAccountSlot = !hasAccount ? 1 : 0;
                const currentRefs = appCall.boxes.length + appCall.foreignApps.length + appCall.foreignAssets.length + appCall.accounts.length;
                const slotsNeeded = needsAssetSlot + needsAccountSlot;

                if (currentRefs + slotsNeeded <= 8 && appCall.accounts.length + needsAccountSlot <= 4) {
                  if (needsAssetSlot > 0) appCall.foreignAssets.push(assetIdBigInt);
                  if (needsAccountSlot > 0) appCall.accounts.push(algosdk.Address.fromString(accountAddr));
                  added = true;
                  break;
                }
              }
            }
          }
        }

        // Apply boxes
        if (simulationResult.boxReferences && simulationResult.boxReferences.length > 0) {

        // Find app call transactions to distribute boxes to
        const appCallTxnsForBoxes = [];
        for (let i = 0; i < allTransactions.length; i++) {
          const txn = allTransactions[i];
          if (txn.type === 'appl') {
            const appCall = txn.applicationCall || txn;
            if (!appCall.boxes) appCall.boxes = [];
            if (!appCall.foreignApps) appCall.foreignApps = [];
            appCallTxnsForBoxes.push({ txn, appCall, idx: i });
          }
        }

        // Add each box to the appropriate transaction
        for (const boxRef of simulationResult.boxReferences) {
          const appIndex = typeof boxRef.appIndex === 'number' ? boxRef.appIndex : Number(boxRef.appIndex);
          const name = boxRef.name instanceof Uint8Array ? boxRef.name : new Uint8Array(boxRef.name);
          const boxNameHex = Buffer.from(name).toString('hex');

          // Check if box already exists in any transaction
          let boxExists = false;
          for (const { appCall } of appCallTxnsForBoxes) {
            const exists = appCall.boxes.some(b => {
              const bAppIndex = typeof b.appIndex === 'number' ? b.appIndex : Number(b.appIndex);
              const bNameHex = Buffer.from(b.name).toString('hex');
              return bAppIndex === appIndex && bNameHex === boxNameHex;
            });
            if (exists) {
              boxExists = true;
              break;
            }
          }

          if (!boxExists) {
            // Find a transaction with room for this box
            // Prefer the transaction that matches the box's txnIndex if available
            const preferredTxnIndex = typeof boxRef.txnIndex === 'number' ? boxRef.txnIndex : 0;
            let added = false;

            // First try the preferred transaction
            for (const { txn, appCall, idx } of appCallTxnsForBoxes) {
              if (idx !== preferredTxnIndex) continue;

              const currentRefs = appCall.boxes.length + (appCall.foreignApps?.length || 0) + (appCall.foreignAssets?.length || 0) + (appCall.accounts?.length || 0);
              if (currentRefs < 8) {
                appCall.boxes.push({ appIndex: BigInt(appIndex), name });
                // Also ensure the box's app is in foreignApps
                const appIndexBigInt = BigInt(appIndex);
                if (!appCall.foreignApps.some(a => BigInt(a) === appIndexBigInt)) {
                  appCall.foreignApps.push(appIndexBigInt);
                }
                added = true;
                break;
              }
            }

            // Fall back to any transaction with room
            if (!added) {
              for (const { appCall, idx } of appCallTxnsForBoxes) {
                const currentRefs = appCall.boxes.length + (appCall.foreignApps?.length || 0) + (appCall.foreignAssets?.length || 0) + (appCall.accounts?.length || 0);
                if (currentRefs < 8) {
                  appCall.boxes.push({ appIndex: BigInt(appIndex), name });
                  // Also ensure the box's app is in foreignApps
                  const appIndexBigInt = BigInt(appIndex);
                  if (!appCall.foreignApps.some(a => BigInt(a) === appIndexBigInt)) {
                    appCall.foreignApps.push(appIndexBigInt);
                  }
                  added = true;
                  break;
                }
              }
            }

          }
        }
        }
      }

      // VERIFICATION SIMULATION: Run a strict simulation (allowUnnamedResources: false)
      // to catch resources that were silently allowed but not reported in unnamedResourcesAccessed.
      // This is critical for catching inner transaction targets that the permissive simulation misses.
      if (lastSimulationPassed) {
        const MAX_VERIFY_ITERATIONS = 8;
        // Track whether strict verification (allowUnnamedResources: false) ever actually
        // succeeded. If it never does, the group we're about to return has NOT been confirmed
        // to carry all the resource references the AVM will require - that must be surfaced
        // via simulationErrorMessage rather than silently reported as passed (simulationError: null).
        let verificationPassed = false;
        let lastVerifyFailureText = null;
        for (let verifyIteration = 0; verifyIteration < MAX_VERIFY_ITERATIONS; verifyIteration++) {
          try {
            // Clear and reassign group IDs
            for (const txn of allTransactions) {
              if (txn.group) {
                txn.group = undefined;
              }
            }
            algosdk.assignGroupID(allTransactions);

            // Build strict simulation using ATC (allowUnnamedResources: false)
            const verifyResponse = await simulateWithATC(allTransactions, algodClient, false, true);
            const verifyGroup = verifyResponse.txnGroups?.[0];
            const verifyFailure = verifyGroup?.failureMessage;

            if (!verifyFailure) {
              // Verification passed - all resources are properly declared
              // Count total resources across all transactions
              let totalApps = 0, totalAssets = 0, totalAccounts = 0, totalBoxes = 0;
              for (const txn of allTransactions) {
                if (txn.type === 'appl') {
                  const ac = txn.applicationCall || txn;
                  totalApps += (ac.foreignApps || []).length;
                  totalAssets += (ac.foreignAssets || []).length;
                  totalAccounts += (ac.accounts || []).length;
                  totalBoxes += (ac.boxes || []).length;
                }
              }
              const iterStr = verifyIteration > 0 ? ` (${verifyIteration + 1} iterations)` : '';
              if (DEBUG) console.log(`[Verify] Passed${iterStr}: ${allTransactions.length} txns, ${totalApps} apps, ${totalAssets} assets, ${totalAccounts} accounts, ${totalBoxes} boxes`);
              verificationPassed = true;
              if (DEBUG) {
                for (let t = 0; t < allTransactions.length; t++) {
                  const txn = allTransactions[t];
                  if (txn.type === 'appl') {
                    const ac = txn.applicationCall || txn;
                    if (DEBUG) console.log(`[Verification] Final Txn ${t} (app ${ac.appIndex}): foreignAssets=${(ac.foreignAssets || []).map(a => Number(a))}, accounts=${(ac.accounts || []).map(a => a.toString ? a.toString() : a)}`);
                  }
                }
              }
              break;
            }

            lastVerifyFailureText = verifyFailure;
            if (DEBUG) {
              if (DEBUG) console.log(`[Verification] Iteration ${verifyIteration + 1} failure: ${verifyFailure.substring(0, 300)}`);
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
                if (DEBUG) console.log(`[Verification] Discovered missing app: ${appId}`);
              }
            }

            // Extract accounts AND apps: "unavailable Local State {appId}+{accountAddress}"
            // CRITICAL: For local state access, BOTH the app AND account MUST be in the SAME transaction
            // Track these as appLocal pairs so we can add them together, not separately
            const newlyDiscoveredAppLocalPairs = [];
            const localStateMatches = verifyFailure.matchAll(/unavailable Local State (\d+)\+([A-Z2-7]{58})/g);
            for (const match of localStateMatches) {
              const appId = Number(match[1]);
              const accountAddr = match[2];
              if (appId > 0 && accountAddr) {
                // Track as a pair - both MUST be in the same transaction
                const pairKey = `${appId}:${accountAddr}`;
                const alreadyHave = cumulativeAppLocalPairs.some(p => p.app === appId && p.account === accountAddr);
                if (!alreadyHave) {
                  cumulativeAppLocalPairs.push({ app: appId, account: accountAddr });
                  newlyDiscoveredAppLocalPairs.push({ app: appId, account: accountAddr });
                  if (DEBUG) console.log(`[Verification] Discovered missing appLocal pair: app=${appId}, account=${accountAddr}`);
                }
                // Still track individually for other purposes
                if (!cumulativeAppsFromErrors.has(appId)) {
                  cumulativeAppsFromErrors.add(appId);
                  newlyDiscoveredApps.add(appId);
                }
                if (!cumulativeAccountsFromErrors.has(accountAddr)) {
                  cumulativeAccountsFromErrors.add(accountAddr);
                  newlyDiscoveredAccounts.add(accountAddr);
                }
              }
            }

            // Extract accounts AND assets: "unavailable Holding {assetId}+{accountAddress}"
            // CRITICAL: For asset holding access, BOTH the asset AND account MUST be in the SAME transaction
            const newlyDiscoveredHoldingPairs = [];
            const holdingMatches = verifyFailure.matchAll(/unavailable Holding (\d+)\+([A-Z2-7]{58})/g);
            for (const match of holdingMatches) {
              const assetId = Number(match[1]);
              const accountAddr = match[2];
              if (assetId > 0 && accountAddr) {
                // Track as a pair - both MUST be in the same transaction
                const alreadyHave = cumulativeHoldingPairs.some(p => p.asset === assetId && p.account === accountAddr);
                if (!alreadyHave) {
                  cumulativeHoldingPairs.push({ asset: assetId, account: accountAddr });
                  newlyDiscoveredHoldingPairs.push({ asset: assetId, account: accountAddr });
                  if (DEBUG) console.log(`[Verification] Discovered missing holding pair: asset=${assetId}, account=${accountAddr}`);
                }
                // Still track individually for other purposes
                if (!cumulativeAssetsFromErrors.has(assetId)) {
                  cumulativeAssetsFromErrors.add(assetId);
                  newlyDiscoveredAssets.add(assetId);
                }
                if (!cumulativeAccountsFromErrors.has(accountAddr)) {
                  cumulativeAccountsFromErrors.add(accountAddr);
                  newlyDiscoveredAccounts.add(accountAddr);
                }
              }
            }

            // Extract standalone assets: "unavailable Asset {assetId}. Details: app={appId}"
            const unavailableAssetMatches = verifyFailure.matchAll(/unavailable Asset (\d+)(?:\. Details: app=(\d+))?/g);
            for (const match of unavailableAssetMatches) {
              const assetId = Number(match[1]);
              if (assetId > 0 && !cumulativeAssetsFromErrors.has(assetId)) {
                cumulativeAssetsFromErrors.add(assetId);
                newlyDiscoveredAssets.add(assetId);
                if (DEBUG) console.log(`[Verification] Discovered missing asset: ${assetId}`);
              }
            }

            // Extract missing box references: "invalid Box reference 0x{hexBoxName}. Details: app={appId}"
            // Track newly discovered boxes this iteration
            const newlyDiscoveredBoxes = [];
            const invalidBoxMatches = verifyFailure.matchAll(/invalid Box reference 0x([0-9a-fA-F]+)(?:\. Details: app=(\d+))?/g);
            for (const match of invalidBoxMatches) {
              const boxNameHex = match[1];
              const appIdFromDetails = match[2] ? Number(match[2]) : null;

              if (boxNameHex) {
                const boxName = new Uint8Array(Buffer.from(boxNameHex, 'hex'));
                // Determine which app this box belongs to
                // If Details contains app=, use that. Otherwise, try to find from context
                let boxAppId = appIdFromDetails;

                if (!boxAppId) {
                  // Box reference without app ID - skip
                  continue;
                }

                // Check if we already have this box
                const boxKey = `${boxAppId}:${boxNameHex}`;
                const alreadyHave = allTransactions.some(txn => {
                  if (txn.type !== 'appl') return false;
                  const appCall = txn.applicationCall || txn;
                  const boxes = appCall.boxes || [];
                  return boxes.some(b => {
                    const bAppIndex = typeof b.appIndex === 'number' ? b.appIndex : Number(b.appIndex);
                    const bNameHex = Buffer.from(b.name).toString('hex');
                    return bAppIndex === boxAppId && bNameHex === boxNameHex;
                  });
                });

                if (!alreadyHave) {
                  newlyDiscoveredBoxes.push({ appIndex: boxAppId, name: boxName, key: boxKey });
                  if (DEBUG) console.log(`[Verification] Discovered missing box: app=${boxAppId}, name=0x${boxNameHex.substring(0, 20)}...`);
                }
              }
            }

            const newResourcesFound = newlyDiscoveredApps.size + newlyDiscoveredAssets.size + newlyDiscoveredAccounts.size + newlyDiscoveredBoxes.length + newlyDiscoveredAppLocalPairs.length + newlyDiscoveredHoldingPairs.length;

            if (newResourcesFound === 0) {
              // No new resources found but verification still failing - check if resource limit error
              const isResourceLimitError = verifyFailure.includes('MaxAppTotalTxnReferences') ||
                verifyFailure.includes('exceed') ||
                verifyFailure.includes('too many') ||
                verifyFailure.includes('reference');

              if (isResourceLimitError) {
                console.error(`[Verification] RESOURCE LIMIT ERROR: ${verifyFailure.substring(0, 400)}`);
                logResourceSummary('Verification Failed', allTransactions);
              } else {
                console.warn(`[Verification] Unknown failure (no parseable resources): ${verifyFailure.substring(0, 300)}`);
              }
              break;
            }

            if (DEBUG) console.log(`[Verification] Iteration ${verifyIteration + 1}: Found ${newResourcesFound} new resources, distributing...`);

            // Add newly discovered resources to transactions
            // In algosdk 3.x, resources are under txn.applicationCall, not directly on txn
            const appCallTxnsForVerify = [];
            for (let i = 0; i < allTransactions.length; i++) {
              const txn = allTransactions[i];
              if (txn.type === 'appl') {
                // Get the applicationCall object (algosdk 3.x structure)
                const appCall = txn.applicationCall || txn;
                if (!appCall.foreignApps) appCall.foreignApps = [];
                if (!appCall.foreignAssets) appCall.foreignAssets = [];
                if (!appCall.accounts) appCall.accounts = [];
                if (!appCall.boxes) appCall.boxes = [];
                appCallTxnsForVerify.push({ txn, appCall, idx: i });
              }
            }

            // CRITICAL: Distribute appLocal pairs FIRST - both app AND account MUST be in the SAME transaction
            // This is different from other resources which can use group resource sharing
            for (const { app: appId, account: accountAddr } of newlyDiscoveredAppLocalPairs) {
              let distributed = false;
              const appIdBigInt = BigInt(appId);

              // Find a transaction where we can add BOTH resources
              for (const { appCall, idx } of appCallTxnsForVerify) {
                // Check if app is already present (either as appIndex or in foreignApps)
                const txnAppId = Number(appCall.appIndex || 0);
                const hasApp = txnAppId === appId || appCall.foreignApps.some(a => Number(a) === appId);

                // Check if account is already present
                const hasAccount = appCall.accounts.some(a => {
                  const aStr = typeof a === 'string' ? a : a.toString();
                  return aStr === accountAddr;
                });

                const needsAppSlot = !hasApp ? 1 : 0;
                const needsAccountSlot = !hasAccount ? 1 : 0;
                const currentRefs = appCall.boxes.length + appCall.foreignApps.length + appCall.foreignAssets.length + appCall.accounts.length;
                const slotsNeeded = needsAppSlot + needsAccountSlot;

                // Check if we have room for both (8 max total, 4 max accounts)
                if (currentRefs + slotsNeeded <= 8 && appCall.accounts.length + needsAccountSlot <= 4) {
                  if (needsAppSlot > 0) {
                    appCall.foreignApps.push(appIdBigInt);
                  }
                  if (needsAccountSlot > 0) {
                    const addrObj = algosdk.Address.fromString(accountAddr);
                    appCall.accounts.push(addrObj);
                  }
                  distributed = true;
                  if (DEBUG) console.log(`[Verification] Distributed appLocal pair to txn ${idx}: app=${appId}, account=${accountAddr}`);
                  break;
                }
              }

              if (!distributed) {
                console.warn(`[Verification] Could not distribute appLocal pair - no transaction has room for both: app=${appId}, account=${accountAddr}`);
              }
            }

            // CRITICAL: Distribute holding pairs - both asset AND account MUST be in the SAME transaction
            // This is similar to appLocal pairs but for asset holdings
            // IMPORTANT: We must prioritize adding holding pairs to the transaction that NEEDS them,
            // which is the pool transaction that corresponds to the account address (pool app address)
            for (const { asset: assetId, account: accountAddr } of newlyDiscoveredHoldingPairs) {
              let distributed = false;
              const assetIdBigInt = BigInt(assetId);

              // Try to find the transaction whose appIndex corresponds to this pool address
              // The account address in holding pairs is often the pool's app address (contract checking its own balance)
              let targetPoolAppIndex = null;
              try {
                // Check if any of our app call transactions match this account as their pool address
                for (const { txn, appCall, idx } of appCallTxnsForVerify) {
                  const appIndex = txn.appIndex || appCall.appIndex;
                  if (appIndex) {
                    const poolAppAddress = algosdk.getApplicationAddress(Number(appIndex)).toString();
                    if (poolAppAddress === accountAddr) {
                      targetPoolAppIndex = Number(appIndex);
                      if (DEBUG) console.log(`[Verification] Holding pair account ${accountAddr} matches pool app ${targetPoolAppIndex}`);
                      break;
                    }
                  }
                }
              } catch (e) {
                // Ignore errors in pool address matching
              }

              // First pass: Try to add to the MATCHING pool transaction (highest priority)
              if (targetPoolAppIndex !== null) {
                for (const { txn, appCall, idx } of appCallTxnsForVerify) {
                  const appIndex = Number(txn.appIndex || appCall.appIndex || 0);
                  if (appIndex !== targetPoolAppIndex) continue;

                  // Check if asset is already present in foreignAssets
                  const hasAsset = appCall.foreignAssets.some(a => BigInt(a) === assetIdBigInt);

                  // Check if account is already present
                  const hasAccount = appCall.accounts.some(a => {
                    const aStr = typeof a === 'string' ? a : a.toString();
                    return aStr === accountAddr;
                  });

                  const needsAssetSlot = !hasAsset ? 1 : 0;
                  const needsAccountSlot = !hasAccount ? 1 : 0;
                  const currentRefs = appCall.boxes.length + appCall.foreignApps.length + appCall.foreignAssets.length + appCall.accounts.length;
                  const slotsNeeded = needsAssetSlot + needsAccountSlot;

                  // Check if we have room for both (8 max total, 4 max accounts)
                  if (currentRefs + slotsNeeded <= 8 && appCall.accounts.length + needsAccountSlot <= 4) {
                    if (needsAssetSlot > 0) {
                      appCall.foreignAssets.push(assetIdBigInt);
                    }
                    if (needsAccountSlot > 0) {
                      const addrObj = algosdk.Address.fromString(accountAddr);
                      appCall.accounts.push(addrObj);
                    }
                    distributed = true;
                    if (DEBUG) console.log(`[Verification] Distributed holding pair to MATCHING pool txn ${idx} (app ${targetPoolAppIndex}): asset=${assetId}, account=${accountAddr}`);
                    break;
                  } else {
                    if (DEBUG) console.log(`[Verification] Matching pool txn ${idx} (app ${targetPoolAppIndex}) has no room for holding pair`);
                  }
                }
              }

              // Second pass: Fall back to any transaction with room (original behavior)
              if (!distributed) {
                for (const { appCall, idx } of appCallTxnsForVerify) {
                  // Check if asset is already present in foreignAssets
                  const hasAsset = appCall.foreignAssets.some(a => BigInt(a) === assetIdBigInt);

                  // Check if account is already present
                  const hasAccount = appCall.accounts.some(a => {
                    const aStr = typeof a === 'string' ? a : a.toString();
                    return aStr === accountAddr;
                  });

                  const needsAssetSlot = !hasAsset ? 1 : 0;
                  const needsAccountSlot = !hasAccount ? 1 : 0;
                  const currentRefs = appCall.boxes.length + appCall.foreignApps.length + appCall.foreignAssets.length + appCall.accounts.length;
                  const slotsNeeded = needsAssetSlot + needsAccountSlot;

                  // Check if we have room for both (8 max total, 4 max accounts)
                  if (currentRefs + slotsNeeded <= 8 && appCall.accounts.length + needsAccountSlot <= 4) {
                    if (needsAssetSlot > 0) {
                      appCall.foreignAssets.push(assetIdBigInt);
                    }
                    if (needsAccountSlot > 0) {
                      const addrObj = algosdk.Address.fromString(accountAddr);
                      appCall.accounts.push(addrObj);
                    }
                    distributed = true;
                    if (DEBUG) console.log(`[Verification] Distributed holding pair to fallback txn ${idx}: asset=${assetId}, account=${accountAddr}`);
                    break;
                  }
                }
              }

              if (!distributed) {
                console.warn(`[Verification] Could not distribute holding pair - no transaction has room for both: asset=${assetId}, account=${accountAddr}`);
              }
            }

            // Distribute only newly discovered apps (not all cumulative)
            // Skip apps that were already added as part of appLocal pairs
            for (const appId of newlyDiscoveredApps) {
              let distributed = false;
              const appIdBigInt = BigInt(appId);
              for (const { appCall } of appCallTxnsForVerify) {
                const currentRefs = appCall.boxes.length + appCall.foreignApps.length + appCall.foreignAssets.length + appCall.accounts.length;
                const alreadyHas = appCall.foreignApps.some(a => BigInt(a) === appIdBigInt);
                if (currentRefs < 8 && !alreadyHas) {
                  appCall.foreignApps.push(appIdBigInt);
                  distributed = true;
                  if (DEBUG) console.log(`[Verification] Distributed app ${appId} to transaction`);
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
              const assetIdBigInt = BigInt(assetId);
              for (const { appCall } of appCallTxnsForVerify) {
                const currentRefs = appCall.boxes.length + appCall.foreignApps.length + appCall.foreignAssets.length + appCall.accounts.length;
                const alreadyHas = appCall.foreignAssets.some(a => BigInt(a) === assetIdBigInt);
                if (currentRefs < 8 && !alreadyHas) {
                  appCall.foreignAssets.push(assetIdBigInt);
                  distributed = true;
                  if (DEBUG) console.log(`[Verification] Distributed asset ${assetId} to transaction`);
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
              for (const { appCall } of appCallTxnsForVerify) {
                const currentRefs = appCall.boxes.length + appCall.foreignApps.length + appCall.foreignAssets.length + appCall.accounts.length;
                const currentAccounts = appCall.accounts.length;
                // Check if already has this account
                const alreadyHas = appCall.accounts.some(a => {
                  const aStr = typeof a === 'string' ? a : a.toString();
                  return aStr === accountAddr;
                });
                if (currentRefs < 8 && currentAccounts < 4 && !alreadyHas) {
                  // Convert string address to Address object for algosdk 3.x
                  const addrObj = algosdk.Address.fromString(accountAddr);
                  appCall.accounts.push(addrObj);
                  distributed = true;
                  if (DEBUG) console.log(`[Verification] Distributed account ${accountAddr} to transaction`);
                  break;
                }
              }
              if (!distributed) {
                console.warn(`[Verification] Could not distribute account ${accountAddr} - all transactions at reference/account limit`);
              }
            }

            // Distribute only newly discovered boxes
            // In algosdk 3.x, boxes/foreignApps are under txn.applicationCall
            for (const box of newlyDiscoveredBoxes) {
              let distributed = false;
              for (const { appCall } of appCallTxnsForVerify) {
                const currentRefs = appCall.boxes.length + appCall.foreignApps.length + appCall.foreignAssets.length + appCall.accounts.length;
                // Adding box needs 1 ref + maybe 1 for foreignApp
                const boxAppIdBigInt = BigInt(box.appIndex);
                const needsForeignApp = !appCall.foreignApps.some(a => BigInt(a) === boxAppIdBigInt);
                const additionalRefs = 1 + (needsForeignApp ? 1 : 0);
                if (currentRefs + additionalRefs <= 8) {
                  appCall.boxes.push({
                    appIndex: boxAppIdBigInt,
                    name: box.name
                  });
                  if (needsForeignApp) {
                    appCall.foreignApps.push(boxAppIdBigInt);
                  }
                  distributed = true;
                  if (DEBUG) console.log(`[Verification] Distributed box app=${box.appIndex} to transaction`);
                  break;
                }
              }
              if (!distributed) {
                console.warn(`[Verification] Could not distribute box app=${box.appIndex} - all transactions at reference limit`);
              }
            }

            if (DEBUG) console.log(`[Verification] Iteration ${verifyIteration + 1}: Found ${newResourcesFound} new resources, retrying...`);
          } catch (verifyError) {
            // Verification simulation call itself failed (might be 413 or other error) - stop
            // iterating, but remember this so we can report it honestly below instead of silently
            // treating the group as verified.
            console.error(`[Verification] Simulation call failed: ${verifyError.message}`);
            lastVerifyFailureText = verifyError.message;
            break;
          }
        }

        // If strict verification (allowUnnamedResources: false) never actually succeeded - either
        // it kept finding new required resources until MAX_VERIFY_ITERATIONS was exhausted, or the
        // verify call itself errored out - the group has NOT been confirmed to carry every
        // reference the AVM will require. Encoding and returning it anyway would hand the caller a
        // transaction group that looks complete but will likely revert on submission. Fail the
        // request instead (see task acceptance criteria: prefer failing over returning known-
        // incomplete groups).
        if (!verificationPassed && lastVerifyFailureText) {
          const failureSummary = typeof lastVerifyFailureText === 'string'
            ? lastVerifyFailureText.substring(0, 300)
            : String(lastVerifyFailureText);
          console.error(`[Verification] Strict verification did not converge after ${MAX_VERIFY_ITERATIONS} iterations: ${failureSummary}`);
          simulationErrorMessage = `Strict resource verification did not converge: ${failureSummary}`;
          throw new Error(`Strict resource verification did not converge after ${MAX_VERIFY_ITERATIONS} iterations: ${failureSummary}`);
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

          // In algosdk 3.x, resources are under txn.applicationCall
          const appCall = txn.applicationCall || txn;

          // Get per-transaction unnamedResourcesAccessed
          const txnUnnamed = txnResult.unnamedResourcesAccessed || {};
          const txnApps = txnUnnamed.apps || [];
          const txnAssets = txnUnnamed.assets || [];
          const txnAccounts = txnUnnamed.accounts || [];

          // Log per-transaction resources
          if (txnApps.length > 0 || txnAssets.length > 0 || txnAccounts.length > 0) {
            if (DEBUG) console.log(`[Simulation] Txn ${i} (app ${appCall.appIndex}) unnamedResourcesAccessed: apps=${JSON.stringify(txnApps)}, assets=${JSON.stringify(txnAssets)}, accounts=${JSON.stringify(txnAccounts)}`);
          }

          // Initialize arrays if they don't exist
          if (!appCall.foreignApps) appCall.foreignApps = [];
          if (!appCall.foreignAssets) appCall.foreignAssets = [];
          if (!appCall.accounts) appCall.accounts = [];
          if (!appCall.boxes) appCall.boxes = [];

          // Add apps that this SPECIFIC transaction needs (only if not already present)
          for (const appId of txnApps) {
            const appIdBigInt = BigInt(appId);
            if (!appCall.foreignApps.some(a => BigInt(a) === appIdBigInt)) {
              // Check if adding this app would exceed the 8 reference limit
              const currentBoxes = appCall.boxes.length;
              const currentForeignApps = appCall.foreignApps.length;
              const currentForeignAssets = appCall.foreignAssets.length;
              const currentAccounts = appCall.accounts.length;
              const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;

              if (totalReferences < 8) {
                appCall.foreignApps.push(appIdBigInt);
              }
            }
          }

          // Add assets that this SPECIFIC transaction needs (only if not already present)
          for (const assetId of txnAssets) {
            const assetIdBigInt = BigInt(assetId);
            if (!appCall.foreignAssets.some(a => BigInt(a) === assetIdBigInt)) {
              // Check if adding this asset would exceed the 8 reference limit
              const currentBoxes = appCall.boxes.length;
              const currentForeignApps = appCall.foreignApps.length;
              const currentForeignAssets = appCall.foreignAssets.length;
              const currentAccounts = appCall.accounts.length;
              const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;

              if (totalReferences < 8) {
                appCall.foreignAssets.push(assetIdBigInt);
              }
            }
          }

          // Add accounts that this SPECIFIC transaction needs (only if not already present)
          // This is CRITICAL for asset holdings - the account must be in the accounts array
          for (const account of txnAccounts) {
            const accountAddr = typeof account === 'string' ? account : new algosdk.Address(account).toString();
            const alreadyInTxn = appCall.accounts.some(acc => {
              const accStr = typeof acc === 'string' ? acc : acc.toString();
              return accStr === accountAddr;
            });
            if (!alreadyInTxn) {
              // Check if adding this account would exceed limits
              const currentBoxes = appCall.boxes.length;
              const currentForeignApps = appCall.foreignApps.length;
              const currentForeignAssets = appCall.foreignAssets.length;
              const currentAccounts = appCall.accounts.length;
              const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;

              // Check both total references (8) and accounts limit (4)
              if (totalReferences < 8 && currentAccounts < 4) {
                appCall.accounts.push(algosdk.Address.fromString(accountAddr));
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
            const appAddress = algosdk.getApplicationAddress(appId).toString();
            uniqueAccounts.add(appAddress);
          }
        }

        // Also add application addresses for apps discovered in unnamedResourcesAccessed
        const groupUnnamedApps = txnGroup?.unnamedResourcesAccessed?.apps || [];
        for (const appId of groupUnnamedApps) {
          const appIdNum = typeof appId === 'number' ? appId : Number(appId);
          if (appIdNum > 0) {
            uniqueForeignApps.add(appIdNum);
            const appAddress = algosdk.getApplicationAddress(appIdNum).toString();
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
            uniqueAccounts.add(algosdk.getApplicationAddress(poolId).toString());
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
            uniqueAccounts.add(algosdk.getApplicationAddress(factoryAppId).toString());
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
                uniqueAccounts.add(algosdk.getApplicationAddress(wrappedNum).toString());
              }
            }
            // Also add wrappedPair tokens
            const wrappedPair = split.poolCfg?.tokens?.wrappedPair || {};
            if (wrappedPair.tokA > 0) {
              uniqueForeignApps.add(wrappedPair.tokA);
              uniqueAccounts.add(algosdk.getApplicationAddress(wrappedPair.tokA).toString());
            }
            if (wrappedPair.tokB > 0) {
              uniqueForeignApps.add(wrappedPair.tokB);
              uniqueAccounts.add(algosdk.getApplicationAddress(wrappedPair.tokB).toString());
            }

            // CRITICAL: For pure ARC200 input tokens, add the pool's balance box on the input token
            // When a HumbleSwap pool calls arc200_transferFrom(user, pool, amount),
            // the inner transaction needs access to the pool's balance box on that ARC200 token
            //
            // Resolve inputWrapped using the same logic as resolveWrappedTokens:
            // If input is not in underlyingToWrapped map, it's already wrapped (pure ARC200)
            const u2w = split.poolCfg?.tokens?.underlyingToWrapped || {};
            const inputWrapped = u2w[String(inputNum)] ?? u2w[inputNum] ?? inputNum;
            const inputWrappedNum = Number(inputWrapped);

            const inputType = determineTokenTypeForHumbleswap(String(inputNum), String(inputWrappedNum));
            if (DEBUG) console.log(`[HumbleSwap Resources] inputNum=${inputNum}, inputWrappedNum=${inputWrappedNum}, inputType=${inputType}, poolId=${poolId}`);
            if (inputType === 'ARC200' && inputWrappedNum > 0) {
              // Add the pool's balance box for the input ARC200 token
              const balancesPrefix = Buffer.from('balances', 'utf-8');
              const poolAddress = algosdk.getApplicationAddress(poolId).toString();
              const poolAddressBytes = algosdk.Address.fromString(poolAddress).publicKey;
              const poolBalanceBoxName = new Uint8Array(Buffer.concat([balancesPrefix, poolAddressBytes]));
              const boxKey = `${inputWrappedNum}:${Buffer.from(poolBalanceBoxName).toString('hex')}`;

              if (DEBUG) console.log(`[HumbleSwap] Pool balance box key: ${boxKey.substring(0, 50)}..., exists=${uniqueBoxes.has(boxKey)}`);
              if (!uniqueBoxes.has(boxKey)) {
                uniqueBoxes.set(boxKey, { appIndex: inputWrappedNum, name: poolBalanceBoxName, txnIndex: 0 });
                uniqueForeignApps.add(inputWrappedNum);
                if (DEBUG) console.log(`[HumbleSwap] Added pool's balance box for ARC200 input token ${inputWrappedNum}`);
              }

              // Also add the user's balance box on the input ARC200 token
              const userAddressBytes = algosdk.Address.fromString(address).publicKey;
              const userBalanceBoxName = new Uint8Array(Buffer.concat([balancesPrefix, userAddressBytes]));
              const userBoxKey = `${inputWrappedNum}:${Buffer.from(userBalanceBoxName).toString('hex')}`;

              if (!uniqueBoxes.has(userBoxKey)) {
                uniqueBoxes.set(userBoxKey, { appIndex: inputWrappedNum, name: userBalanceBoxName, txnIndex: 0 });
                if (DEBUG) console.log(`[HumbleSwap] Added user's balance box for ARC200 input token ${inputWrappedNum}`);
              }
            }
          }
        }

        // Log what we've collected
        if (DEBUG) console.log(`[Resources] Collected: apps=${Array.from(uniqueForeignApps).length}, assets=${Array.from(uniqueForeignAssets).length}, accounts=${Array.from(uniqueAccounts).length}`);

        // Collect all unique foreignApps, foreignAssets, accounts, and appLocals from simulation
        // Also check group-level unnamedResourcesAccessed
        const groupUnnamed = txnGroup?.unnamedResourcesAccessed || {};
        const groupApps = groupUnnamed.apps || [];
        const groupAssets = groupUnnamed.assets || [];
        const groupAccounts = groupUnnamed.accounts || [];
        const groupAppLocals = groupUnnamed.appLocals || [];
        const groupAssetHoldings = groupUnnamed.assetHoldings || [];

        // Track appLocals separately - these are {app, account} pairs that MUST be in the same transaction
        // for local state access to work correctly
        const appLocalPairs = [];

        // Track assetHoldings separately - these are {asset, account} pairs that MUST be in the same transaction
        // for asset holding access to work correctly (similar to appLocals)
        const assetHoldingPairs = [];

        for (const appId of groupApps) {
          const appIdNum = typeof appId === 'number' ? appId : Number(appId);
          uniqueForeignApps.add(appIdNum);
        }

        for (const assetId of groupAssets) {
          const assetIdNum = typeof assetId === 'number' ? assetId : Number(assetId);
          uniqueForeignAssets.add(assetIdNum);
        }

        for (const account of groupAccounts) {
          const accountAddr = typeof account === 'string' ? account : new algosdk.Address(account).toString();
          uniqueAccounts.add(accountAddr);
        }

        // Extract appLocals from group-level unnamedResourcesAccessed
        // Each appLocal has {app, account} and BOTH must be in the same transaction for local state access
        for (const appLocal of groupAppLocals) {
          const appId = typeof appLocal.app === 'number' ? appLocal.app : Number(appLocal.app);
          const accountAddr = typeof appLocal.account === 'string' ? appLocal.account : new algosdk.Address(appLocal.account).toString();
          appLocalPairs.push({ app: appId, account: accountAddr });
          uniqueForeignApps.add(appId);
          uniqueAccounts.add(accountAddr);
          if (DEBUG) console.log(`[Simulation] Discovered appLocal: app=${appId}, account=${accountAddr}`);
        }

        // Extract assetHoldings from group-level unnamedResourcesAccessed
        // Each assetHolding has {asset, account} and BOTH must be in the same transaction for asset holding access
        for (const assetHolding of groupAssetHoldings) {
          const assetId = typeof assetHolding.asset === 'number' ? assetHolding.asset : Number(assetHolding.asset);
          const accountAddr = typeof assetHolding.account === 'string' ? assetHolding.account : new algosdk.Address(assetHolding.account).toString();
          assetHoldingPairs.push({ asset: assetId, account: accountAddr });
          uniqueForeignAssets.add(assetId);
          uniqueAccounts.add(accountAddr);
          if (DEBUG) console.log(`[Simulation] Discovered assetHolding: asset=${assetId}, account=${accountAddr}`);
        }

        for (let i = 0; i < txnResults.length && i < allTransactions.length; i++) {
          const txnResult = txnResults[i];
          const txnUnnamed = txnResult.unnamedResourcesAccessed || {};
          const txnApps = txnUnnamed.apps || [];
          const txnAssets = txnUnnamed.assets || [];
          const txnAccounts = txnUnnamed.accounts || [];
          const txnAppLocals = txnUnnamed.appLocals || [];
          const txnAssetHoldings = txnUnnamed.assetHoldings || [];

          for (const appId of txnApps) {
            const appIdNum = typeof appId === 'number' ? appId : Number(appId);
            uniqueForeignApps.add(appIdNum);
          }

          for (const assetId of txnAssets) {
            const assetIdNum = typeof assetId === 'number' ? assetId : Number(assetId);
            uniqueForeignAssets.add(assetIdNum);
          }

          for (const account of txnAccounts) {
            const accountAddr = typeof account === 'string' ? account : new algosdk.Address(account).toString();
            uniqueAccounts.add(accountAddr);
          }

          // Extract appLocals from per-transaction unnamedResourcesAccessed
          for (const appLocal of txnAppLocals) {
            const appId = typeof appLocal.app === 'number' ? appLocal.app : Number(appLocal.app);
            const accountAddr = typeof appLocal.account === 'string' ? appLocal.account : new algosdk.Address(appLocal.account).toString();
            appLocalPairs.push({ app: appId, account: accountAddr });
            uniqueForeignApps.add(appId);
            uniqueAccounts.add(accountAddr);
            if (DEBUG) console.log(`[Simulation] Txn ${i} discovered appLocal: app=${appId}, account=${accountAddr}`);
          }

          // Extract assetHoldings from per-transaction unnamedResourcesAccessed
          for (const assetHolding of txnAssetHoldings) {
            const assetId = typeof assetHolding.asset === 'number' ? assetHolding.asset : Number(assetHolding.asset);
            const accountAddr = typeof assetHolding.account === 'string' ? assetHolding.account : new algosdk.Address(assetHolding.account).toString();
            assetHoldingPairs.push({ asset: assetId, account: accountAddr });
            uniqueForeignAssets.add(assetId);
            uniqueAccounts.add(accountAddr);
            if (DEBUG) console.log(`[Simulation] Txn ${i} discovered assetHolding: asset=${assetId}, account=${accountAddr}`);
          }
        }
        
        // Also collect foreignApps and foreignAssets that are already in transactions
        // This is important because some foreignApps (like beacon ID, factory app 411751) are set during transaction building
        // In algosdk 3.x, these are under txn.applicationCall, not directly on txn
        for (let i = 0; i < allTransactions.length; i++) {
          const txn = allTransactions[i];
          if (txn.type === 'appl') {
            const appCall = txn.applicationCall || txn;
            const existingForeignApps = appCall.foreignApps || [];
            const existingForeignAssets = appCall.foreignAssets || [];
            if (existingForeignApps.length > 0) {
              if (DEBUG) console.log(`[CollectExisting] Txn ${i} (app ${appCall.appIndex}): foreignApps=${existingForeignApps.map(a => Number(a))}`);
              for (const appId of existingForeignApps) {
                const appIdNum = typeof appId === 'number' ? appId : Number(appId);
                uniqueForeignApps.add(appIdNum);
              }
            }
            if (existingForeignAssets.length > 0) {
              for (const assetId of existingForeignAssets) {
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
          const creatorAddr = await getAppCreatorAddress(appId);
          if (creatorAddr) {
            appToCreatorAccount.set(appId, creatorAddr);
            // Also add to uniqueAccounts for tracking
            uniqueAccounts.add(creatorAddr);
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
        // Initialize arrays for all transactions first - BUT ONLY IF NOT ALREADY SET
        // In algosdk 3.x, these are under txn.applicationCall, not directly on txn
        // CRITICAL: Do NOT overwrite existing arrays - they contain resources set during transaction building!
        for (const { txn } of appCallTxns) {
          const appCall = txn.applicationCall || txn;
          if (!appCall.boxes) appCall.boxes = [];
          if (!appCall.foreignApps) appCall.foreignApps = [];
          if (!appCall.foreignAssets) appCall.foreignAssets = [];
          if (!appCall.accounts) appCall.accounts = [];
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
          // In algosdk 3.x, boxes are under txn.applicationCall
          const boxNameHex = Buffer.from(box.name).toString('hex');
          const alreadyInGroup = appCallTxns.some(({ txn }) => {
            const appCall = txn.applicationCall || txn;
            const boxes = appCall.boxes || [];
            return boxes.some(b => {
              const bAppIndex = typeof b.appIndex === 'number' ? b.appIndex : Number(b.appIndex);
              const bNameHex = Buffer.from(b.name).toString('hex');
              return bAppIndex === box.appIndex && bNameHex === boxNameHex;
            });
          });
          if (alreadyInGroup) {
            continue; // Already accessible to all transactions via group sharing
          }

          // Helper function to try adding box to a specific transaction
          // In algosdk 3.x, boxes/foreignApps/etc are under txn.applicationCall
          const tryAddBoxToTxn = (txn) => {
            const appCall = txn.applicationCall || txn;
            const boxes = appCall.boxes || [];
            const foreignApps = appCall.foreignApps || [];
            const foreignAssets = appCall.foreignAssets || [];
            const accounts = appCall.accounts || [];
            const currentBoxes = boxes.length;
            const currentForeignApps = foreignApps.length;
            const currentForeignAssets = foreignAssets.length;
            const currentAccounts = accounts.length;
            const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;

            // Check if adding this box would exceed the limit
            const boxAppIndexBigInt = BigInt(box.appIndex);
            const needsForeignApp = !foreignApps.some(a => BigInt(a) === boxAppIndexBigInt);
            const additionalReferences = 1 + (needsForeignApp ? 1 : 0);

            if (totalReferences + additionalReferences <= 8) {
              // Add the box to applicationCall
              if (!appCall.boxes) appCall.boxes = [];
              appCall.boxes.push({
                appIndex: boxAppIndexBigInt,
                name: box.name
              });

              // Add foreignApp if needed
              if (needsForeignApp) {
                if (!appCall.foreignApps) appCall.foreignApps = [];
                appCall.foreignApps.push(boxAppIndexBigInt);
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
                if (DEBUG) console.log(`[BoxDistribution] Added box (${boxPrefix}...) to txn ${box.txnIndex} (target)`);
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
                  if (DEBUG) console.log(`[BoxDistribution] Added box (${boxPrefix}...) to txn ${idx} (earlier fallback, wanted ${box.txnIndex})`);
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
                if (DEBUG) console.log(`[BoxDistribution] Added box (${boxPrefix}...) to txn ${idx} (last resort fallback, wanted ${box.txnIndex})`);
                break;
              }
            }
          }

          if (!added) {
            const boxPrefix = Buffer.from(box.name).slice(0, 9).toString('utf8').replace(/[^\x20-\x7E]/g, '?');
            if (DEBUG) console.log(`[BoxDistribution] WARNING: Could not add box (${boxPrefix}...) to any transaction - will create resource carrier`);
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
          if (DEBUG) console.log(`[ResourceCarrier] Creating resource carrier transaction for ${overflowBoxes.length} overflow box(es)`);

          // Get suggested params for the new transaction
          const suggestedParams = await getSuggestedParams();

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
          const addressArg = algosdk.Address.fromString(address).publicKey;

          resourceCarrierTxn = algosdk.makeApplicationCallTxnFromObject({
            sender: address,
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

          if (DEBUG) console.log(`[ResourceCarrier] Created carrier txn with ${carrierBoxes.length} boxes, app ${carrierAppId} (arc200_balanceOf)`);

          // PREPEND the resource carrier to the transaction list
          // This ensures all boxes are available to subsequent transactions
          allTransactions.unshift(resourceCarrierTxn);

          // Update appCallTxns to include the new carrier transaction
          // Re-map indices since we prepended a transaction
          appCallTxns.unshift({ txn: resourceCarrierTxn, idx: 0 });
          for (let i = 1; i < appCallTxns.length; i++) {
            appCallTxns[i].idx += 1; // Shift all other indices by 1
          }

          if (DEBUG) console.log(`[ResourceCarrier] Prepended carrier txn, group now has ${allTransactions.length} transactions`);
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
        // In algosdk 3.x, foreignApps are under txn.applicationCall
        for (const appId of allUniqueForeignApps) {
          // Check if already in any transaction (group resource sharing)
          const appIdBigInt = BigInt(appId);
          const alreadyInGroup = appCallTxns.some(({ txn }) => {
            const appCall = txn.applicationCall || txn;
            const foreignApps = appCall.foreignApps || [];
            return foreignApps.some(a => BigInt(a) === appIdBigInt);
          });
          if (alreadyInGroup) {
            continue; // Already accessible to all transactions via group sharing
          }

          // First, try to add to transactions that need this app (from error messages)
          let added = false;
          for (const { txn, idx } of appCallTxns) {
            const appCall = txn.applicationCall || txn;
            const txnAppId = Number(appCall.appIndex || 0);
            if (txnAppToNeededApps.has(txnAppId) && txnAppToNeededApps.get(txnAppId).has(appId)) {
              // This transaction needs this app!
              const boxes = appCall.boxes || [];
              const foreignApps = appCall.foreignApps || [];
              const foreignAssets = appCall.foreignAssets || [];
              const accounts = appCall.accounts || [];
              const totalReferences = boxes.length + foreignApps.length + foreignAssets.length + accounts.length;

              if (totalReferences < 8) {
                if (!appCall.foreignApps) appCall.foreignApps = [];
                appCall.foreignApps.push(appIdBigInt);
                added = true;
                break;
              }
            }
          }

          // If not added to a specific transaction, add to first transaction with room
          if (!added) {
            for (const { txn, idx } of appCallTxns) {
              const appCall = txn.applicationCall || txn;
              const boxes = appCall.boxes || [];
              const foreignApps = appCall.foreignApps || [];
              const foreignAssets = appCall.foreignAssets || [];
              const accounts = appCall.accounts || [];
              const totalReferences = boxes.length + foreignApps.length + foreignAssets.length + accounts.length;

              if (totalReferences < 8) {
                if (!appCall.foreignApps) appCall.foreignApps = [];
                appCall.foreignApps.push(appIdBigInt);
                added = true;
                break;
              }
            }
          }
        }
        
        // NOTE: Removed hardcoded logic for app 395642 + pool 395553
        // The verification simulation loop should discover any missing foreign apps dynamically
        // via error messages like "unavailable App XXXXX"

        // CRITICAL: Distribute appLocal pairs - both app AND account MUST be in the SAME transaction
        // for local state access to work. Unlike other resources, appLocals don't work with group sharing -
        // you must have both the app in foreignApps AND the account in accounts in the same transaction.
        // This is because the AVM needs to look up local state for (app, account) which requires both present.
        for (const appLocal of appLocalPairs) {
          const appId = appLocal.app;
          const accountAddr = appLocal.account;
          const appIdBigInt = BigInt(appId);

          // Check if this pair is already in any transaction
          let pairInGroup = false;
          for (const { txn } of appCallTxns) {
            const appCall = txn.applicationCall || txn;
            const foreignApps = appCall.foreignApps || [];
            const accounts = appCall.accounts || [];

            // App is in foreignApps either if the appId matches OR if it's the transaction's own appIndex
            const txnAppId = Number(appCall.appIndex || 0);
            const hasApp = txnAppId === appId || foreignApps.some(a => Number(a) === appId);

            const hasAccount = accounts.some(acc => {
              const accStr = typeof acc === 'string' ? acc : new algosdk.Address(acc).toString();
              return accStr === accountAddr;
            });

            if (hasApp && hasAccount) {
              pairInGroup = true;
              break;
            }
          }

          if (pairInGroup) {
            if (DEBUG) console.log(`[AppLocal] Pair already in group: app=${appId}, account=${accountAddr}`);
            continue;
          }

          // Find a transaction where we can add BOTH the app and account together
          // Prefer transactions that already have the app in foreignApps or where the appIndex matches
          let added = false;
          for (const { txn, idx } of appCallTxns) {
            const appCall = txn.applicationCall || txn;
            const boxes = appCall.boxes || [];
            const foreignApps = appCall.foreignApps || [];
            const foreignAssets = appCall.foreignAssets || [];
            const accounts = appCall.accounts || [];

            // Check if this transaction's appIndex is the app we need (implicit foreignApp)
            const txnAppId = Number(appCall.appIndex || 0);
            const hasApp = txnAppId === appId || foreignApps.some(a => Number(a) === appId);

            // Calculate how many slots we need
            const needsAppSlot = !hasApp ? 1 : 0;
            const hasAccount = accounts.some(acc => {
              const accStr = typeof acc === 'string' ? acc : new algosdk.Address(acc).toString();
              return accStr === accountAddr;
            });
            const needsAccountSlot = !hasAccount ? 1 : 0;

            const currentReferences = boxes.length + foreignApps.length + foreignAssets.length + accounts.length;
            const slotsNeeded = needsAppSlot + needsAccountSlot;

            // Check if we have room for both (8 max total, 4 max accounts)
            if (currentReferences + slotsNeeded <= 8 && accounts.length + needsAccountSlot <= 4) {
              // Add app if needed
              if (needsAppSlot > 0) {
                if (!appCall.foreignApps) appCall.foreignApps = [];
                appCall.foreignApps.push(appIdBigInt);
              }
              // Add account if needed
              if (needsAccountSlot > 0) {
                if (!appCall.accounts) appCall.accounts = [];
                appCall.accounts.push(accountAddr);
              }
              if (DEBUG) console.log(`[AppLocal] Added pair to txn ${idx}: app=${appId}, account=${accountAddr}`);
              added = true;
              break;
            }
          }

          if (!added) {
            if (DEBUG) console.log(`[AppLocal] WARN: Could not add pair to any transaction: app=${appId}, account=${accountAddr}`);
          }
        }

        // CRITICAL: Distribute assetHolding pairs - both asset AND account MUST be in the SAME transaction
        // for asset holding access to work. This is similar to appLocals but for asset holdings.
        // We prioritize adding to the transaction whose pool address matches the account (for pool balance checks).
        for (const assetHolding of assetHoldingPairs) {
          const assetId = assetHolding.asset;
          const accountAddr = assetHolding.account;
          const assetIdBigInt = BigInt(assetId);

          // Check if this pair is already in any transaction
          let pairInGroup = false;
          for (const { txn } of appCallTxns) {
            const appCall = txn.applicationCall || txn;
            const foreignAssets = appCall.foreignAssets || [];
            const accounts = appCall.accounts || [];

            const hasAsset = foreignAssets.some(a => BigInt(a) === assetIdBigInt);
            const hasAccount = accounts.some(acc => {
              const accStr = typeof acc === 'string' ? acc : new algosdk.Address(acc).toString();
              return accStr === accountAddr;
            });

            if (hasAsset && hasAccount) {
              pairInGroup = true;
              break;
            }
          }

          if (pairInGroup) {
            if (DEBUG) console.log(`[AssetHolding] Pair already in group: asset=${assetId}, account=${accountAddr}`);
            continue;
          }

          // Try to find the transaction whose appIndex corresponds to this account as pool address
          // This is important when the account is a pool's app address checking its own balance
          let targetPoolAppIndex = null;
          try {
            for (const { txn, appCall } of appCallTxns) {
              const appIndex = txn.appIndex || appCall.appIndex;
              if (appIndex) {
                const poolAppAddress = algosdk.getApplicationAddress(Number(appIndex)).toString();
                if (poolAppAddress === accountAddr) {
                  targetPoolAppIndex = Number(appIndex);
                  if (DEBUG) console.log(`[AssetHolding] Account ${accountAddr} matches pool app ${targetPoolAppIndex}`);
                  break;
                }
              }
            }
          } catch (e) {
            // Ignore errors in pool address matching
          }

          // First pass: Try to add to the MATCHING pool transaction (highest priority)
          let added = false;
          if (targetPoolAppIndex !== null) {
            for (const { txn, idx } of appCallTxns) {
              const appCall = txn.applicationCall || txn;
              const appIndex = Number(txn.appIndex || appCall.appIndex || 0);
              if (appIndex !== targetPoolAppIndex) continue;

              const boxes = appCall.boxes || [];
              const foreignApps = appCall.foreignApps || [];
              const foreignAssets = appCall.foreignAssets || [];
              const accounts = appCall.accounts || [];

              const hasAsset = foreignAssets.some(a => BigInt(a) === assetIdBigInt);
              const hasAccount = accounts.some(acc => {
                const accStr = typeof acc === 'string' ? acc : new algosdk.Address(acc).toString();
                return accStr === accountAddr;
              });

              const needsAssetSlot = !hasAsset ? 1 : 0;
              const needsAccountSlot = !hasAccount ? 1 : 0;
              const currentReferences = boxes.length + foreignApps.length + foreignAssets.length + accounts.length;
              const slotsNeeded = needsAssetSlot + needsAccountSlot;

              if (currentReferences + slotsNeeded <= 8 && accounts.length + needsAccountSlot <= 4) {
                if (needsAssetSlot > 0) {
                  if (!appCall.foreignAssets) appCall.foreignAssets = [];
                  appCall.foreignAssets.push(assetIdBigInt);
                }
                if (needsAccountSlot > 0) {
                  if (!appCall.accounts) appCall.accounts = [];
                  appCall.accounts.push(accountAddr);
                }
                if (DEBUG) console.log(`[AssetHolding] Added pair to MATCHING pool txn ${idx} (app ${targetPoolAppIndex}): asset=${assetId}, account=${accountAddr}`);
                added = true;
                break;
              }
            }
          }

          // Second pass: Fall back to any transaction with room
          if (!added) {
            for (const { txn, idx } of appCallTxns) {
              const appCall = txn.applicationCall || txn;
              const boxes = appCall.boxes || [];
              const foreignApps = appCall.foreignApps || [];
              const foreignAssets = appCall.foreignAssets || [];
              const accounts = appCall.accounts || [];

              const hasAsset = foreignAssets.some(a => BigInt(a) === assetIdBigInt);
              const hasAccount = accounts.some(acc => {
                const accStr = typeof acc === 'string' ? acc : new algosdk.Address(acc).toString();
                return accStr === accountAddr;
              });

              const needsAssetSlot = !hasAsset ? 1 : 0;
              const needsAccountSlot = !hasAccount ? 1 : 0;
              const currentReferences = boxes.length + foreignApps.length + foreignAssets.length + accounts.length;
              const slotsNeeded = needsAssetSlot + needsAccountSlot;

              if (currentReferences + slotsNeeded <= 8 && accounts.length + needsAccountSlot <= 4) {
                if (needsAssetSlot > 0) {
                  if (!appCall.foreignAssets) appCall.foreignAssets = [];
                  appCall.foreignAssets.push(assetIdBigInt);
                }
                if (needsAccountSlot > 0) {
                  if (!appCall.accounts) appCall.accounts = [];
                  appCall.accounts.push(accountAddr);
                }
                if (DEBUG) console.log(`[AssetHolding] Added pair to fallback txn ${idx}: asset=${assetId}, account=${accountAddr}`);
                added = true;
                break;
              }
            }
          }

          if (!added) {
            if (DEBUG) console.log(`[AssetHolding] WARN: Could not add pair to any transaction: asset=${assetId}, account=${accountAddr}`);
          }
        }

        // Distribute foreignAssets across transactions (only add if not already present in ANY transaction)
        // With group resource sharing, if it's in one transaction, all can access it
        // In algosdk 3.x, foreignAssets are under txn.applicationCall
        for (const assetId of allUniqueForeignAssets) {
          // Check if already in any transaction (group resource sharing)
          const assetIdBigInt = BigInt(assetId);
          const alreadyInGroup = appCallTxns.some(({ txn }) => {
            const appCall = txn.applicationCall || txn;
            const foreignAssets = appCall.foreignAssets || [];
            return foreignAssets.some(a => BigInt(a) === assetIdBigInt);
          });
          if (alreadyInGroup) {
            continue; // Already accessible to all transactions via group sharing
          }

          let added = false;
          for (const { txn, idx } of appCallTxns) {
            const appCall = txn.applicationCall || txn;
            const boxes = appCall.boxes || [];
            const foreignApps = appCall.foreignApps || [];
            const foreignAssets = appCall.foreignAssets || [];
            const accounts = appCall.accounts || [];
            const totalReferences = boxes.length + foreignApps.length + foreignAssets.length + accounts.length;

            if (totalReferences < 8) {
              if (!appCall.foreignAssets) appCall.foreignAssets = [];
              appCall.foreignAssets.push(assetIdBigInt);
              added = true;
              break;
            }
          }
        }
        
        // Distribute accounts across transactions
        // Use the app-to-creator map to add accounts only to transactions that use the corresponding app
        // This is more efficient than adding all accounts to all transactions
        // In algosdk 3.x, resources are under txn.applicationCall
        for (const [appId, creatorAccount] of appToCreatorAccount) {
          const appIdBigInt = BigInt(appId);
          // Find all transactions that have this app in their foreignApps
          let transactionsNeedingAccount = appCallTxns.filter(({ txn }) => {
            const appCall = txn.applicationCall || txn;
            return (appCall.foreignApps || []).some(a => BigInt(a) === appIdBigInt);
          });

          // If no transactions have this app in foreignApps, but the app is in uniqueForeignApps,
          // we should add it to at least one transaction's foreignApps (preferably one with room)
          // This handles cases where the app was discovered from simulation but not yet distributed
          if (transactionsNeedingAccount.length === 0 && uniqueForeignApps.has(appId)) {
            // Find a transaction with room to add the app
            for (const { txn, idx } of appCallTxns) {
              const appCall = txn.applicationCall || txn;
              if (!appCall.foreignApps) appCall.foreignApps = [];
              if (appCall.foreignApps.some(a => BigInt(a) === appIdBigInt)) {
                transactionsNeedingAccount.push({ txn, idx });
                break; // Already added
              }
              const currentBoxes = (appCall.boxes || []).length;
              const currentForeignApps = appCall.foreignApps.length;
              const currentForeignAssets = (appCall.foreignAssets || []).length;
              const currentAccounts = (appCall.accounts || []).length;
              const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;
              if (totalReferences < 8) {
                appCall.foreignApps.push(appIdBigInt);
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
            const appCall = txn.applicationCall || txn;
            if (!appCall.accounts) appCall.accounts = [];

            // Check if already in this transaction
            const alreadyInTxn = appCall.accounts.some(acc => {
              const accStr = typeof acc === 'string' ? acc : acc.toString();
              return accStr === creatorAccount;
            });
            if (alreadyInTxn) {
              continue; // Already added
            }

            const currentBoxes = (appCall.boxes || []).length;
            const currentForeignApps = (appCall.foreignApps || []).length;
            const currentForeignAssets = (appCall.foreignAssets || []).length;
            const currentAccounts = appCall.accounts.length;
            const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;

            // Check both total references (8) and accounts limit (4)
            if (totalReferences < 8 && currentAccounts < 4) {
              appCall.accounts.push(algosdk.Address.fromString(creatorAccount));
            } else {
              // Try to add to another transaction that might need it (even if it doesn't have the app in foreignApps yet)
              // This handles cases where the app needs to be added to foreignApps but we haven't done that yet
              for (const { txn: otherTxn, idx: otherIdx } of appCallTxns) {
                if (otherIdx === idx) continue; // Skip the one we just tried
                const otherAppCall = otherTxn.applicationCall || otherTxn;
                if (!otherAppCall.accounts) otherAppCall.accounts = [];
                const otherAlreadyInTxn = otherAppCall.accounts.some(acc => {
                  const accStr = typeof acc === 'string' ? acc : acc.toString();
                  return accStr === creatorAccount;
                });
                if (otherAlreadyInTxn) {
                  continue; // Already added
                }
                const otherBoxes = (otherAppCall.boxes || []).length;
                const otherForeignApps = (otherAppCall.foreignApps || []).length;
                const otherForeignAssets = (otherAppCall.foreignAssets || []).length;
                const otherAccounts = otherAppCall.accounts.length;
                const otherTotalReferences = otherBoxes + otherForeignApps + otherForeignAssets + otherAccounts;
                // Check both total references (8) and accounts limit (4)
                if (otherTotalReferences < 8 && otherAccounts < 4) {
                  otherAppCall.accounts.push(algosdk.Address.fromString(creatorAccount));
                  // Also add the app to foreignApps if not already there (needed for local state access)
                  if (!otherAppCall.foreignApps) otherAppCall.foreignApps = [];
                  if (!otherAppCall.foreignApps.some(a => BigInt(a) === appIdBigInt)) {
                    if (otherTotalReferences + 1 < 8) { // Check if we can add both app and account
                      otherAppCall.foreignApps.push(appIdBigInt);
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
            const appCall = txn.applicationCall || txn;
            if (!appCall.accounts) appCall.accounts = [];

            const alreadyInTxn = appCall.accounts.some(acc => {
              const accStr = typeof acc === 'string' ? acc : acc.toString();
              return accStr === accountAddr;
            });
            if (alreadyInTxn) {
              added = true;
              break;
            }

            const currentBoxes = (appCall.boxes || []).length;
            const currentForeignApps = (appCall.foreignApps || []).length;
            const currentForeignAssets = (appCall.foreignAssets || []).length;
            const currentAccounts = appCall.accounts.length;
            const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;

            // Check both total references (8) and accounts limit (4)
            if (totalReferences < 8 && currentAccounts < 4) {
              appCall.accounts.push(algosdk.Address.fromString(accountAddr));
              added = true;
              break; // Only add to first transaction with room for unknown accounts
            }
          }
        }

        // Final validation: Ensure no transaction exceeds limits
        // - Total references: 8
        // - Accounts: 4
        // If limits exceeded, trim in order: accounts (if >4), then boxes
        // In algosdk 3.x, resources are under txn.applicationCall
        let hasValidationIssues = false;
        for (let i = 0; i < allTransactions.length; i++) {
          const txn = allTransactions[i];
          if (txn.type === 'appl') {
            const appCall = txn.applicationCall || txn;
            // First check accounts limit (max 4)
            if (appCall.accounts && appCall.accounts.length > 4) {
              console.error(`[Validation] Txn ${i} (app ${appCall.appIndex}) EXCEEDS ACCOUNT LIMIT: ${appCall.accounts.length}/4 accounts - trimming`);
              appCall.accounts = appCall.accounts.slice(0, 4);
              hasValidationIssues = true;
            }

            const currentBoxes = (appCall.boxes || []).length;
            const currentForeignApps = (appCall.foreignApps || []).length;
            const currentForeignAssets = (appCall.foreignAssets || []).length;
            const currentAccounts = (appCall.accounts || []).length;
            const totalReferences = currentBoxes + currentForeignApps + currentForeignAssets + currentAccounts;

            if (totalReferences > 8) {
              // Log the full breakdown before trimming
              console.error(`[Validation] Txn ${i} (app ${appCall.appIndex}) EXCEEDS REFERENCE LIMIT: apps=${currentForeignApps} assets=${currentForeignAssets} accts=${currentAccounts} boxes=${currentBoxes} => ${totalReferences}/8`);
              // Trim boxes to stay within limit
              // Keep foreignApps and foreignAssets as they're more critical
              const maxBoxes = Math.max(0, 8 - currentForeignApps - currentForeignAssets - currentAccounts);
              if (appCall.boxes && appCall.boxes.length > maxBoxes) {
                console.error(`[Validation] Trimming boxes from ${appCall.boxes.length} to ${maxBoxes}`);
                appCall.boxes = appCall.boxes.slice(0, maxBoxes);
              }
              hasValidationIssues = true;
            }
          }
        }
        if (hasValidationIssues) {
          logResourceSummary('Post-Validation', allTransactions);
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
          // In algosdk 3.x, resources are under txn.applicationCall
          const appCall = txn.applicationCall || txn;
          // nomadexPoolIds is a Set<Number>; appCall.appIndex is a bigint in algosdk 3.x, so it must
          // be coerced to Number before the Set lookup (and there is no top-level txn.appIndex).
          const isNomadexTxn = txn.type === 'appl' && nomadexPoolIds.has(Number(appCall.appIndex));
          const appCallBoxes = appCall.boxes || [];
          const appCallAccounts = appCall.accounts || [];
          const needsRebuild = txn.type === 'appl' && (appCallBoxes.length > 0 || appCallAccounts.length > 0 || isNomadexTxn);
          if (needsRebuild) {
            // Rebuild the transaction to ensure boxes are properly encoded
            const fromAddress = txn.sender.toString();
            const suggestedParams = await getSuggestedParams();

            // Ensure foreignApps are preserved, and for Nomadex transactions, always include factory app 411751
            let foreignApps = appCall.foreignApps || [];
            if (DEBUG) console.log(`[Rebuild] Txn ${i} (app ${appCall.appIndex}): foreignApps from applicationCall=${foreignApps.map(a => Number(a))}`);
            if (isNomadexTxn) {
              // This is a Nomadex pool transaction - it MUST have factory app 411751
              const factoryAppId = 411751n;
              if (!foreignApps.some(a => BigInt(a) === factoryAppId)) {
                foreignApps = [factoryAppId, ...foreignApps]; // Add to beginning
              }
            }

            // Get foreignAssets from applicationCall
            const foreignAssets = appCall.foreignAssets || [];

            // Calculate correct fee: base fee (1000) + box fee (2500 per box)
            const boxesCount = appCallBoxes.length;
            const correctFee = 1000 + (boxesCount * 2500);

            const txnObj = {
              sender: fromAddress,
              appIndex: appCall.appIndex,
              // See note above: onComplete lives on applicationCall in algosdk 3.x, not txn.appOnComplete.
              onComplete: appCall.onComplete,
              appArgs: appCall.appArgs,
              foreignApps: foreignApps,
              foreignAssets: foreignAssets,
              boxes: appCallBoxes,
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

            // Include optional fields - get accounts from applicationCall
            if (appCallAccounts.length > 0) {
              txnObj.accounts = appCallAccounts.map(acc => {
                // Handle both string addresses and objects with publicKey
                if (typeof acc === 'string') {
                  return acc;
                } else if (acc && acc.publicKey) {
                  return acc.toString();
                } else if (acc instanceof Uint8Array) {
                  return new algosdk.Address(acc).toString();
                } else if (acc && acc.toString) {
                  return acc.toString();
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
              txnObj.rekeyTo = txn.rekeyTo.toString();
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
            // In algosdk 3.x, boxes/accounts/foreignApps are under applicationCall
            const rebuiltAppCall = rebuiltTxn.applicationCall || rebuiltTxn;

            // CRITICAL: Set foreignApps on applicationCall (makeApplicationCallTxnFromObject may not do this correctly in algosdk 3.x)
            if (foreignApps && foreignApps.length > 0) {
              rebuiltAppCall.foreignApps = foreignApps.map(a => BigInt(a));
              if (DEBUG) console.log(`[Rebuild] Txn ${i}: Set applicationCall.foreignApps=${rebuiltAppCall.foreignApps.map(a => Number(a))}`);
            }

            // Set foreignAssets on applicationCall
            if (txnObj.foreignAssets && txnObj.foreignAssets.length > 0) {
              rebuiltAppCall.foreignAssets = txnObj.foreignAssets.map(a => BigInt(a));
            }

            // Manually set boxes after creation (if present)
            if (boxesToAdd && boxesToAdd.length > 0) {
              rebuiltAppCall.boxes = boxesToAdd.map(b => ({
                appIndex: BigInt(b.appIndex),
                name: b.name
              }));
              // Recalculate fee after boxes are added: base fee (1000) + box fee (2500 per box)
              const finalBoxesCount = boxesToAdd.length;
              const finalFee = 1000 + (finalBoxesCount * 2500);
              rebuiltTxn.fee = BigInt(finalFee);
            } else {
              // No boxes, ensure fee is correct (base fee only)
              if (rebuiltTxn.fee !== 1000n) {
                rebuiltTxn.fee = 1000n;
              }
            }

            // Verify accounts were preserved (makeApplicationCallTxnFromObject should handle them, but verify)
            if (txnObj.accounts && txnObj.accounts.length > 0) {
              // Ensure accounts are set on the rebuilt transaction - in algosdk 3.x under applicationCall
              const existingAccounts = rebuiltAppCall.accounts || [];
              if (existingAccounts.length !== txnObj.accounts.length) {
                rebuiltAppCall.accounts = txnObj.accounts.map(a => {
                  if (typeof a === 'string') return algosdk.Address.fromString(a);
                  return a;
                });
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
      // This block performs ALL of the iterative simulation, box/foreignApp/foreignAsset/account
      // discovery, and strict verification for the group. Any exception here means the group's
      // required resources were NOT fully discovered/applied - silently continuing would return a
      // transaction group that looks valid but is missing box/app/asset references, which will
      // simply revert on submission (or, worse, be signed and broadcast by a client that trusts
      // simulationError === null). Log loudly and fail the request instead.
      console.error(`[Simulation] Resource discovery/verification block failed: ${error.message}\n${error.stack}`);
      simulationErrorMessage = simulationErrorMessage || error.message || 'Resource discovery failed';
      throw new Error(`Failed to build a fully-verified transaction group: ${error.message}`);
    }
  }
  
  // Calculate total fees
  let totalFees = 0n;
  for (let i = 0; i < allTransactions.length; i++) {
    const txn = allTransactions[i];
    // Calculate total fees - fee is bigint in algosdk 3.x
    const fee = txn.fee !== undefined ? BigInt(txn.fee) : (txn.suggestedParams?.fee ? BigInt(txn.suggestedParams.fee) : 0n);
    totalFees += fee;

    // Include payment transaction amounts in total fees
    // Payment transactions (like 28500 for wVOI approval, 28501 for balance box creation)
    // are part of the cost to the user and should be included in networkFee.
    // However, we must NOT count the actual swap amount as a fee: when swapping FROM native VOI,
    // the deposit payment carries the swap amount (and, on a first-time swap, ALSO bundles a
    // balance-box/MBR surcharge in the same payment). Subtract only the tracked swap-deposit portion
    // for that recipient; any remaining amount (the MBR/box surcharge) is a genuine network cost.
    const paymentAmount = txn.payment?.amount;
    if (txn.type === 'pay' && paymentAmount !== undefined) {
      const paymentAmountBigInt = BigInt(paymentAmount);

      // Get recipient address if available
      const recipientAddress = txn.payment?.receiver ? txn.payment.receiver.toString() : null;

      const trackedDeposit = recipientAddress ? swapDepositByRecipient.get(recipientAddress) : undefined;
      if (trackedDeposit && trackedDeposit > 0n) {
        // Exclude only the swap-deposit portion of this payment (up to the amount tracked for the
        // recipient). Consume the tracked amount so multiple deposits to the same recipient each
        // exclude their own swap portion rather than over-subtracting.
        const excluded = paymentAmountBigInt < trackedDeposit ? paymentAmountBigInt : trackedDeposit;
        swapDepositByRecipient.set(recipientAddress, trackedDeposit - excluded);
        totalFees += paymentAmountBigInt - excluded;
      } else {
        // Not a tracked swap deposit — the full payment is a genuine cost (fee/MBR/box).
        totalFees += paymentAmountBigInt;
      }
    }
  }

  // FINAL: Clear and reassign group IDs right before encoding
  // This ensures all transactions have a consistent group ID after all modifications
  for (const txn of allTransactions) {
    if (txn.group) {
      txn.group = undefined;
    }
  }
  algosdk.assignGroupID(allTransactions);

  // Encode all transactions back to base64
  const encodedTransactions = allTransactions.map(txn =>
    Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64')
  );

  // Return both transactions and total network fees (convert bigint to number for API response)
  return {
    transactions: encodedTransactions,
    networkFee: Number(totalFees),
    simulationError: simulationErrorMessage
  };
}

/**
 * Get a summary string for an algosdk.Transaction
 */
function getTransactionSummary(txn, index) {
  // Get fee from transaction (try txn.fee first, then suggestedParams.fee as fallback)
  const fee = txn.fee !== undefined ? txn.fee : (txn.suggestedParams?.fee || 0n);
  const feeStr = `, Fee: ${fee} microAlgos`;

  if (txn.type === 'pay') {
    const from = txn.sender?.toString() || 'unknown';
    const to = txn.payment?.receiver?.toString() || 'unknown';
    const amount = txn.payment?.amount || 0n;
    return `Payment: ${from.substring(0, 8)}... -> ${to.substring(0, 8)}..., Amount: ${amount} microAlgos${feeStr}`;
  } else if (txn.type === 'axfer') {
    const from = txn.sender?.toString() || 'unknown';
    const to = txn.assetTransfer?.receiver?.toString() || 'unknown';
    const assetIndex = txn.assetTransfer?.assetIndex || txn.assetIndex || 0;
    const amount = txn.assetTransfer?.amount || 0n;
    return `Asset Transfer: ${from.substring(0, 8)}... -> ${to.substring(0, 8)}..., Asset: ${assetIndex}, Amount: ${amount}${feeStr}`;
  } else if (txn.type === 'appl') {
    const from = txn.sender?.toString() || 'unknown';
    const noteText = txn.note ? new TextDecoder().decode(txn.note).substring(0, 40) : 'No note';
    const appIndex = txn.applicationCall?.appIndex || txn.appIndex || 0;
    let summary = `App Call: ${from.substring(0, 8)}... -> App ${appIndex}`;
    // In algosdk 3.x, resources are under txn.applicationCall
    const appCall = txn.applicationCall || txn;
    const boxes = appCall.boxes || [];
    const foreignApps = appCall.foreignApps || [];
    const foreignAssets = appCall.foreignAssets || [];
    if (boxes.length > 0) {
      summary += `, ${boxes.length} box(es)`;
    }
    if (foreignApps.length > 0) {
      summary += `, Foreign Apps: [${foreignApps.map(a => Number(a)).join(', ')}]`;
    }
    if (foreignAssets.length > 0) {
      summary += `, Foreign Assets: [${foreignAssets.map(a => Number(a)).join(', ')}]`;
    }
    return summary + feeStr;
  }
  return `Transaction ${index}: ${txn.type || 'unknown'}${feeStr}`;
}

export { buildSwapTransactions, buildBatchUnwrapTransactions, enforcedMinAmountOut, getAppCreatorAddress, MAX_UNWRAP_GROUP_SIZE };

