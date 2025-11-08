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
 * Build transactions for one or more pools and combine into single atomic group
 * @param {Array<Object>} splitDetails - Array from calculateOptimalSplit: { poolCfg, amount, expectedOutput, minOutput, quote }
 * @param {string|number} inputToken - Input token ID (underlying token)
 * @param {string|number} outputToken - Output token ID (underlying token)
 * @param {number} slippage - Slippage tolerance
 * @param {string} address - User's address (optional)
 * @returns {Promise<Array<string>>} Array of base64-encoded unsigned transactions
 */
async function buildSwapTransactions(splitDetails, inputToken, outputToken, slippage, address) {
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
          
          const rebuiltTxn = algosdk.makeApplicationCallTxnFromObject(txnObj);
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

