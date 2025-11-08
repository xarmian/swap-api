import algosdk from 'algosdk';
import {
  buildSwapTransactions as buildNomadexSwapTransactions,
  getTokenTypeFromConfig
} from './nomadex.js';
import {
  buildSwapTransactions as buildHumbleswapSwapTransactions,
  resolveWrappedTokens
} from './humbleswap.js';
import { getTokenDecimals } from './utils.js';
import { getTokenMetaFromConfig } from './config.js';
import { algodClient, indexerClient } from './clients.js';

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
  
  for (let i = 0; i < splitDetails.length; i++) {
    const split = splitDetails[i];
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
        if (txn.type === 'appl' && inputTokenType === 'ARC200' && Number(inputToken) !== 0 && txn.appIndex === Number(inputToken)) {
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
                appIndex: Number(inputToken),
                name: new Uint8Array(Buffer.concat([balancesPrefix, senderAddressBytes]))
              },
              {
                appIndex: Number(inputToken),
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
          // Rebuild foreignAssets array based on token types
          const foreignAssets = [];
          if (inputTokenType === 'ASA' && Number(inputToken) !== 0) {
            foreignAssets.push(Number(inputToken));
          }
          if (outputTokenType === 'ASA' && Number(outputToken) !== 0) {
            foreignAssets.push(Number(outputToken));
          }
          const uniqueForeignAssets = [...new Set(foreignAssets)];
          
          // Rebuild foreignApps array
          const factoryAppId = 411751;
          const foreignApps = [factoryAppId];
          if (inputTokenType === 'ARC200' && Number(inputToken) !== 0) {
            if (!foreignApps.includes(Number(inputToken))) {
              foreignApps.push(Number(inputToken));
            }
          }
          if (outputTokenType === 'ARC200' && Number(outputToken) !== 0) {
            if (!foreignApps.includes(Number(outputToken))) {
              foreignApps.push(Number(outputToken));
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
            
            if (inputTokenType === 'ARC200' && Number(inputToken) !== 0) {
              // Add sender's balance box
              const senderAddressBytes = algosdk.decodeAddress(address).publicKey;
              const senderBoxNameBuffer = Buffer.concat([balancesPrefix, senderAddressBytes]);
              const senderBoxName = new Uint8Array(senderBoxNameBuffer);
              
              // Ensure we have valid types
              const inputTokenAppIndex = Number(inputToken);
              if (isNaN(inputTokenAppIndex) || inputTokenAppIndex < 0) {
                throw new Error(`Invalid input token appIndex: ${inputToken}`);
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
            
            if (outputTokenType === 'ARC200' && Number(outputToken) !== 0) {
              const outputTokenAppIndex = Number(outputToken);
              if (isNaN(outputTokenAppIndex) || outputTokenAppIndex < 0) {
                throw new Error(`Invalid output token appIndex: ${outputToken}`);
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
            foreignApps: foreignApps,
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
            txnObj.accounts = txn.accounts.map(acc => algosdk.encodeAddress(acc.publicKey));
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
    } else {
      // Build HumbleSwap transactions using humbleswap module
      const { inputWrapped, outputWrapped } = resolveWrappedTokens(poolCfg, inputToken, outputToken);
      
      // Get decimals
      const inputDecimals = await getTokenDecimals(inputTokenStr);
      const outputDecimals = await getTokenDecimals(outputTokenStr);
      
      // Build swap transactions using humbleswap module
      const decodedTxns = await buildHumbleswapSwapTransactions({
        sender: address,
        poolId: poolId,
        inputToken: inputTokenStr,
        outputToken: outputTokenStr,
        amountIn: amountBigInt.toString(),
        minAmountOut: minOutput,
        inputWrapped: inputWrapped,
        outputWrapped: outputWrapped,
        inputDecimals: inputDecimals,
        outputDecimals: outputDecimals,
        slippage: slippage,
        algodClient: algodClient,
        indexerClient: indexerClient,
        getTokenMetaFromConfig: getTokenMetaFromConfig
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
  
  // Encode all transactions back to base64
  return allTransactions.map(txn => 
    Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64')
  );
}

export { buildSwapTransactions };

