import algosdk from 'algosdk';
import { arc200 } from 'ulujs';

/**
 * Nomadex pool interaction module
 * Handles pool info fetching, quote calculation, and transaction building
 * for Nomadex AMM pools without using the nomadex-client library
 */

/**
 * Decode base64 global state value
 */
function decodeStateValue(value) {
  if (value.type === 1) {
    // uint64
    return BigInt(value.uint);
  } else if (value.type === 2) {
    // bytes
    return Buffer.from(value.bytes, 'base64');
  }
  return null;
}

/**
 * Get pool information from Nomadex contract
 * @param {number} poolId - Pool application ID
 * @param {Algodv2} algodClient - Algod client
 * @param {Indexer} indexerClient - Indexer client
 * @param {Object} poolConfig - Pool configuration with token info
 * @returns {Promise<Object>} Pool information
 */
export async function getPoolInfo(poolId, algodClient, indexerClient, poolConfig = null) {
  try {
    // Fetch application info from indexer
    const appInfo = await indexerClient.lookupApplications(Number(poolId)).do();
    
    if (!appInfo.application || !appInfo.application.params) {
      throw new Error('Invalid application info');
    }

    const globalState = appInfo.application.params['global-state'] || [];
    
    // Parse global state into a map
    const stateMap = {};
    for (const state of globalState) {
      const key = Buffer.from(state.key, 'base64').toString('utf-8');
      stateMap[key] = decodeStateValue(state.value);
    }
    

    // Try multiple common state key patterns
    // Nomadex may use different key names - we'll try common patterns
    let reserveA = BigInt(0);
    let reserveB = BigInt(0);
    let fee = BigInt(30); // Default 0.3% (30 basis points)
    
    // Try various key name patterns
    const reserveAKeys = ['reserve_a', 'reserveA', 'r_a', 'ra', 'reserve0', 'reserve_0'];
    const reserveBKeys = ['reserve_b', 'reserveB', 'r_b', 'rb', 'reserve1', 'reserve_1'];
    const feeKeys = ['fee', 'tot_fee', 'total_fee', 'fee_bps'];
    
    for (const key of reserveAKeys) {
      if (stateMap[key] !== undefined) {
        reserveA = BigInt(stateMap[key]);
        break;
      }
    }
    
    for (const key of reserveBKeys) {
      if (stateMap[key] !== undefined) {
        reserveB = BigInt(stateMap[key]);
        break;
      }
    }
    
    for (const key of feeKeys) {
      if (stateMap[key] !== undefined) {
        fee = BigInt(stateMap[key]);
        break;
      }
    }
    
    // Get token IDs from config if available, otherwise try state
    let tokA = null;
    let tokB = null;
    
    if (poolConfig && poolConfig.tokens) {
      if (poolConfig.tokens.tokA) {
        tokA = Number(poolConfig.tokens.tokA.id);
      }
      if (poolConfig.tokens.tokB) {
        tokB = Number(poolConfig.tokens.tokB.id);
      }
    }
    
    // Fallback: try to get from state
    // Note: tokA can be 0 (native token), so we check for null/undefined explicitly
    if (tokA === null || tokA === undefined || tokB === null || tokB === undefined) {
      const tokAKeys = ['tok_a', 'tokA', 'token_a', 'tokenA', 'token0', 'token_0'];
      const tokBKeys = ['tok_b', 'tokB', 'token_b', 'tokenB', 'token1', 'token_1'];
      
      for (const key of tokAKeys) {
        if (stateMap[key] !== undefined) {
          tokA = Number(stateMap[key]);
          break;
        }
      }
      
      for (const key of tokBKeys) {
        if (stateMap[key] !== undefined) {
          tokB = Number(stateMap[key]);
          break;
        }
      }
    }
    
    // Verify and correct reserve mapping by checking account balances
    // This ensures reserveA corresponds to tokA and reserveB corresponds to tokB
    // We can verify native/ASA tokens from account balance, and swap reserves if needed
    if (tokA !== null && tokB !== null) {
      try {
        const poolAddress = algosdk.getApplicationAddress(Number(poolId));
        const accountInfo = await algodClient.accountInformation(poolAddress).do();
        
        let actualReserveA = null;
        let actualReserveB = null;
        
        // Get actual reserves from account balance (for native/ASA tokens only)
        if (tokA === 0) {
          actualReserveA = BigInt(accountInfo.amount || 0);
        } else if (accountInfo.assets) {
          for (const asset of accountInfo.assets) {
            if (asset['asset-id'] === tokA) {
              actualReserveA = BigInt(asset.amount || 0);
              break;
            }
          }
        }
        
        // If tokA is ARC200 and we didn't find it in assets, try reading from ARC200 contract
        if (actualReserveA === null && tokA !== 0) {
          try {
            const arc200Contract = new arc200(Number(tokA), algodClient, indexerClient, {
              acc: { addr: poolAddress, sk: new Uint8Array(0) },
              simulate: true
            });
            
            const balanceResult = await arc200Contract.arc200_balanceOf(poolAddress);
            if (balanceResult.success) {
              actualReserveA = balanceResult.returnValue;
            } else {
              console.warn(`Failed to read ARC200 balance for tokA ${tokA}:`, balanceResult.error);
            }
          } catch (arc200Err) {
            console.warn(`Could not read ARC200 balance for tokA ${tokA}:`, arc200Err.message);
          }
        }
        
        if (tokB === 0) {
          actualReserveB = BigInt(accountInfo.amount || 0);
        } else if (accountInfo.assets) {
          for (const asset of accountInfo.assets) {
            if (asset['asset-id'] === tokB) {
              actualReserveB = BigInt(asset.amount || 0);
              break;
            }
          }
        }
        
        // If tokB is ARC200 and we didn't find it in assets, try reading from ARC200 contract
        if (actualReserveB === null && tokB !== 0) {
          try {
            const arc200Contract = new arc200(Number(tokB), algodClient, indexerClient, {
              acc: { addr: poolAddress, sk: new Uint8Array(0) },
              simulate: true
            });
            
            const balanceResult = await arc200Contract.arc200_balanceOf(poolAddress);
            if (balanceResult.success) {
              actualReserveB = balanceResult.returnValue;
            } else {
              console.warn(`Failed to read ARC200 balance for tokB ${tokB}:`, balanceResult.error);
            }
          } catch (arc200Err) {
            console.warn(`Could not read ARC200 balance for tokB ${tokB}:`, arc200Err.message);
          }
        }
        
        
        // If we can verify both reserves, use the actual values
        if (actualReserveA !== null && actualReserveB !== null) {
          // Check if reserves from state match actual reserves
          const aMatches = (reserveA === actualReserveA);
          const bMatches = (reserveB === actualReserveB);
          
          if (!aMatches || !bMatches) {
            // Check if swapping would fix it
            if (reserveA === actualReserveB && reserveB === actualReserveA) {
              // Reserves are swapped - correct them
              [reserveA, reserveB] = [reserveB, reserveA];
            } else {
              // Use actual values from account balance
              reserveA = actualReserveA;
              reserveB = actualReserveB;
            }
          }
        } else if (actualReserveA !== null) {
          // Only tokA can be verified (tokB is likely ARC200)
          // Use actual value for reserveA
          if (reserveA !== actualReserveA) {
            // If reserveB matches actualReserveA, they're swapped
            if (reserveB === actualReserveA) {
              [reserveA, reserveB] = [reserveB, reserveA];
            } else {
              // Use actual value for reserveA
              reserveA = actualReserveA;
            }
          }
        } else if (actualReserveB !== null) {
          // Only tokB can be verified (tokA is likely ARC200)
          // Use actual value for reserveB
          if (reserveB !== actualReserveB) {
            // If reserveA matches actualReserveB, they're swapped
            if (reserveA === actualReserveB) {
              [reserveA, reserveB] = [reserveB, reserveA];
            } else {
              // Use actual value for reserveB
              reserveB = actualReserveB;
            }
          }
        }
        // If neither can be verified (both ARC200), trust state values
      } catch (err) {
        console.warn('Could not verify reserve mapping from account balance:', err.message);
      }
    }
    
    return {
      poolId: Number(poolId),
      reserveA: reserveA.toString(),
      reserveB: reserveB.toString(),
      fee: Number(fee),
      tokA: tokA,
      tokB: tokB
    };
  } catch (error) {
    console.error('Error fetching Nomadex pool info:', error);
    throw new Error(`Failed to fetch pool info: ${error.message}`);
  }
}

/**
 * Calculate output amount using AMM constant product formula
 * @param {BigInt|string|number} inputAmount - Input amount
 * @param {BigInt|string|number} inputReserve - Input token reserve
 * @param {BigInt|string|number} outputReserve - Output token reserve
 * @param {number} fee - Fee in basis points (e.g., 30 for 0.3%)
 * @returns {BigInt} Output amount
 */
export function calculateOutputAmount(inputAmount, inputReserve, outputReserve, fee) {
  const amountIn = BigInt(inputAmount);
  const reserveIn = BigInt(inputReserve);
  const reserveOut = BigInt(outputReserve);
  const feeBps = BigInt(fee);
  
  // AMM formula: (reserveOut * amountIn * (10000 - fee)) / (reserveIn * 10000 + amountIn * (10000 - fee))
  const amountInWithFee = amountIn * (BigInt(10000) - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * BigInt(10000) + amountInWithFee;
  
  return numerator / denominator;
}

/**
 * Determine token type (native, ASA, or ARC200)
 * @param {number} tokenId - Token ID (0 for native)
 * @param {Indexer} indexerClient - Indexer client
 * @returns {Promise<string>} Token type: 'native', 'ASA', or 'ARC200'
 */
export async function getTokenType(tokenId, indexerClient) {
  if (Number(tokenId) === 0) {
    return 'native';
  }
  
  try {
    // Try to fetch as ASA first
    const assetInfo = await indexerClient.lookupAssetByID(Number(tokenId)).do();
    if (assetInfo && assetInfo.asset) {
      // Check if it's ARC200 by looking for ARC200 standard fields
      // ARC200 tokens are typically ASAs with specific metadata
      // For now, assume all non-native tokens are ASAs
      // You may need to check for ARC200 contracts separately
      return 'ASA';
    }
  } catch (error) {
    // Asset not found, might be ARC200 or invalid
    // Could check for ARC200 contract here
    return 'ASA'; // Default assumption
  }
  
  return 'ASA';
}

/**
 * Create ABI method object for ARC200 transfer
 * Based on the ARC200 standard: arc200_transfer(address,uint256)bool
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
 * Create ABI method objects for Nomadex swap methods
 * Based on the ABI: swapAlphaToBeta(txn,uint256)uint256 and swapBetaToAlpha(txn,uint256)uint256
 */
function getSwapMethod(isAlphaToBeta) {
  if (isAlphaToBeta) {
    return new algosdk.ABIMethod({
      name: 'swapAlphaToBeta',
      args: [
        { type: 'txn', name: 'alphaTxn' },
        { type: 'uint256', name: 'minBetaAmount' }
      ],
      returns: { type: 'uint256' }
    });
  } else {
    return new algosdk.ABIMethod({
      name: 'swapBetaToAlpha',
      args: [
        { type: 'txn', name: 'betaTxn' },
        { type: 'uint256', name: 'minAlphaAmount' }
      ],
      returns: { type: 'uint256' }
    });
  }
}

/**
 * Build swap transactions for Nomadex pool
 * Based on the actual Nomadex ABI: swapAlphaToBeta(txn,uint256)uint256 and swapBetaToAlpha(txn,uint256)uint256
 * @param {Object} params - Swap parameters
 * @param {string} params.sender - Sender address
 * @param {number} params.poolId - Pool application ID
 * @param {number} params.inputToken - Input token ID
 * @param {number} params.outputToken - Output token ID
 * @param {BigInt|string} params.amountIn - Input amount
 * @param {BigInt|string} params.minAmountOut - Minimum output amount
 * @param {boolean} params.isDirectionAlphaToBeta - Swap direction (true = tokA -> tokB)
 * @param {string} params.inputTokenType - Input token type ('native', 'ASA', 'ARC200')
 * @param {string} params.outputTokenType - Output token type ('native', 'ASA', 'ARC200')
 * @param {Algodv2} params.algodClient - Algod client
 * @returns {Promise<Array<string>>} Array of base64-encoded unsigned transactions
 */
export async function buildSwapTransactions({
  sender,
  poolId,
  inputToken,
  outputToken,
  amountIn,
  minAmountOut,
  isDirectionAlphaToBeta,
  inputTokenType,
  outputTokenType,
  algodClient
}) {
  const suggestedParams = await algodClient.getTransactionParams().do();
  const poolAddress = algosdk.getApplicationAddress(Number(poolId));
  
  // Build the deposit/transfer transaction first (this becomes the 'txn' argument)
  let depositTxn;
  if (inputTokenType === 'native') {
    depositTxn = algosdk.makePaymentTxnWithSuggestedParams(
      sender,
      poolAddress,
      BigInt(amountIn),
      undefined,
      undefined,
      suggestedParams
    );
  } else if (inputTokenType === 'ASA') {
    depositTxn = algosdk.makeAssetTransferTxnWithSuggestedParams(
      sender,
      poolAddress,
      undefined,
      undefined,
      BigInt(amountIn),
      undefined,
      Number(inputToken),
      suggestedParams
    );
  } else if (inputTokenType === 'ARC200') {
    // ARC200 requires an application call to the token contract
    // For ARC200 tokens, the token ID IS the contract ID
    const arc200ContractId = Number(inputToken);
    const arc200TransferMethod = getARC200TransferMethod();
    
    // Build the ARC200 transfer application call using AtomicTransactionComposer
    const arc200Atc = new algosdk.AtomicTransactionComposer();
    arc200Atc.addMethodCall({
      appID: arc200ContractId,
      method: arc200TransferMethod,
      methodArgs: [
        poolAddress,  // to: pool address
        BigInt(amountIn)  // value: amount to transfer
      ],
      sender: sender,
      suggestedParams: suggestedParams
    });
    
    // Build the transaction group and get the first (and only) transaction
    const arc200Txns = arc200Atc.buildGroup();
    if (arc200Txns.length !== 1) {
      throw new Error(`Expected 1 ARC200 transfer transaction, got ${arc200Txns.length}`);
    }
    depositTxn = arc200Txns[0].txn;
    // Clear any group ID - it will be reassigned when added to the swap transaction group
    depositTxn.group = undefined;
  } else {
    throw new Error(`Unsupported input token type: ${inputTokenType}`);
  }
  
  // Get the appropriate swap method based on direction
  const swapMethod = getSwapMethod(isDirectionAlphaToBeta);
  
  // Build foreign assets array for the app call
  const foreignAssets = [];
  if (inputTokenType === 'ASA' && Number(inputToken) !== 0) {
    foreignAssets.push(Number(inputToken));
  }
  if (outputTokenType === 'ASA' && Number(outputToken) !== 0) {
    foreignAssets.push(Number(outputToken));
  }
  const uniqueForeignAssets = [...new Set(foreignAssets)];
  
  // Nomadex pool contract requires the factory application ID in foreignApps
  // Factory ID for Voi mainnet is 411751 (from nomadex-client constants)
  const factoryAppId = 411751;
  const foreignApps = [factoryAppId];
  
  // Add ARC200 contract IDs to foreignApps if ARC200 tokens are involved
  // For ARC200 tokens, the token ID IS the contract ID
  if (inputTokenType === 'ARC200' && Number(inputToken) !== 0) {
    const arc200ContractId = Number(inputToken);
    if (!foreignApps.includes(arc200ContractId)) {
      foreignApps.push(arc200ContractId);
    }
  }
  if (outputTokenType === 'ARC200' && Number(outputToken) !== 0) {
    const arc200ContractId = Number(outputToken);
    if (!foreignApps.includes(arc200ContractId)) {
      foreignApps.push(arc200ContractId);
    }
  }
  
  // Use AtomicTransactionComposer to properly encode the ABI method call
  const atc = new algosdk.AtomicTransactionComposer();
  
  // Add the application call with proper ABI encoding
  // The method signature is: swapAlphaToBeta(txn,uint256)uint256 or swapBetaToAlpha(txn,uint256)uint256
  // First arg is the transaction itself (must be TransactionWithSigner), second is minAmount as uint256
  // The composer will automatically add the transaction to the group in the correct order
  atc.addMethodCall({
    appID: Number(poolId),
    method: swapMethod,
    methodArgs: [
      {
        txn: depositTxn,
        signer: algosdk.makeEmptyTransactionSigner()
      },  // The transaction itself wrapped as TransactionWithSigner (txn type)
      BigInt(minAmountOut)  // Minimum amount as uint256
    ],
    sender: sender,
    suggestedParams: suggestedParams,
    appForeignApps: foreignApps,
    foreignAssets: uniqueForeignAssets.length > 0 ? uniqueForeignAssets : undefined
  });
  
  // Build the transaction group
  const txns = atc.buildGroup().map(({ txn }) => txn);
  
  // Encode transactions to base64
  return txns.map(txn => Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64'));
}

/**
 * Get token type from pool config
 * @param {Object} poolConfig - Pool configuration
 * @param {number} tokenId - Token ID
 * @returns {string|null} Token type or null if not found
 */
export function getTokenTypeFromConfig(poolConfig, tokenId) {
  if (!poolConfig || !poolConfig.tokens) {
    return null;
  }
  
  const tokA = poolConfig.tokens.tokA;
  const tokB = poolConfig.tokens.tokB;
  
  if (tokA && Number(tokA.id) === Number(tokenId)) {
    return tokA.type;
  }
  if (tokB && Number(tokB.id) === Number(tokenId)) {
    return tokB.type;
  }
  
  return null;
}

