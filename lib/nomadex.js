import algosdk from 'algosdk';
import { arc200 } from 'ulujs';

// Debug flag for verbose logging
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

/**
 * Nomadex pool interaction module
 * Handles pool info fetching, quote calculation, and transaction building
 * for Nomadex AMM pools without using the nomadex-client library
 */

/**
 * Decode base64 global state value
 */
function decodeStateValue(value) {
  // Algorand TEAL value types: 1 = byteslice, 2 = uint (verified against
  // live contract state; e.g. ARC200 name/symbol are type 1, decimals type 2).
  if (value.type === 1) {
    // byteslice: Uint8Array (algosdk 3.x) or base64 string (raw REST shape)
    return typeof value.bytes === 'string'
      ? Buffer.from(value.bytes, 'base64')
      : Buffer.from(value.bytes ?? []);
  } else if (value.type === 2) {
    // uint64: BigInt (algosdk 3.x) or number (raw REST shape)
    return BigInt(value.uint ?? 0);
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

    // algosdk 3.x exposes global state as camelCase `globalState`; older/raw REST
    // shapes use `global-state`. Accept both so state is actually read.
    const params = appInfo.application.params;
    const globalState = params.globalState ?? params['global-state'] ?? [];

    // Parse global state into a map
    const stateMap = {};
    for (const state of globalState) {
      // algosdk 3.x returns keys as Uint8Array; raw REST uses base64 strings.
      const key = (typeof state.key === 'string'
        ? Buffer.from(state.key, 'base64')
        : Buffer.from(state.key)).toString('utf-8');
      stateMap[key] = decodeStateValue(state.value);
    }
    

    let fee = BigInt(30); // Default 0.3% (30 basis points)

    // Try various fee key name patterns. Only uint-typed values are valid fees;
    // decoded byteslice/unknown values (Buffer/null) are ignored so a mistyped
    // state entry can never crash or corrupt the fee.
    const feeKeys = ['fee', 'tot_fee', 'total_fee', 'fee_bps'];

    for (const key of feeKeys) {
      if (typeof stateMap[key] === 'bigint') {
        fee = stateMap[key];
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

    // Fallback: try to get from state (only uint-typed values are valid token IDs)
    // Note: tokA can be 0 (native token), so we check for null/undefined explicitly
    if (tokA === null || tokA === undefined || tokB === null || tokB === undefined) {
      const tokAKeys = ['tok_a', 'tokA', 'token_a', 'tokenA', 'token0', 'token_0'];
      const tokBKeys = ['tok_b', 'tokB', 'token_b', 'tokenB', 'token1', 'token_1'];

      for (const key of tokAKeys) {
        if (typeof stateMap[key] === 'bigint') {
          tokA = Number(stateMap[key]);
          break;
        }
      }

      for (const key of tokBKeys) {
        if (typeof stateMap[key] === 'bigint') {
          tokB = Number(stateMap[key]);
          break;
        }
      }
    }

    // Derive authoritative reserves from the pool's on-chain holdings.
    //
    // Nomadex pool contracts do NOT expose reserves in application state; the
    // reserve for each side is the pool account's spendable holding of that
    // token. For the native token this is the account balance MINUS the account
    // min-balance requirement (mirroring the on-chain `balance - min_balance`).
    // Using the raw account balance would over-count non-reserve VOI (the
    // min-balance and any donations) and inflate constant-product quotes.
    //
    // There is no silent fallback: if a token's authoritative reserve cannot be
    // determined we throw, so the caller skips this pool rather than quoting
    // against a wrong reserve.
    if (tokA === null || tokA === undefined || tokB === null || tokB === undefined
        || Number.isNaN(Number(tokA)) || Number.isNaN(Number(tokB))) {
      throw new Error('Could not determine Nomadex pool token IDs');
    }
    if (Number(tokA) === Number(tokB)) {
      throw new Error(`Nomadex pool ${poolId} has identical token IDs (${tokA}); cannot derive reserves`);
    }

    const poolAddress = algosdk.getApplicationAddress(Number(poolId)).toString();
    const accountInfo = await algodClient.accountInformation(poolAddress).do();

    // Resolve the authoritative reserve for a single token of the pool.
    // Note: In algosdk 3.x, account/asset fields are camelCase and BigInt-valued.
    const resolveReserve = async (tokenId) => {
      // Native token: spendable balance = total balance - min-balance requirement.
      if (Number(tokenId) === 0) {
        const total = BigInt(accountInfo.amount ?? 0);
        const minBalance = accountInfo.minBalance ?? accountInfo['min-balance'];
        if (minBalance === undefined || minBalance === null) {
          throw new Error(`Pool ${poolId} account min-balance unavailable; cannot derive native reserve`);
        }
        const spendable = total - BigInt(minBalance);
        if (spendable < 0n) {
          throw new Error(`Pool ${poolId} native balance below min-balance`);
        }
        return spendable;
      }

      // ASA: use the pool account's asset holding.
      if (accountInfo.assets) {
        for (const asset of accountInfo.assets) {
          const assetId = Number(asset.assetId ?? asset['asset-id']);
          if (assetId === Number(tokenId)) {
            return BigInt(asset.amount ?? 0);
          }
        }
      }

      // ARC200: read the pool's balance from the token contract.
      const arc200Contract = new arc200(Number(tokenId), algodClient, indexerClient, {
        acc: { addr: poolAddress, sk: new Uint8Array(0) },
        simulate: true
      });
      const balanceResult = await arc200Contract.arc200_balanceOf(poolAddress);
      if (!balanceResult.success) {
        throw new Error(`Failed to read reserve for token ${tokenId} in pool ${poolId}: ${balanceResult.error}`);
      }
      return BigInt(balanceResult.returnValue);
    };

    const reserveA = await resolveReserve(tokA);
    const reserveB = await resolveReserve(tokB);

    // A pool with a non-positive reserve on either side cannot produce a valid
    // constant-product quote (a zero input reserve would return the entire
    // output reserve for any input). Fail explicitly so such a pool is skipped
    // rather than winning routing with a bogus quote.
    if (reserveA <= 0n || reserveB <= 0n) {
      throw new Error(`Nomadex pool ${poolId} has non-positive reserves (A=${reserveA}, B=${reserveB})`);
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
 * Simulate Nomadex swap transaction to discover required box references
 * @param {Object} params - Same as buildSwapTransactions
 * @param {Algodv2} params.algodClient - Algod client
 * @returns {Promise<Array<Object>>} Array of box references: [{ appIndex: number, name: Uint8Array }]
 */
async function discoverBoxReferences({
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
  try {
    const suggestedParams = await algodClient.getTransactionParams().do();
    const poolAddress = algosdk.getApplicationAddress(Number(poolId)).toString();

    // Build a test transaction group (same as actual transaction)
    let depositTxn;
    if (inputTokenType === 'native') {
      depositTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: sender,
        receiver: poolAddress,
        amount: BigInt(amountIn),
        suggestedParams
      });
    } else if (inputTokenType === 'ASA') {
      depositTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: sender,
        receiver: poolAddress,
        amount: BigInt(amountIn),
        assetIndex: Number(inputToken),
        suggestedParams
      });
    } else if (inputTokenType === 'ARC200') {
      const arc200ContractId = Number(inputToken);
      const arc200TransferMethod = getARC200TransferMethod();
      const arc200Atc = new algosdk.AtomicTransactionComposer();
      arc200Atc.addMethodCall({
        appID: arc200ContractId,
        method: arc200TransferMethod,
        methodArgs: [
          poolAddress,
          BigInt(amountIn)
        ],
        sender: sender,
        suggestedParams: suggestedParams
      });
      const arc200Txns = arc200Atc.buildGroup();
      if (arc200Txns.length !== 1) {
        throw new Error(`Expected 1 ARC200 transfer transaction, got ${arc200Txns.length}`);
      }
      depositTxn = arc200Txns[0].txn;
      depositTxn.group = undefined;
    } else {
      throw new Error(`Unsupported input token type: ${inputTokenType}`);
    }
    
    const swapMethod = getSwapMethod(isDirectionAlphaToBeta);
    const foreignAssets = [];
    if (inputTokenType === 'ASA' && Number(inputToken) !== 0) {
      foreignAssets.push(Number(inputToken));
    }
    if (outputTokenType === 'ASA' && Number(outputToken) !== 0) {
      foreignAssets.push(Number(outputToken));
    }
    const uniqueForeignAssets = [...new Set(foreignAssets)];
    
    const factoryAppId = 411751;
    const foreignApps = [factoryAppId];
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
    
    const atc = new algosdk.AtomicTransactionComposer();
    atc.addMethodCall({
      appID: Number(poolId),
      method: swapMethod,
      methodArgs: [
        {
          txn: depositTxn,
          signer: algosdk.makeEmptyTransactionSigner()
        },
        BigInt(minAmountOut)
      ],
      sender: sender,
      suggestedParams: suggestedParams,
      appForeignApps: foreignApps,
      foreignAssets: uniqueForeignAssets.length > 0 ? uniqueForeignAssets : undefined
    });
    
    const txns = atc.buildGroup().map(({ txn }) => txn);
    
    // Extract box references - use known ARC200 pattern
    // ARC200 tokens use "balances" + address format for balance boxes
    // We'll construct boxes for both sender and pool addresses for all ARC200 contracts involved
    const boxReferences = [];
    
    // Construct boxes based on ARC200 pattern
    // ARC200 uses "balances" + address format for balance boxes
    if (inputTokenType === 'ARC200' || outputTokenType === 'ARC200') {
      const balancesPrefix = Buffer.from('balances', 'utf-8');
      
      if (inputTokenType === 'ARC200' && Number(inputToken) !== 0) {
        // Add sender's balance box
        const senderAddressBytes = algosdk.Address.fromString(sender).publicKey;
        const senderBoxName = new Uint8Array(Buffer.concat([balancesPrefix, senderAddressBytes]));
        boxReferences.push({
          appIndex: Number(inputToken),
          name: senderBoxName
        });
        
        // Add pool's balance box
        const poolAddressBytes = algosdk.Address.fromString(poolAddress).publicKey;
        const poolBoxName = new Uint8Array(Buffer.concat([balancesPrefix, poolAddressBytes]));
        boxReferences.push({
          appIndex: Number(inputToken),
          name: poolBoxName
        });
      }
      
      if (outputTokenType === 'ARC200' && Number(outputToken) !== 0) {
        // Add sender's balance box
        const senderAddressBytes = algosdk.Address.fromString(sender).publicKey;
        const senderBoxName = new Uint8Array(Buffer.concat([balancesPrefix, senderAddressBytes]));
        const existing = boxReferences.find(b => {
          if (b.appIndex !== Number(outputToken)) return false;
          const bName = b.name instanceof Uint8Array ? b.name : new Uint8Array(b.name);
          return bName.length === senderBoxName.length && 
                 bName.every((val, idx) => val === senderBoxName[idx]);
        });
        if (!existing) {
          boxReferences.push({
            appIndex: Number(outputToken),
            name: senderBoxName
          });
        }
        
        // Add pool's balance box
        const poolAddressBytes = algosdk.Address.fromString(poolAddress).publicKey;
        const poolBoxName = new Uint8Array(Buffer.concat([balancesPrefix, poolAddressBytes]));
        const existingPool = boxReferences.find(b => {
          if (b.appIndex !== Number(outputToken)) return false;
          const bName = b.name instanceof Uint8Array ? b.name : new Uint8Array(b.name);
          return bName.length === poolBoxName.length && 
                 bName.every((val, idx) => val === poolBoxName[idx]);
        });
        if (!existingPool) {
          boxReferences.push({
            appIndex: Number(outputToken),
            name: poolBoxName
          });
        }
        
        // Add factory's balance box (Nomadex factory may need to access ARC200 balance during swap)
        const factoryAppId = 411751;
        const factoryAddress = algosdk.getApplicationAddress(factoryAppId).toString();
        const factoryAddressBytes = algosdk.Address.fromString(factoryAddress).publicKey;
        const factoryBoxName = new Uint8Array(Buffer.concat([balancesPrefix, factoryAddressBytes]));
        const existingFactory = boxReferences.find(b => {
          if (b.appIndex !== Number(outputToken)) return false;
          const bName = b.name instanceof Uint8Array ? b.name : new Uint8Array(b.name);
          return bName.length === factoryBoxName.length && 
                 bName.every((val, idx) => val === factoryBoxName[idx]);
        });
        if (!existingFactory) {
          boxReferences.push({
            appIndex: Number(outputToken),
            name: factoryBoxName
          });
        }
      }
    }
    
    // Remove duplicates
    const uniqueBoxes = [];
    const seen = new Set();
    for (const box of boxReferences) {
      const key = `${box.appIndex}-${Buffer.from(box.name).toString('hex')}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueBoxes.push(box);
      }
    }
    
    return uniqueBoxes;
  } catch (error) {
    // If simulation fails, return empty array (will try without boxes as fallback)
    console.warn('Failed to discover box references via simulation:', error.message);
    return [];
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
  const poolAddress = algosdk.getApplicationAddress(Number(poolId)).toString();

  // Build the deposit/transfer transaction first (this becomes the 'txn' argument)
  let depositTxn;
  if (inputTokenType === 'native') {
    depositTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: sender,
      receiver: poolAddress,
      amount: BigInt(amountIn),
      suggestedParams
    });
  } else if (inputTokenType === 'ASA') {
    depositTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: sender,
      receiver: poolAddress,
      amount: BigInt(amountIn),
      assetIndex: Number(inputToken),
      suggestedParams
    });
  } else if (inputTokenType === 'ARC200') {
    // ARC200 requires an application call to the token contract
    // For ARC200 tokens, the token ID IS the contract ID
    const arc200ContractId = Number(inputToken);
    const arc200TransferMethod = getARC200TransferMethod();
    
    // Build boxes for ARC200 transfer - need sender and pool balance boxes
    const arc200Boxes = [];
    const balancesPrefix = Buffer.from('balances', 'utf-8');
    const senderAddressBytes = algosdk.Address.fromString(sender).publicKey;
    const poolAddressBytes = algosdk.Address.fromString(poolAddress).publicKey;
    
    // Sender's balance box
    arc200Boxes.push({
      appIndex: arc200ContractId,
      name: new Uint8Array(Buffer.concat([balancesPrefix, senderAddressBytes]))
    });
    
    // Pool's balance box
    arc200Boxes.push({
      appIndex: arc200ContractId,
      name: new Uint8Array(Buffer.concat([balancesPrefix, poolAddressBytes]))
    });
    
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
      suggestedParams: suggestedParams,
      boxes: arc200Boxes.length > 0 ? arc200Boxes : undefined
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
  
  // Discover box references if ARC200 tokens are involved
  let boxReferences = [];
  if (inputTokenType === 'ARC200' || outputTokenType === 'ARC200') {
    try {
      const discoveredBoxes = await discoverBoxReferences({
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
      });
      // Convert box names to Uint8Array format expected by AtomicTransactionComposer
      boxReferences = discoveredBoxes.map(box => ({
        appIndex: box.appIndex,
        name: box.name instanceof Uint8Array ? box.name : new Uint8Array(box.name)
      }));
    } catch (error) {
      console.warn('Failed to discover box references, proceeding without boxes:', error.message);
      // Continue without boxes - transaction might still work or fail with clearer error
    }
  }
  
  // Use AtomicTransactionComposer to properly encode the ABI method call
  const atc = new algosdk.AtomicTransactionComposer();

  // Build accounts array for the app call
  // When output is an ASA, we need multiple accounts in the accounts array:
  // 1. The pool's own app address - to check the pool's ASA balance before sending
  // 2. The sender (recipient of the ASA output) - so the inner axfer can access their holding
  const accounts = [];
  if (outputTokenType === 'ASA' && Number(outputToken) !== 0) {
    // Add the pool's application address - the contract checks its own ASA balance
    const poolAppAddress = algosdk.getApplicationAddress(Number(poolId)).toString();
    accounts.push(poolAppAddress);
    if (DEBUG) console.log(`[Nomadex] Added pool app address ${poolAppAddress} to accounts for ASA balance check`);

    // Add the sender (recipient of the ASA output) to accounts
    // This is needed for the pool's inner axfer to access the sender's holding
    accounts.push(sender);
    if (DEBUG) console.log(`[Nomadex] Added sender ${sender} to accounts for ASA output holding access`);
  }

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
    foreignAssets: uniqueForeignAssets.length > 0 ? uniqueForeignAssets : undefined,
    appAccounts: accounts.length > 0 ? accounts : undefined,
    boxes: boxReferences.length > 0 ? boxReferences : undefined
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

