import { swap, swap200 } from 'ulujs';
import algosdk from 'algosdk';

/**
 * HumbleSwap pool interaction module
 * Handles pool info fetching, quote calculation, and transaction building
 * for HumbleSwap AMM pools using ulujs
 */

/**
 * Resolve underlying tokens to wrapped tokens based on pool configuration
 * @param {Object} poolConfig - Pool configuration
 * @param {string|number} inputToken - Input token ID (underlying token)
 * @param {string|number} outputToken - Output token ID (underlying token)
 * @returns {Object} Object with inputWrapped and outputWrapped token IDs
 */
export function resolveWrappedTokens(poolConfig, inputToken, outputToken) {
  const u2w = poolConfig.tokens?.underlyingToWrapped || {};
  const inputTokenStr = String(inputToken);
  const outputTokenStr = String(outputToken);
  const inputTokenNum = Number(inputToken);
  const outputTokenNum = Number(outputToken);
  
  // If token is not in underlyingToWrapped, it's already wrapped (e.g., ARC200 tokens)
  const inputWrapped = u2w[inputTokenStr] ?? u2w[inputTokenNum] ?? inputTokenNum;
  const outputWrapped = u2w[outputTokenStr] ?? u2w[outputTokenNum] ?? outputTokenNum;
  
  return {
    inputWrapped: Number(inputWrapped),
    outputWrapped: Number(outputWrapped)
  };
}

/**
 * Validate that wrapped tokens match the pool's configured pair
 * @param {Object} poolConfig - Pool configuration
 * @param {number} inputWrapped - Input wrapped token ID
 * @param {number} outputWrapped - Output wrapped token ID
 * @returns {boolean} True if wrapped tokens match pool configuration
 */
export function validateWrappedPair(poolConfig, inputWrapped, outputWrapped) {
  const pair = poolConfig.tokens?.wrappedPair || {};
  const wrappedPairOk =
    (Number(pair.tokA) === Number(inputWrapped) && Number(pair.tokB) === Number(outputWrapped)) ||
    (Number(pair.tokA) === Number(outputWrapped) && Number(pair.tokB) === Number(inputWrapped));
  return wrappedPairOk;
}

/**
 * Get pool information from HumbleSwap contract
 * @param {number} poolId - Pool application ID
 * @param {Algodv2} algodClient - Algod client
 * @param {Indexer} indexerClient - Indexer client
 * @param {Object} poolConfig - Pool configuration (optional)
 * @param {string} address - Optional address for pool info calls
 * @returns {Promise<Object>} Pool information
 */
export async function getPoolInfo(poolId, algodClient, indexerClient, poolConfig = null, address = null) {
  try {
    const poolContractId = Number(poolId);
    const addressForInfo = address || 'H7W63MIQJMYBOEYPM5NJEGX3P54H54RZIV2G3OQ2255AULG6U74BE5KFC4';
    
    const swapInstance = new swap(poolContractId, algodClient, indexerClient, {
      acc: { addr: addressForInfo, sk: new Uint8Array(0) },
      simulate: true,
      formatBytes: true,
      waitForConfirmation: false
    });

    const infoResult = await swapInstance.Info();
    if (!infoResult.success) {
      throw new Error('Failed to fetch pool information: ' + JSON.stringify(infoResult.error));
    }
    
    return infoResult.returnValue;
  } catch (error) {
    console.error('Error fetching HumbleSwap pool info:', error);
    throw new Error(`Failed to fetch pool info: ${error.message}`);
  }
}

/**
 * Get pool information using swap200 (for /pool endpoint)
 * @param {number} poolId - Pool application ID
 * @param {Algodv2} algodClient - Algod client
 * @param {Indexer} indexerClient - Indexer client
 * @returns {Promise<Object>} Pool information
 */
export async function getPoolInfo200(poolId, algodClient, indexerClient) {
  try {
    const swapContract = new swap200(Number(poolId), algodClient, indexerClient);
    const infoResult = await swapContract.Info();

    if (!infoResult.success) {
      throw new Error('Failed to fetch pool information: ' + JSON.stringify(infoResult.error));
    }

    return infoResult.returnValue;
  } catch (error) {
    console.error('Error fetching HumbleSwap pool info (swap200):', error);
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
  // fee is in basis points (e.g., 30 for 0.3%)
  const amountInWithFee = BigInt(inputAmount) * BigInt(10000 - fee);
  const numerator = amountInWithFee * BigInt(outputReserve);
  const denominator = BigInt(inputReserve) * BigInt(10000) + amountInWithFee;
  return numerator / denominator;
}

/**
 * Build swap transactions for HumbleSwap pool
 * @param {Object} params - Swap parameters
 * @param {string} params.sender - Sender address
 * @param {number} params.poolId - Pool application ID
 * @param {string|number} params.inputToken - Input token ID (underlying token)
 * @param {string|number} params.outputToken - Output token ID (underlying token)
 * @param {BigInt|string} params.amountIn - Input amount
 * @param {BigInt|string} params.minAmountOut - Minimum output amount (not used by ulujs, but kept for consistency)
 * @param {number} params.inputWrapped - Input wrapped token ID
 * @param {number} params.outputWrapped - Output wrapped token ID
 * @param {number} params.inputDecimals - Input token decimals
 * @param {number} params.outputDecimals - Output token decimals
 * @param {number} params.slippage - Slippage tolerance (e.g., 0.01 for 1%)
 * @param {Algodv2} params.algodClient - Algod client
 * @param {Indexer} params.indexerClient - Indexer client
 * @param {Function} params.getTokenMetaFromConfig - Function to get token metadata from config
 * @param {boolean} params.enableSimulation - Whether to enable swap.js internal simulation (default: true)
 * @param {Array<Object>} params.extraTxns - Extra transactions to include in the swap (for multi-hop routes)
 * @returns {Promise<Array<string>>} Array of base64-encoded unsigned transactions
 */
export async function buildSwapTransactions({
  sender,
  poolId,
  inputToken,
  outputToken,
  amountIn,
  minAmountOut,
  inputWrapped,
  outputWrapped,
  inputDecimals,
  outputDecimals,
  slippage,
  algodClient,
  indexerClient,
  getTokenMetaFromConfig,
  enableSimulation = true,
  extraTxns = []
}) {
  // Ensure poolId is a number (algosdk requires it to be a number, not a string)
  const poolIdNum = Number(poolId);
  if (isNaN(poolIdNum) || poolIdNum <= 0 || poolIdNum >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid poolId: ${poolId} (must be a positive number < 2^53-1)`);
  }
  
  const amountBigInt = BigInt(amountIn);
  const amountInDecimal = Number(amountBigInt) / (10 ** inputDecimals);
  const inputTokenStr = String(inputToken);
  const outputTokenStr = String(outputToken);
  
  // Create swap instance
  // Use a placeholder address if sender is not provided (for simulation)
  const addressForSwap = sender || 'H7W63MIQJMYBOEYPM5NJEGX3P54H54RZIV2G3OQ2255AULG6U74BE5KFC4';
  const swapInstance = new swap(poolIdNum, algodClient, indexerClient, {
    acc: { addr: addressForSwap, sk: new Uint8Array(0) },
    simulate: enableSimulation,
    formatBytes: true,
    waitForConfirmation: false
  });
  
  // Call Info() first to initialize the swap instance
  // This is required before calling swap() as it needs pool information
  const infoResult = await swapInstance.Info();
  if (!infoResult || !infoResult.success) {
    throw new Error(`Failed to fetch pool information for pool ${poolIdNum}: ${JSON.stringify(infoResult?.error || 'Unknown error')}`);
  }
  
  // Build token objects
  const tokenA = {
    contractId: Number(inputWrapped),
    tokenId: inputTokenStr,
    amount: amountInDecimal.toString(),
    decimals: inputDecimals,
    symbol: (getTokenMetaFromConfig(inputWrapped) || {}).symbol || undefined
  };
  
  const tokenB = {
    contractId: Number(outputWrapped),
    tokenId: outputTokenStr,
    decimals: outputDecimals,
    symbol: (getTokenMetaFromConfig(outputWrapped) || {}).symbol || undefined
  };
  
  // Generate swap transactions
  // For multi-hop routes, extraTxns can contain previous hop transactions
  const swapResult = await swapInstance.swap(
    addressForSwap,
    poolIdNum,
    tokenA,
    tokenB,
    extraTxns, // extraTxns - can include previous hop transactions for multi-hop routes
    {
      debug: false,
      slippage: slippage,
      degenMode: false,
      skipWithdraw: false
    }
  );
  
  if (!swapResult || !swapResult.success) {
    throw new Error(`Failed to generate swap transactions for pool ${poolIdNum}: ${JSON.stringify(swapResult?.error || 'Unknown error')}`);
  }
  
  // Decode transactions to add to group
  const decodedTxns = swapResult.txns.map(txn =>
    algosdk.decodeUnsignedTransaction(Buffer.from(txn, 'base64'))
  );
  
  return decodedTxns;
}

