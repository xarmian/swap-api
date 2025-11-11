import CONTRACT from 'arccjs';
import algosdk from 'algosdk';
import { swap200 } from 'ulujs'; // Keep for Info() method for now
import BigNumber from 'bignumber.js';

/**
 * HumbleSwap transaction builder using arccjs directly
 * This COMPLETELY REPLACES ulujs swap() method to avoid simulation issues with multi-hop routes
 * 
 * Key difference: NO SIMULATION during transaction building. We intelligently determine
 * what transactions are needed based on token types and requirements, rather than
 * brute-forcing through payment combinations like ulujs does.
 */

// Import ABIs - we need to match ulujs exactly
const arc200Schema = {
  name: "ARC200",
  methods: [
    { name: "arc200_transfer", args: [{ type: "address" }, { type: "uint256" }], returns: { type: "bool" } },
    { name: "arc200_approve", args: [{ type: "address" }, { type: "uint256" }], returns: { type: "bool" } },
    { name: "arc200_balanceOf", args: [{ type: "address" }], returns: { type: "uint256" }, readonly: true },
    { name: "arc200_allowance", args: [{ type: "address" }, { type: "address" }], returns: { type: "uint256" }, readonly: true },
    { name: "arc200_decimals", args: [], returns: { type: "uint8" }, readonly: true },
  ],
  events: [],
};

const nt200Schema = {
  name: "NT200",
  methods: [
    ...arc200Schema.methods,
    { name: "deposit", args: [{ type: "uint64" }], returns: { type: "uint256" } },
    { name: "withdraw", args: [{ type: "uint64" }], returns: { type: "uint256" } },
    { name: "createBalanceBox", args: [{ type: "address" }], returns: { type: "byte" } },
  ],
  events: [],
};

const swap200Schema = {
  name: "SWAP-200",
  methods: [
    { name: "Trader_swapAForB", args: [{ type: "byte" }, { type: "uint256" }, { type: "uint256" }], returns: { type: "(uint256,uint256)" } },
    { name: "Trader_swapBForA", args: [{ type: "byte" }, { type: "uint256" }, { type: "uint256" }], returns: { type: "(uint256,uint256)" } },
    { name: "Info", args: [], returns: { type: "((uint256,uint256),(uint256,uint256),(uint256,uint256,uint256,address,byte),(uint256,uint256),uint64,uint64)" }, readonly: true },
    { name: "custom", args: [], returns: { type: "void" } },
  ],
  events: [],
};

const arc200RedeemABI = {
  name: "arc200_redeem",
  methods: [
    { name: "arc200_redeem", args: [{ type: "uint64" }], returns: { type: "void" } },
    { name: "arc200_swapBack", args: [{ type: "uint64" }], returns: { type: "void" } },
    { name: "arc200_exchange", args: [], returns: { type: "(uint64,address)" } },
  ],
  events: [],
};

const beaconABI = {
  name: "beacon",
  methods: [
    { name: "nop", args: [], returns: { type: "void" } },
  ],
  events: [],
};

/**
 * Get pool information
 */
export async function getPoolInfo(poolId, algodClient, indexerClient) {
  try {
    const swapContract = new swap200(Number(poolId), algodClient, indexerClient);
    const infoResult = await swapContract.Info();
    if (!infoResult.success) {
      throw new Error('Failed to fetch pool information: ' + JSON.stringify(infoResult.error));
    }
    return infoResult.returnValue;
  } catch (error) {
    throw new Error(`Failed to fetch pool info: ${error.message}`);
  }
}

/**
 * Create arccjs CONTRACT instance with simulation DISABLED
 */
function makeContract(contractId, algodClient, indexerClient, abi, sender, simulate = false, objectOnly = false) {
  return new CONTRACT(
    contractId,
    algodClient,
    indexerClient,
    abi,
    { addr: sender, sk: new Uint8Array(0) },
    simulate,
    false,
    objectOnly
  );
}

/**
 * Create builder pattern like ulujs but with NO SIMULATION
 * Uses objectOnly=true so methods return { obj } transaction objects
 */
function makeBuilder(algodClient, indexerClient, acc, contracts) {
  return Object.fromEntries(
    Object.entries(contracts).map(([key, { contractId, abi }]) => [
      key,
      makeContract(contractId, algodClient, indexerClient, abi, acc.addr, false, true)
    ])
  );
}

/**
 * Intelligently determine what transactions are needed for a HumbleSwap swap
 * NO BRUTE FORCE - we determine exactly what's needed based on token types and state
 */
export async function buildSwapTransactions({
  sender,
  poolId,
  inputWrapped,
  outputWrapped,
  amountIn,
  minAmountOut,
  swapAForB,
  algodClient,
  indexerClient,
  extraTxns = [],
  inputTokenId = "0", // underlying token ID (0 for VOI, >0 for ASA)
  outputTokenId = "0", // underlying token ID (0 for VOI, >0 for ASA)
  inputSymbol = "",
  outputSymbol = "",
  slippage = 0.005,
  degenMode = false,
  skipWithdraw = false,
  skipDeposit = false
}) {
  const poolIdNum = Number(poolId);
  const amountBigInt = BigInt(amountIn);
  const minAmountOutBigInt = BigInt(minAmountOut);
  const inputTokenIdNum = Number(inputTokenId);
  const outputTokenIdNum = Number(outputTokenId);

  // Get pool info
  const poolInfo = await getPoolInfo(poolIdNum, algodClient, indexerClient);
  const actualSwapAForB = swapAForB !== undefined 
    ? swapAForB 
    : (inputWrapped === poolInfo.tokA && outputWrapped === poolInfo.tokB);

  // Create account object
  const acc = {
    addr: sender,
    sk: new Uint8Array(0),
  };

  // Create contract instances for readonly calls (simulate=true is ok for readonly)
  const ciTokA = makeContract(inputWrapped, algodClient, indexerClient, arc200Schema, sender, true);
  const ciTokB = makeContract(outputWrapped, algodClient, indexerClient, arc200Schema, sender, true);
  const ciRedeemA = makeContract(inputWrapped, algodClient, indexerClient, arc200RedeemABI, sender, true);
  const ciRedeemB = makeContract(outputWrapped, algodClient, indexerClient, arc200RedeemABI, sender, true);
  // For custom(), we need simulate=true to build the transaction group
  // But we'll only use the txns from the result, not the simulation result itself
  const ciCustom = makeContract(poolIdNum, algodClient, indexerClient, { 
    name: "custom",
    methods: [{ name: "custom", args: [], returns: { type: "void" } }],
    events: []
  }, sender, true); // simulate=true so it builds txns without trying to sign

  // Get decimals
  const decAR = await ciTokA.arc200_decimals();
  if (!decAR.success) {
    throw new Error("arc200_decimals failed for input token");
  }
  const decA = Number(decAR.returnValue);

  const decBR = await ciTokB.arc200_decimals();
  if (!decBR.success) {
    throw new Error("arc200_decimals failed for output token");
  }
  const decB = Number(decBR.returnValue);

  // Check input token balance (to determine if deposit is needed)
  // If skipDeposit is true, we're receiving the token from a previous hop in the same atomic group
  // so we don't need to deposit it - it will be available after the previous transactions execute
  const balAR = await ciTokA.arc200_balanceOf(acc.addr);
  if (!balAR.success) {
    throw new Error("arc200_balanceOf failed for input token");
  }
  const balA = balAR.returnValue;
  const needsDeposit = !skipDeposit && balA < amountBigInt;

  // Check if input token has exchange (redeem capability) - for ASA tokens
  let inputHasExchange = false;
  if (inputTokenIdNum > 0 && needsDeposit) {
    const exchangeA = await ciRedeemA.arc200_exchange();
    inputHasExchange = exchangeA.success;
  }

  // Check if output token has exchange (redeem capability) - determines if we need withdraw
  let outputHasExchange = false;
  if (outputTokenIdNum >= 0 && !skipWithdraw) {
    const exchangeB = await ciRedeemB.arc200_exchange();
    outputHasExchange = exchangeB.success;
  }

  // Check allowance (to determine if approval is needed)
  let needsApproval = true;
  let approvalAmount = amountBigInt;
  if (degenMode) {
    const allowanceAR = await ciTokA.arc200_allowance(
      acc.addr,
      algosdk.getApplicationAddress(poolIdNum)
    );
    if (allowanceAR.success) {
      const allowance = allowanceAR.returnValue;
      needsApproval = allowance < amountBigInt;
      if (needsApproval) {
        approvalAmount = BigInt(2) ** BigInt(256) - BigInt(1); // max approval
      }
    }
  }

  // Create builder for transaction building (objectOnly=true, simulate=false)
  const contracts = {
    tokA: { contractId: inputWrapped, abi: nt200Schema },
    tokB: { contractId: outputWrapped, abi: nt200Schema },
    redeemA: { contractId: inputWrapped, abi: arc200RedeemABI },
    redeemB: { contractId: outputWrapped, abi: arc200RedeemABI },
    pool: { contractId: poolIdNum, abi: swap200Schema },
  };
  const builder = makeBuilder(algodClient, indexerClient, acc, contracts);

  // Build transaction objects intelligently
  const buildO = [];

  // ===========================================
  // INPUT TOKEN HANDLING
  // ===========================================
  // Optimization: If skipDeposit is true, the input token comes from a previous hop
  // in the same atomic transaction group. We skip deposit because:
  // 1. The token is already in wrapped form (from previous hop's output)
  // 2. The balance box will be created by the previous hop's transactions
  // 3. The token will be available in our balance after previous transactions execute
  
  if (needsDeposit) {
    if (inputTokenIdNum > 0) {
      // ASA token (VSA)
      if (inputHasExchange) {
        // Token has exchange - need to redeem ASA to ARC200
        const assetBalance = (
          await algodClient.accountAssetInformation(acc.addr, inputTokenIdNum).do()
        )["asset-holding"]?.amount || 0;
        
        const redeemResult = await builder.redeemA.arc200_redeem(assetBalance);
        if (redeemResult && redeemResult.obj) {
          buildO.push({
            ...redeemResult.obj,
            appIndex: inputWrapped, // Ensure appIndex is set
            from: sender, // Ensure sender is set
            xaid: inputTokenIdNum,
            aamt: assetBalance,
            note: new TextEncoder().encode(
              `Redeem ${new BigNumber(assetBalance.toString()).dividedBy(
                new BigNumber(10).pow(decA)
              ).toFixed(decA)} ${inputSymbol} to application address ${algosdk.getApplicationAddress(
                inputWrapped
              )} from user address ${acc.addr}`
            ),
          });
        }
      } else {
        // No exchange - deposit ASA directly
        // For ASA deposits, we need to set payment amount for box cost if balance is 0
        // This matches ulujs behavior: setPaymentAmount(BoxCost + amt) where amt=0 for ASA
        const BalanceBoxCost = 28500n;
        let boxCost = 0n;
        if (balA === 0n) {
          boxCost = BalanceBoxCost;
        }
        // Set payment amount on the contract instance (arccjs will create payment txn)
        builder.tokA.setPaymentAmount(boxCost);
        
        // Get the deposit method from the contract ABI
        const depositMethod = builder.tokA.contractABI.getMethodByName('deposit');
        
        // Get full transaction group from arccjs (including payment transaction)
        // We need to temporarily disable objectOnly to get the payment transaction
        const originalObjectOnly = builder.tokA.objectOnly;
        builder.tokA.objectOnly = false;
        let depositTxns;
        try {
          depositTxns = await builder.tokA.createUtxns(depositMethod, [amountBigInt]);
        } finally {
          builder.tokA.objectOnly = originalObjectOnly;
        }
        
        // Decode transactions to find payment and app call
        // Keep the original base64-encoded transactions too, in case we need to use them directly
        const decodedTxns = depositTxns.map(txn => {
          const decoded = algosdk.decodeUnsignedTransaction(Buffer.from(txn, 'base64'));
          // Clear any existing group ID - it will be assigned later when all hops are combined
          decoded.group = undefined;
          return decoded;
        });
        const paymentTxnIndex = decodedTxns.findIndex(txn => txn.type === algosdk.TransactionType.pay);
        const appCallTxnIndex = decodedTxns.findIndex(txn => txn.type === algosdk.TransactionType.appl);
        const paymentTxn = paymentTxnIndex >= 0 ? decodedTxns[paymentTxnIndex] : null;
        const appCallTxn = appCallTxnIndex >= 0 ? decodedTxns[appCallTxnIndex] : null;
        const paymentTxnBase64 = paymentTxnIndex >= 0 ? depositTxns[paymentTxnIndex] : null;
        
        if (!appCallTxn) {
          throw new Error('Failed to build deposit app call transaction');
        }
        
        // For ASA deposits, we need to include the asset in foreignAssets
        // so the contract can access the asset transfer transaction
        const depositForeignAssets = appCallTxn.foreignAssets || [];
        if (!depositForeignAssets.includes(inputTokenIdNum)) {
          depositForeignAssets.push(inputTokenIdNum);
        }
        appCallTxn.foreignAssets = depositForeignAssets;
        
        // Add payment (if exists), asset transfer, and app call to buildO
        // Payment MUST come first - the contract checks gtxna 0 Receiver to verify it goes to the app address
        // Don't include appIndex - payment transactions are identified by paymentTxn field
        // Store the base64-encoded transaction so we can use it directly if needed
        // Store appIndex separately so we can verify the payment goes to the correct address
        if (paymentTxn) {
          buildO.push({
            // Don't include appIndex in the main object - it causes the transaction to be processed as an app call
            // But store it separately so we can verify the payment address
            appIndex: inputWrapped, // Store separately for address verification
            from: sender,
            payment: BigInt(paymentTxn.amount),
            paymentTxn: paymentTxn, // Store the decoded transaction object
            paymentTxnBase64: paymentTxnBase64, // Store the original base64-encoded transaction
            note: paymentTxn.note,
          });
        }
        
        // Asset transfer goes after payment - don't include appIndex, only xaid and aamt
        buildO.push({
          // Don't include appIndex for asset transfers - it's determined by xaid and aamt
          from: sender,
          xaid: inputTokenIdNum,
          aamt: amountBigInt,
          to: algosdk.getApplicationAddress(inputWrapped), // Store the app address as 'to' for asset transfer
          note: new TextEncoder().encode(
            `Asset transfer for deposit ${new BigNumber(amountBigInt.toString()).dividedBy(
              new BigNumber(10).pow(decA)
            ).toFixed(decA)} ${inputSymbol}`
          ),
        });
        
        // App call transaction - update foreignAssets to include the asset
        appCallTxn.foreignAssets = depositForeignAssets;
        buildO.push({
          appIndex: inputWrapped,
          from: sender,
          appCallTxn: appCallTxn, // Store the actual transaction object
          foreignAssets: depositForeignAssets,
          note: new TextEncoder().encode(
            `Deposit ${new BigNumber(amountBigInt.toString()).dividedBy(
              new BigNumber(10).pow(decA)
            ).toFixed(decA)} ${inputSymbol} to application address ${algosdk.getApplicationAddress(
              inputWrapped
            )} from user address ${acc.addr}`
          ),
        });
      }
    } else {
      // VOI (native token)
      // Only create balance box if user doesn't already have a balance
      // (If balA > 0, the balance box already exists)
      if (balA === 0n) {
        const balanceBoxResult = await builder.tokA.createBalanceBox(acc.addr);
        if (balanceBoxResult && balanceBoxResult.obj) {
          buildO.push({
            ...balanceBoxResult.obj,
            appIndex: inputWrapped, // Ensure appIndex is set to the wrapped token contract
            from: sender, // Ensure sender is set
            payment: 28500, // Payment to create balance box
          });
        }
      }
      
      // Then deposit VOI
      const depositResult = await builder.tokA.deposit(amountBigInt);
      if (depositResult && depositResult.obj) {
        buildO.push({
          ...depositResult.obj,
          appIndex: inputWrapped, // Ensure appIndex is set to the wrapped token contract
          from: sender, // Ensure sender is set
          payment: amountBigInt, // Payment is the deposit amount for VOI
          note: new TextEncoder().encode(
            `Deposit ${new BigNumber(amountBigInt.toString()).dividedBy(
              new BigNumber(10).pow(decA)
            ).toFixed(decA)} ${inputSymbol} to application address ${algosdk.getApplicationAddress(
              inputWrapped
            )} from user address ${acc.addr}`
          ),
        });
      }
    }
  }

  // ===========================================
  // APPROVAL
  // ===========================================
  
  if (needsApproval) {
    // Some ARC200 tokens like wVOI require a payment transaction before the approval call
    // Try setting payment amount on the builder to make arccjs create the payment transaction
    // Use balance box cost (28500) as the payment amount - this is what's used for balance box creation
    const BalanceBoxCost = 28500n;
    builder.tokA.setPaymentAmount(BalanceBoxCost);
    
    // Get the approve method from the contract ABI
    const approveMethod = builder.tokA.contractABI.getMethodByName('arc200_approve');
    
    // Get full transaction group from arccjs (including potential payment transaction)
    // We need to temporarily disable objectOnly to get the payment transaction
    const originalObjectOnly = builder.tokA.objectOnly;
    builder.tokA.objectOnly = false;
    let approveTxns;
    try {
      approveTxns = await builder.tokA.createUtxns(approveMethod, [
        algosdk.getApplicationAddress(poolIdNum),
        approvalAmount
      ]);
    } finally {
      builder.tokA.objectOnly = originalObjectOnly;
    }
    
    // Decode transactions to find payment and app call
    // Keep the original base64-encoded transactions too, in case we need to use them directly
    const decodedTxns = approveTxns.map(txn => {
      const decoded = algosdk.decodeUnsignedTransaction(Buffer.from(txn, 'base64'));
      // Clear any existing group ID - it will be assigned later when all hops are combined
      decoded.group = undefined;
      return decoded;
    });
    
    const paymentTxnIndex = decodedTxns.findIndex(txn => txn.type === algosdk.TransactionType.pay);
    const appCallTxnIndex = decodedTxns.findIndex(txn => txn.type === algosdk.TransactionType.appl);
    const paymentTxn = paymentTxnIndex >= 0 ? decodedTxns[paymentTxnIndex] : null;
    const appCallTxn = appCallTxnIndex >= 0 ? decodedTxns[appCallTxnIndex] : null;
    const paymentTxnBase64 = paymentTxnIndex >= 0 ? approveTxns[paymentTxnIndex] : null;
    
    const expectedAppAddress = algosdk.getApplicationAddress(inputWrapped);
    
    if (!appCallTxn) {
      throw new Error('Failed to build approval app call transaction');
    }
    
    // Add payment transaction to buildO before the approval app call (if it exists)
    // Payment MUST come first - the contract checks CurrentApplicationAddress == payment.to
    // Don't include appIndex - payment transactions are identified by paymentTxn field
    // Store the base64-encoded transaction so we can use it directly if needed
    // Store appIndex separately so we can verify the payment goes to the correct address
    if (paymentTxn) {
      // Verify the payment goes to the correct app address (inputWrapped)
      let paymentTo;
      if (typeof paymentTxn.to === 'string') {
        paymentTo = paymentTxn.to;
      } else if (paymentTxn.to && paymentTxn.to.publicKey) {
        paymentTo = algosdk.encodeAddress(paymentTxn.to.publicKey);
      } else if (Buffer.isBuffer(paymentTxn.to)) {
        paymentTo = algosdk.encodeAddress(new Uint8Array(paymentTxn.to));
      } else if (paymentTxn.to instanceof Uint8Array) {
        paymentTo = algosdk.encodeAddress(paymentTxn.to);
      } else if (Array.isArray(paymentTxn.to)) {
        paymentTo = algosdk.encodeAddress(new Uint8Array(paymentTxn.to));
      } else {
        throw new Error(`Invalid paymentTo address in approval payment transaction: ${paymentTxn.to}`);
      }
      
      buildO.push({
        // Don't include appIndex in the main object - it causes the transaction to be processed as an app call
        // But store it separately so we can verify the payment address
        appIndex: inputWrapped, // Store separately for address verification
        from: sender,
        payment: BigInt(paymentTxn.amount),
        paymentTxn: paymentTxn, // Store the decoded transaction object
        paymentTxnBase64: paymentTxnBase64, // Store the original base64-encoded transaction
        note: paymentTxn.note,
      });
    } else {
      // Some ARC200 tokens like wVOI require a payment transaction before the approval call
      // The contract checks CurrentApplicationAddress == payment.to and payment amount > 0
      // If arccjs doesn't provide one, we need to create it manually
      // Use balance box cost (28500) as the payment amount
      const BalanceBoxCost = 28500n;
      
      // Create a payment transaction to the wVOI app address
      // The amount should be 28500 (balance box cost) - the contract checks amount > 0
      buildO.push({
        appIndex: inputWrapped, // Store separately for address verification
        from: sender,
        payment: BalanceBoxCost, // Payment amount is balance box cost
        paymentTxn: null, // We'll create it during transaction building
        paymentTxnBase64: null,
        note: new TextEncoder().encode(`Payment for wVOI approval`),
      });
    }
    
    // Add the approval app call transaction
    // Don't manually add boxes - let simulation discover them via allowUnnamedResources
    buildO.push({
      appIndex: inputWrapped, // Approval is for the input wrapped token contract
      from: sender, // Ensure sender is set
      appCallTxn: appCallTxn, // Store the actual transaction object
      note: new TextEncoder().encode(
        `Approve ${degenMode ? 'max' : new BigNumber(amountBigInt.toString()).dividedBy(
          new BigNumber(10).pow(decA)
        ).toFixed(decA)} ${inputSymbol} to application address ${algosdk.getApplicationAddress(
          poolIdNum
        )} from user address ${acc.addr}`
      ),
    });
  }

  // ===========================================
  // OUTPUT TOKEN BALANCE ENSUREMENT
  // ===========================================
  
  // For pure ARC200 tokens, we need to ensure both pool and user balance boxes exist
  // The pool needs its balance box to hold tokens, and the user needs their balance box
  // to receive tokens when the pool transfers to them
  
  const poolAddress = algosdk.getApplicationAddress(poolIdNum);
  
  // Check if output is pure ARC200 (not NT200, not wrapped ASA)
  const isOutputPureARC200 = outputWrapped === outputTokenIdNum && outputTokenIdNum !== 0 && outputWrapped !== 390001;
  
  // Check pool's balance - if it has a balance, the box exists
  const poolBalanceR = await ciTokB.arc200_balanceOf(poolAddress);
  const poolHasBalance = poolBalanceR.success && poolBalanceR.returnValue > 0n;
  
  if (!poolHasBalance) {
    // Pool doesn't have a balance, so we need to create the balance box
    const transferResult = await builder.tokB.arc200_transfer(
      poolAddress,
      0n
    );
    if (transferResult && transferResult.obj) {
      buildO.push({
        ...transferResult.obj,
        appIndex: outputWrapped, // Transfer is for the output wrapped token contract
        from: sender, // Ensure sender is set
        payment: 28501, // Standard payment for balance ensurement
        note: new TextEncoder().encode(
          `Transfer 0 ${outputSymbol} to application address ${poolAddress} from user address ${acc.addr}`
        ),
      });
    }
  }
  
  // For pure ARC200 tokens, also ensure user's balance box exists
  // This is needed so the pool can transfer tokens to the user
  if (isOutputPureARC200) {
    const userBalanceR = await ciTokB.arc200_balanceOf(acc.addr);
    const userHasBalance = userBalanceR.success && userBalanceR.returnValue > 0n;
    
    if (!userHasBalance) {
      // User doesn't have a balance, so we need to create the balance box
      // Transfer 0 tokens from user to themselves to create the box
      const userTransferResult = await builder.tokB.arc200_transfer(
        acc.addr,
        0n
      );
      if (userTransferResult && userTransferResult.obj) {
        buildO.push({
          ...userTransferResult.obj,
          appIndex: outputWrapped, // Transfer is for the output wrapped token contract
          from: sender, // Ensure sender is set
          payment: 28501, // Standard payment for balance ensurement
          note: new TextEncoder().encode(
            `Transfer 0 ${outputSymbol} to user address ${acc.addr} to create balance box`
          ),
        });
      }
    }
  }

  // ===========================================
  // BEACON TRANSACTIONS (if needed for resources)
  // ===========================================
  
  // Only add beacon transactions if:
  // 1. We have fewer than 2 transactions in buildO
  // 2. We're NOT in a multi-hop scenario (no extraTxns from previous hops)
  // In multi-hop scenarios, we already have transactions from previous hops,
  // so beacons are unnecessary and just add overhead
  if (buildO.length < 2 && extraTxns.length === 0) {
    const beaconId = ciCustom.getBeaconId();
    const beaconBuilder = makeBuilder(algodClient, indexerClient, acc, {
      beacon: {
        contractId: beaconId,
        abi: beaconABI
      }
    });
    
    const timestamp = Math.floor(Date.now() / 1000);
    // Need at least 2 transactions for proper resource sharing
    while (buildO.length < 2) {
      const beaconResult = await beaconBuilder.beacon.nop();
      if (beaconResult && beaconResult.obj) {
        buildO.push({
          ...beaconResult.obj,
          appIndex: beaconId, // Ensure appIndex is set
          from: sender, // Ensure sender is set
          note: new TextEncoder().encode(
            `beacon transaction (SWAP ${outputSymbol}/${inputSymbol}) ${timestamp}-${buildO.length}`
          ),
        });
      } else {
        break; // Can't create beacon, proceed anyway
      }
    }
  }

  // ===========================================
  // SWAP TRANSACTION
  // ===========================================
  
  const swapMethod = actualSwapAForB ? "Trader_swapAForB" : "Trader_swapBForA";
  builder.pool.setFee(5000);
  
  // Temporarily disable objectOnly to get the actual transaction with all foreignApps
  // Then extract foreignApps from the actual transaction
  const originalObjectOnly = builder.pool.objectOnly;
  builder.pool.objectOnly = false;
  let swapTxns;
  let swapForeignApps = [];
  try {
    swapTxns = await builder.pool.createUtxns(
      builder.pool.contractABI.getMethodByName(swapMethod),
      [0, amountBigInt, minAmountOutBigInt]
    );
    
    // Decode the swap transaction to get its foreignApps
    const decodedSwapTxns = swapTxns.map(txn => algosdk.decodeUnsignedTransaction(Buffer.from(txn, 'base64')));
    const swapTxn = decodedSwapTxns.find(txn => txn.type === algosdk.TransactionType.appl);
    if (swapTxn && swapTxn.foreignApps) {
      swapForeignApps = [...swapTxn.foreignApps];
    }
  } finally {
    builder.pool.objectOnly = originalObjectOnly;
  }
  
  // Get the obj result for the transaction structure
  const swapResult = await builder.pool[swapMethod](
    0, // byte arg
    amountBigInt,
    minAmountOutBigInt // Use minAmountOut directly - NO SIMULATION!
  );

  if (!swapResult || !swapResult.obj) {
    throw new Error(`Failed to build swap transaction`);
  }

  // Preserve foreignApps from the actual transaction (includes all apps arccjs determined)
  // If we didn't get foreignApps from the transaction, fall back to swapResult.obj.foreignApps
  if (swapForeignApps.length === 0 && swapResult.obj.foreignApps) {
    swapForeignApps = [...swapResult.obj.foreignApps];
  }
  
  // Get beacon ID - the swap contract might need it
  const beaconId = ciCustom.getBeaconId();
  if (beaconId && !swapForeignApps.includes(beaconId)) {
    swapForeignApps.push(beaconId);
  }
  
  // Ensure wrapped tokens are included (they should be, but double-check)
  if (!swapForeignApps.includes(inputWrapped)) {
    swapForeignApps.push(inputWrapped);
  }
  if (!swapForeignApps.includes(outputWrapped)) {
    swapForeignApps.push(outputWrapped);
  }

  buildO.push({
    ...swapResult.obj,
    appIndex: poolIdNum, // Swap is for the pool contract
    from: sender, // Ensure sender is set
    foreignApps: swapForeignApps, // Include both wrapped token contracts
    note: new TextEncoder().encode(
      `Swap ${new BigNumber(amountBigInt.toString()).dividedBy(
        new BigNumber(10).pow(decA)
      ).toFixed(decA)} ${inputSymbol} for minimum ${new BigNumber(minAmountOutBigInt.toString()).dividedBy(
        new BigNumber(10).pow(decB)
      ).toFixed(decB)} ${outputSymbol} from application address ${algosdk.getApplicationAddress(
        poolIdNum
      )} to user address ${acc.addr}`
    ),
  });

  // ===========================================
  // OUTPUT TOKEN WITHDRAW
  // ===========================================
  // Optimization: If skipWithdraw is true, the output token is needed by the next hop
  // in the same atomic transaction group. We skip withdraw because:
  // 1. The token is already in wrapped form (what the next hop needs)
  // 2. Keeping it in wrapped form avoids unnecessary unwrap/wrap cycles
  // 3. The next hop can use it directly from our balance
  
  // Check if output token supports withdraw method
  // Pure ARC200 tokens (like SHELLY) don't have withdraw - only NT200 tokens (like wVOI) do
  // We can detect this by trying to check if the token has the withdraw method
  // For now, we'll check if outputWrapped === outputTokenIdNum (meaning it's not wrapped)
  // AND it's not wVOI (390001) which we know is NT200
  // This is a heuristic - ideally we'd check the contract ABI, but that's expensive
  const isWrapped = outputWrapped !== outputTokenIdNum;
  const isKnownNT200 = outputWrapped === 390001; // wVOI is NT200
  const mightBePureARC200 = !isWrapped && !isKnownNT200 && outputTokenIdNum !== 0;
  
  // For pure ARC200 tokens, try to skip withdraw and let the pool handle it
  // But we need to be careful - if the pool doesn't handle it, we'll need withdraw
  // For now, skip withdraw for tokens that look like pure ARC200 (not wrapped, not wVOI)
  if (!skipWithdraw && outputTokenIdNum >= 0 && !outputHasExchange && !mightBePureARC200) {
    // Withdraw output token (unless it has exchange, which means it auto-converts)
    // This is for NT200 tokens (like wVOI) and ASAs, not pure ARC200 tokens
    const withdrawResult = await builder.tokB.withdraw(minAmountOutBigInt);
    if (withdrawResult && withdrawResult.obj) {
      const withdrawTxn = {
        ...withdrawResult.obj,
        appIndex: outputWrapped, // Withdraw is for the output wrapped token contract
        from: sender, // Ensure sender is set
        note: new TextEncoder().encode(
          `Withdraw ${new BigNumber(minAmountOutBigInt.toString()).dividedBy(
            new BigNumber(10).pow(decB)
          ).toFixed(decB)} ${outputSymbol} from application address ${algosdk.getApplicationAddress(
            outputWrapped
          )} to user address ${acc.addr}`
        ),
      };
      
      // If output is ASA (not ARC200), we need opt-in, so add asset transfer fields
      // ASAs have outputWrapped !== outputTokenIdNum (they wrap to a contract)
      // Only add asset opt-in fields if it's an ASA (wrapped token)
      if (outputWrapped !== outputTokenIdNum && outputTokenIdNum > 0) {
        withdrawTxn.xaid = outputTokenIdNum;
        withdrawTxn.snd = acc.addr;
        withdrawTxn.arcv = acc.addr;
      }
      
      buildO.push(withdrawTxn);
    }
  }

  // ===========================================
  // BUILD TRANSACTION GROUP MANUALLY (NO SIMULATION!)
  // ===========================================
  
  // Get suggested params
  const suggestedParams = await algodClient.getTransactionParams().do();
  
  // Build transaction group manually from buildO objects
  // This avoids simulation which fails for multi-hop routes
  const txns = [];
  
  // Process only transactions from buildO (arccjs format)
  // Note: extraTxns are previous hop transactions passed for context only,
  // they should NOT be included in this hop's transaction group
  const allTxns = buildO;
  
  let txnIndex = 0;
  for (const txn of allTxns) {
    // If it's already an algosdk.Transaction, use it directly
    if (txn instanceof algosdk.Transaction) {
      // Clear any existing group ID - it will be assigned later when all hops are combined
      txn.group = undefined;
      txns.push(txn);
      txnIndex++;
      continue;
    }
    
    const txnSender = txn.from || txn.sender || sender;
    const txnAppIndex = txn.appIndex;
    
    // Validate sender address
    if (!txnSender || typeof txnSender !== 'string') {
      continue;
    }
    
    // Handle asset transfers (xaid + aamt) - these go BEFORE the app call
    if (txn.xaid && txn.aamt) {
      // Get the app address from 'to' field or calculate from appIndex
      let assetTransferTo;
      if (txn.to) {
        assetTransferTo = txn.to;
      } else if (txnAppIndex && typeof txnAppIndex === 'number') {
        assetTransferTo = algosdk.getApplicationAddress(txnAppIndex);
      } else {
        continue;
      }
      const assetTransferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        suggestedParams: {
          ...suggestedParams,
          flatFee: true,
          fee: 1000,
        },
        from: txnSender,
        to: assetTransferTo,
        amount: BigInt(txn.aamt),
        assetIndex: Number(txn.xaid),
        note: txn.note,
      });
      assetTransferTxn.group = undefined; // Clear group ID - will be assigned later
      txns.push(assetTransferTxn);
      txnIndex++;
      continue; // Skip to next transaction - don't process as app call
    }
    
    // Handle payments - these go BEFORE the app call
    // For NT200 deposits, the contract expects a payment transaction to the app address
    // even if the amount is 0 (for box cost when balance already exists)
    if (txn.paymentTxn) {
      // Try to use the original transaction from arccjs if we have the base64 version
      // This ensures the exact structure that arccjs created is preserved
      if (txn.paymentTxnBase64) {
        // Decode the original transaction from arccjs
        const originalPaymentTxn = algosdk.decodeUnsignedTransaction(Buffer.from(txn.paymentTxnBase64, 'base64'));
        
        // Convert addresses to strings (algosdk 2.x decoded transactions may have address objects)
        let paymentFrom;
        if (typeof originalPaymentTxn.from === 'string') {
          paymentFrom = originalPaymentTxn.from;
        } else if (originalPaymentTxn.from && originalPaymentTxn.from.publicKey) {
          paymentFrom = algosdk.encodeAddress(originalPaymentTxn.from.publicKey);
        } else if (Buffer.isBuffer(originalPaymentTxn.from)) {
          // Buffer extends Uint8Array but may not be detected by instanceof
          paymentFrom = algosdk.encodeAddress(new Uint8Array(originalPaymentTxn.from));
        } else if (originalPaymentTxn.from instanceof Uint8Array) {
          paymentFrom = algosdk.encodeAddress(originalPaymentTxn.from);
        } else if (Array.isArray(originalPaymentTxn.from)) {
          // Sometimes addresses are arrays
          paymentFrom = algosdk.encodeAddress(new Uint8Array(originalPaymentTxn.from));
        } else {
          throw new Error(`Invalid paymentFrom address: ${originalPaymentTxn.from}`);
        }
        
        let paymentTo;
        if (typeof originalPaymentTxn.to === 'string') {
          paymentTo = originalPaymentTxn.to;
        } else if (originalPaymentTxn.to && originalPaymentTxn.to.publicKey) {
          paymentTo = algosdk.encodeAddress(originalPaymentTxn.to.publicKey);
        } else if (Buffer.isBuffer(originalPaymentTxn.to)) {
          // Buffer extends Uint8Array but may not be detected by instanceof
          paymentTo = algosdk.encodeAddress(new Uint8Array(originalPaymentTxn.to));
        } else if (originalPaymentTxn.to instanceof Uint8Array) {
          paymentTo = algosdk.encodeAddress(originalPaymentTxn.to);
        } else if (Array.isArray(originalPaymentTxn.to)) {
          // Sometimes addresses are arrays
          paymentTo = algosdk.encodeAddress(new Uint8Array(originalPaymentTxn.to));
        } else {
          throw new Error(`Invalid paymentTo address: ${originalPaymentTxn.to}`);
        }
        
        // Recreate the transaction with ALL fields preserved exactly
        // Don't modify the decoded transaction directly as it may corrupt internal state
        const recreatedPaymentTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          suggestedParams: {
            ...suggestedParams,
            flatFee: true,
            fee: originalPaymentTxn.fee || 1000,
          },
          from: paymentFrom,
          to: paymentTo,
          amount: originalPaymentTxn.amount,
          note: originalPaymentTxn.note,
          lease: originalPaymentTxn.lease,
          closeRemainderTo: originalPaymentTxn.closeRemainderTo,
          rekeyTo: originalPaymentTxn.rekeyTo,
        });
        recreatedPaymentTxn.group = undefined; // Clear group ID - will be assigned later
        
        txns.push(recreatedPaymentTxn);
        txnIndex++;
        continue; // Skip to next transaction - don't process as app call even if appIndex is set
      }
      
      // Fallback: Recreate the payment transaction from the decoded one
      // Convert addresses to strings (algosdk 2.x decoded transactions may have address objects)
      let paymentFrom;
      if (typeof txn.paymentTxn.from === 'string') {
        paymentFrom = txn.paymentTxn.from;
      } else if (txn.paymentTxn.from && txn.paymentTxn.from.publicKey) {
        paymentFrom = algosdk.encodeAddress(txn.paymentTxn.from.publicKey);
      } else if (txn.paymentTxn.from instanceof Uint8Array) {
        paymentFrom = algosdk.encodeAddress(txn.paymentTxn.from);
      } else {
        throw new Error(`Invalid paymentFrom address: ${JSON.stringify(txn.paymentTxn.from)}`);
      }
      
      let paymentTo;
      if (typeof txn.paymentTxn.to === 'string') {
        paymentTo = txn.paymentTxn.to;
      } else if (txn.paymentTxn.to && txn.paymentTxn.to.publicKey) {
        paymentTo = algosdk.encodeAddress(txn.paymentTxn.to.publicKey);
      } else if (txn.paymentTxn.to instanceof Uint8Array) {
        paymentTo = algosdk.encodeAddress(txn.paymentTxn.to);
      } else {
        throw new Error(`Invalid paymentTo address: ${JSON.stringify(txn.paymentTxn.to)}`);
      }
      
      const paymentTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        suggestedParams: {
          ...suggestedParams,
          flatFee: true,
          fee: 1000,
        },
        from: paymentFrom,
        to: paymentTo, // Use arccjs's original address - don't override
        amount: txn.paymentTxn.amount,
        note: txn.paymentTxn.note,
      });
      paymentTxn.group = undefined; // Clear group ID - will be assigned later
      txns.push(paymentTxn);
      txnIndex++;
      continue; // Skip to next transaction - don't process as app call even if appIndex is set
    } else if (txn.payment !== undefined && txn.payment !== null) {
      if (!txnAppIndex || typeof txnAppIndex !== 'number') {
        continue;
      }
      // Create payment transaction manually (for cases where arccjs didn't create it)
      // This is used for wVOI approvals where arccjs doesn't create a payment transaction
      const paymentToAddress = algosdk.getApplicationAddress(txnAppIndex);
      const paymentTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        suggestedParams: {
          ...suggestedParams,
          flatFee: true,
          fee: 1000,
        },
        from: txnSender,
        to: paymentToAddress,
        amount: BigInt(txn.payment || 0),
        note: txn.note,
      });
      paymentTxn.group = undefined; // Clear group ID - will be assigned later
      txns.push(paymentTxn);
      txnIndex++;
    }
    
    // Handle asset opt-in (xaid + snd + arcv + no xamt)
    if (txn.xaid && txn.snd && txn.arcv && !txn.xamt) {
      const optInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        suggestedParams: {
          ...suggestedParams,
          flatFee: true,
          fee: 1000,
        },
        from: txn.snd,
        to: txn.arcv,
        amount: 0,
        assetIndex: Number(txn.xaid),
        note: txn.note,
      });
      optInTxn.group = undefined; // Clear group ID - will be assigned later
      txns.push(optInTxn);
      txnIndex++;
    }
    
    // Handle application calls (from arccjs obj format)
    if (txn.appCallTxn) {
      // Recreate the transaction from the decoded one to ensure it's valid
      // Don't modify the decoded transaction directly as it may break appArgs
      const methodName = txn.appCallTxn.appArgs && txn.appCallTxn.appArgs.length > 0 
        ? `Method: 0x${Buffer.from(txn.appCallTxn.appArgs[0]).toString('hex')}`
        : 'App Call';
      
      // Get foreignAssets from buildO if provided, otherwise use from decoded txn
      const finalForeignAssets = txn.foreignAssets || txn.appCallTxn.foreignAssets || [];
      
      // Get foreignApps from buildO if provided (e.g., for swap transaction), otherwise use from decoded txn
      // This is important because we explicitly set foreignApps for swap transactions
      const finalForeignApps = txn.foreignApps || txn.appCallTxn.foreignApps || [];
      
      // Recreate the app call transaction with updated params and foreignAssets
      // Convert address to string (algosdk 2.x decoded transactions may have address objects)
      const appCallFrom = typeof txn.appCallTxn.from === 'string'
        ? txn.appCallTxn.from
        : algosdk.encodeAddress(txn.appCallTxn.from.publicKey || txn.appCallTxn.from);
      
      // Normalize boxes - ensure appIndex is a number and name is Uint8Array
      const normalizedBoxes = [];
      if (txn.appCallTxn.boxes && Array.isArray(txn.appCallTxn.boxes)) {
        for (const box of txn.appCallTxn.boxes) {
          if (!box || typeof box !== 'object') continue;
          
          // Handle appIndex - must be a number
          let appIndex;
          if (typeof box.appIndex === 'number') {
            appIndex = box.appIndex;
          } else if (box.appIndex !== undefined && box.appIndex !== null) {
            appIndex = Number(box.appIndex);
            if (isNaN(appIndex)) {
              continue;
            }
          } else {
            continue;
          }
          
          // Handle name - must be Uint8Array (not Buffer, even though Buffer extends Uint8Array)
          let name;
          if (box.name instanceof Buffer) {
            // Buffer extends Uint8Array but algosdk needs a pure Uint8Array
            name = new Uint8Array(box.name);
          } else if (box.name instanceof Uint8Array) {
            // Check if it's actually a Buffer (Buffer instanceof Uint8Array is true)
            if (Buffer.isBuffer(box.name)) {
              name = new Uint8Array(box.name);
            } else {
              name = box.name;
            }
          } else if (Array.isArray(box.name)) {
            name = new Uint8Array(box.name);
          } else if (typeof box.name === 'string') {
            name = new TextEncoder().encode(box.name);
          } else if (box.name !== undefined && box.name !== null) {
            // Try to convert to Uint8Array
            try {
              name = new Uint8Array(box.name);
            } catch (e) {
              continue;
            }
          } else {
            continue;
          }
          
          normalizedBoxes.push({
            appIndex: appIndex,
            name: name
          });
        }
      }
      
      // Ensure appArgs are properly formatted - they must be Uint8Array
      const appArgs = (txn.appCallTxn.appArgs || []).map(arg => {
        if (arg instanceof Uint8Array) {
          // Check if it's actually a Buffer and convert if needed
          if (Buffer.isBuffer(arg)) {
            return new Uint8Array(arg);
          }
          return arg;
        } else if (arg instanceof Buffer) {
          return new Uint8Array(arg);
        } else if (Array.isArray(arg)) {
          return new Uint8Array(arg);
        } else {
          // Try to convert
          return new Uint8Array(arg);
        }
      });
      
      const appCallTxn = algosdk.makeApplicationCallTxnFromObject({
        suggestedParams: {
          ...suggestedParams,
          flatFee: true,
          fee: txn.fee || 4000,
        },
        from: appCallFrom,
        appIndex: txn.appCallTxn.appIndex,
        appArgs: appArgs, // Use normalized appArgs
        onComplete: txn.appCallTxn.onComplete || 0,
        foreignApps: finalForeignApps, // Use foreignApps from buildO if set (e.g., for swap)
        foreignAssets: finalForeignAssets,
        accounts: txn.appCallTxn.accounts || [],
        // DON'T include boxes from arccjs - we'll discover them via simulation with allowUnnamedResources
        // boxes: normalizedBoxes,
        boxes: [], // Start with empty boxes - simulation will discover what's needed
        note: txn.appCallTxn.note,
      });
      appCallTxn.group = undefined; // Clear group ID - will be assigned later
      txns.push(appCallTxn);
      txnIndex++;
    } else if (txnAppIndex) {
      // Convert appArgs if they're Uint8Array (already encoded) or need encoding
      // Normalize appArgs to ensure they're all Uint8Array
      let appArgs = (txn.appArgs || []).map(arg => {
        if (arg instanceof Buffer) {
          return new Uint8Array(arg);
        } else if (arg instanceof Uint8Array) {
          if (Buffer.isBuffer(arg)) {
            return new Uint8Array(arg);
          }
          return arg;
        } else if (Array.isArray(arg)) {
          return new Uint8Array(arg);
        } else {
          return new Uint8Array(arg);
        }
      });
      
      if (appArgs.length === 0) {
        // Skip this transaction - it will fail anyway
        continue;
      }
      
      // Ensure all box app IDs are in foreignApps (required by Algorand)
      // IMPORTANT: Use foreignApps from buildO if set (e.g., for swap transaction with beacon ID)
      let foreignApps = txn.foreignApps || [];
      if (txn.boxes && txn.boxes.length > 0) {
        // Create a Set to track unique app IDs
        const foreignAppsSet = new Set(foreignApps);
        // Add box app IDs to foreignApps
        for (const box of txn.boxes) {
          const boxAppId = typeof box.appIndex === 'number' ? box.appIndex : Number(box.appIndex);
          foreignAppsSet.add(boxAppId);
        }
        foreignApps = Array.from(foreignAppsSet);
      }
      
      const appCallTxn = algosdk.makeApplicationCallTxnFromObject({
        suggestedParams: {
          ...suggestedParams,
          flatFee: true,
          fee: txn.fee || 4000,
        },
        from: txnSender,
        appIndex: txnAppIndex,
        appArgs: appArgs,
        onComplete: txn.onComplete || 0,
        foreignApps: foreignApps,
        foreignAssets: txn.foreignAssets || [],
        accounts: txn.accounts || [],
        // DON'T include boxes from buildO - we'll discover them via simulation with allowUnnamedResources
        boxes: [], // Start with empty boxes - simulation will discover what's needed
        note: txn.note,
      });
      appCallTxn.group = undefined; // Clear group ID - will be assigned later
      txns.push(appCallTxn);
      txnIndex++;
    }
  }
  
  // DON'T assign group ID here - it will be assigned later when all hops are combined
  // The caller (lib/transactions.js) will assign the group ID to the entire multi-hop group
  
  return txns;
}

/**
 * Get a summary string for an algosdk.Transaction
 */
function getTransactionSummary(txn, index) {
  if (txn.type === 'pay') {
    const from = algosdk.encodeAddress(txn.from.publicKey);
    const to = algosdk.encodeAddress(txn.to.publicKey);
    return `Payment: ${from} -> ${to}, Amount: ${txn.amount} microAlgos`;
  } else if (txn.type === 'axfer') {
    const from = algosdk.encodeAddress(txn.from.publicKey);
    const to = algosdk.encodeAddress(txn.to.publicKey);
    return `Asset Transfer: ${from} -> ${to}, Asset: ${txn.assetIndex}, Amount: ${txn.amount}`;
  } else if (txn.type === 'appl') {
    const from = algosdk.encodeAddress(txn.from.publicKey);
    const noteText = txn.note ? new TextDecoder().decode(txn.note).substring(0, 40) : 'No note';
    let summary = `App Call: ${from} -> App ${txn.appIndex}`;
    if (txn.boxes && txn.boxes.length > 0) {
      summary += `, ${txn.boxes.length} box(es)`;
    }
    if (txn.foreignApps && txn.foreignApps.length > 0) {
      summary += `, ${txn.foreignApps.length} foreign app(s)`;
    }
    return summary;
  }
  return `Transaction ${index}: ${txn.type || 'unknown'}`;
}
