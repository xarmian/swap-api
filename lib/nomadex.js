import algosdk from 'algosdk';

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
    
    // If we still don't have reserves, try reading from account balance
    // The pool contract account should hold the reserves
    if (reserveA === 0n || reserveB === 0n) {
      try {
        const poolAddress = algosdk.getApplicationAddress(Number(poolId));
        const accountInfo = await algodClient.accountInformation(poolAddress).do();
        
        // Check native balance
        if (tokA === 0) {
          reserveA = BigInt(accountInfo.amount || 0);
        } else if (tokB === 0) {
          reserveB = BigInt(accountInfo.amount || 0);
        }
        
        // Check ASA balances
        if (accountInfo.assets) {
          for (const asset of accountInfo.assets) {
            if (asset['asset-id'] === tokA && tokA !== 0) {
              reserveA = BigInt(asset.amount || 0);
            }
            if (asset['asset-id'] === tokB && tokB !== 0) {
              reserveB = BigInt(asset.amount || 0);
            }
          }
        }
      } catch (err) {
        console.warn('Could not read reserves from account balance:', err.message);
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
    // This would need the ARC200 token contract ID
    // For now, we'll throw an error - this can be implemented later
    throw new Error('ARC200 token transfers require token contract ID - not yet fully implemented');
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

