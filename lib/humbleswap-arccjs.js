import CONTRACT from 'arccjs';
import algosdk from 'algosdk';
import { swap200 } from 'ulujs'; // Keep for Info() method for now
import BigNumber from 'bignumber.js';
import { getTokenDecimals } from './utils.js';

// Debug flag for verbose logging
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

// Safety buffer (in basis points) shaved off expectedAmountOut when deciding how
// much to withdraw() from the wrapped balance. withdraw(uint64) REVERTS when the
// requested amount exceeds the caller's wrapped balance (verified on-chain against
// wVOI app 390001 and wUSDC NT200 app 395614: `assert callerBalance >= amount`, no
// clamp/min/withdraw-all). Because pool reserves can drift between quote-time and
// submission, the actual credited output A only satisfies A >= minAmountOut (the
// swap's own on-chain floor), so withdrawing exactly expectedAmountOut reverts any
// swap the pool WOULD fill whose A lands in [minAmountOut, expectedAmountOut). Shaving
// this small buffer lets those micro-drift swaps succeed. The buffer itself strands at
// most ~0.1% of output (expectedAmountOut - W); any extra left by favorable drift where
// A > expectedAmountOut is separate. All stranded wrapped balance is recoverable via
// /unwrap. See TASK-41.
const WITHDRAW_BUFFER_BPS = 10n; // 0.1%
const BPS_DENOMINATOR = 10000n;

/**
 * Amount to withdraw() from the wrapped balance after a HumbleSwap swap.
 *
 * Shaves WITHDRAW_BUFFER_BPS off expectedAmountOut (floor division), then floors the
 * result at minAmountOut so it never drops below the swap's enforced on-chain minimum:
 *   W = max( minAmountOut, floor(expectedAmountOut * (10000 - WITHDRAW_BUFFER_BPS) / 10000) )
 * Given the caller's guarantee minAmountOut <= expectedAmountOut, this preserves the
 * invariant minAmountOut <= W <= expectedAmountOut (the buffered value is <= expected, and
 * the floor never lifts W above minAmountOut past expected). BigInt throughout.
 * @param {BigInt} expectedAmountOutBigInt - output recomputed at quote reserves
 * @param {BigInt} minAmountOutBigInt - the swap's enforced on-chain minimum for this output
 * @returns {BigInt} the buffered, floored withdraw amount
 */
export function computeWithdrawAmount(expectedAmountOutBigInt, minAmountOutBigInt) {
  const buffered = (expectedAmountOutBigInt * (BPS_DENOMINATOR - WITHDRAW_BUFFER_BPS)) / BPS_DENOMINATOR;
  return buffered > minAmountOutBigInt ? buffered : minAmountOutBigInt;
}

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
  expectedAmountOut,
  swapAForB,
  algodClient,
  indexerClient,
  extraTxns = [],
  inputTokenId = "0", // underlying token ID (0 for VOI, >0 for ASA)
  outputTokenId = "0", // underlying token ID (0 for VOI, >0 for ASA)
  inputTokenType = "native", // "native", "ASA", or "ARC200"
  outputTokenType = "native", // "native", "ASA", or "ARC200"
  inputSymbol = "",
  outputSymbol = "",
  slippage = 0.005,
  degenMode = false,
  skipWithdraw = false,
  skipDeposit = false,
  suggestedParams: suggestedParamsIn = null
}) {
  const poolIdNum = Number(poolId);
  const amountBigInt = BigInt(amountIn);
  const minAmountOutBigInt = BigInt(minAmountOut);
  // The swap credits the user's wrapped balance with the ACTUAL pool output A (>= minAmountOut).
  // The withdraw step converts that wrapped balance back to the underlying token, but
  // withdraw(uint64) REVERTS when the requested amount exceeds the caller's balance (TASK-41
  // confirmed this on-chain: `assert callerBalance >= amount`, no clamp / min / withdraw-all).
  // Reserves can drift between quote-time and submission, so the only guarantee on the credited
  // output is A >= minAmountOut (the swap's own on-chain floor); expectedAmountOut is the output
  // recomputed at quote reserves, and minAmountOut <= expectedAmountOut. Withdrawing exactly
  // expectedAmountOut therefore reverts any swap the pool WOULD fill whose A lands in
  // [minAmountOut, expectedAmountOut). We instead withdraw a value buffered below expected:
  //   W = max( minAmountOut, expectedAmountOut * (10000 - WITHDRAW_BUFFER_BPS) / 10000 )
  // which preserves the invariant minAmountOut <= W <= expectedAmountOut. The buffer lets
  // micro-drift swaps succeed at the withdraw step; the deliberately un-withdrawn remainder is
  // at most ~0.1% of output (expectedAmountOut - W), and any extra left by favorable drift
  // (A > expectedAmountOut) is separate. All stranded wrapped balance is recoverable via
  // /unwrap. The max(...) floor keeps W at or
  // above the swap's enforced minimum: withdrawing below it only adds dust with no reliability
  // gain (the swap already guarantees A >= minAmountOut) and makes the buffer a no-op whenever it
  // would exceed the user's slippage band. expectedAmountOut is required whenever a withdraw may
  // occur; we fail loudly rather than silently falling back to minAmountOut (a money bug).
  if (expectedAmountOut === undefined || expectedAmountOut === null) {
    throw new Error('buildSwapTransactions: expectedAmountOut is required (withdraw must convert the actual swap output, not minAmountOut)');
  }
  const withdrawAmountBigInt = computeWithdrawAmount(BigInt(expectedAmountOut), minAmountOutBigInt);
  const inputTokenIdNum = Number(inputTokenId);
  const outputTokenIdNum = Number(outputTokenId);

  // Determine swap direction. The build path always passes the quoted direction
  // (swapAForB), so only fall back to an on-chain Info() when a caller omits it -
  // the common path skips this redundant pool-info fetch entirely.
  let actualSwapAForB = swapAForB;
  if (actualSwapAForB === undefined) {
    const poolInfo = await getPoolInfo(poolIdNum, algodClient, indexerClient);
    actualSwapAForB = inputWrapped === poolInfo.tokA && outputWrapped === poolInfo.tokB;
  }

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

  // Decimals are used only to format human-readable amounts in transaction notes
  // (cosmetic - they never affect any transaction amount). Read them from the
  // shared decimals cache instead of a per-swap on-chain arc200_decimals() call,
  // and resolve the two independent lookups concurrently. We key by the wrapped
  // token ids so the decimals line up with inputSymbol/outputSymbol (also sourced
  // from the wrapped token's config); wrapped ARC200 tokens mirror their
  // underlying token's decimals, matching what arc200_decimals() would return.
  const [decA, decB] = await Promise.all([
    getTokenDecimals(inputWrapped),
    getTokenDecimals(outputWrapped)
  ]);

  // Check input token balance (to determine if deposit is needed)
  // If skipDeposit is true, we're receiving the token from a previous hop in the same atomic group
  // so we don't need to deposit it - it will be available after the previous transactions execute
  const balAR = await ciTokA.arc200_balanceOf(acc.addr);
  if (!balAR.success) {
    throw new Error("arc200_balanceOf failed for input token");
  }
  const balA = balAR.returnValue;
  const needsDeposit = !skipDeposit && balA < amountBigInt;

  // Check if input token has exchange (redeem capability) - only for ASA tokens
  // ARC200 tokens don't have an exchange, they're already in ARC200 form
  let inputHasExchange = false;
  if (inputTokenType === 'ASA' && needsDeposit) {
    const exchangeA = await ciRedeemA.arc200_exchange();
    inputHasExchange = exchangeA.success;
  }

  // Check if output token has exchange (redeem capability) - determines if we need withdraw
  // Only ASA and native tokens can have exchange, not pure ARC200
  let outputHasExchange = false;
  if ((outputTokenType === 'ASA' || outputTokenType === 'native') && !skipWithdraw) {
    const exchangeB = await ciRedeemB.arc200_exchange();
    outputHasExchange = exchangeB.success;
  }

  // Check allowance (to determine if approval is needed)
  let needsApproval = true;
  let approvalAmount = amountBigInt;
  if (degenMode) {
    const allowanceAR = await ciTokA.arc200_allowance(
      acc.addr,
      algosdk.getApplicationAddress(poolIdNum).toString()
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
    if (inputTokenType === 'ASA') {
      // ASA token that wraps to ARC200
      if (inputHasExchange) {
        // Token has exchange - redeem the underlying ASA into wrapped ARC200 form.
        // Redeem EXACTLY the swap amount (amountBigInt), never the user's entire ASA
        // holding: pulling the whole balance would silently convert funds the user did
        // not ask to swap into wrapped tokens. This mirrors the deposit branch below,
        // which also moves exactly amountBigInt of the underlying.
        const redeemResult = await builder.redeemA.arc200_redeem(amountBigInt);
        if (redeemResult && redeemResult.obj) {
          buildO.push({
            ...redeemResult.obj,
            appIndex: inputWrapped, // Ensure appIndex is set
            from: sender, // Ensure sender is set
            xaid: inputTokenIdNum,
            aamt: amountBigInt,
            note: new TextEncoder().encode(
              `Redeem ${new BigNumber(amountBigInt.toString()).dividedBy(
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
          // In algosdk 3.x, payment fields are under paymentTxn.payment
          const paymentAmount = paymentTxn.payment?.amount ?? paymentTxn.amount;
          const paymentNote = paymentTxn.payment?.note ?? paymentTxn.note;
          buildO.push({
            // Don't include appIndex in the main object - it causes the transaction to be processed as an app call
            // But store it separately so we can verify the payment address
            appIndex: inputWrapped, // Store separately for address verification
            from: sender,
            payment: BigInt(paymentAmount),
            paymentTxn: paymentTxn, // Store the decoded transaction object
            paymentTxnBase64: paymentTxnBase64, // Store the original base64-encoded transaction
            note: paymentNote,
          });
        }

        // Asset transfer goes after payment - don't include appIndex, only xaid and aamt
        buildO.push({
          // Don't include appIndex for asset transfers - it's determined by xaid and aamt
          from: sender,
          xaid: inputTokenIdNum,
          aamt: amountBigInt,
          to: algosdk.getApplicationAddress(inputWrapped).toString(), // Store the app address as 'to' for asset transfer
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
    } else if (inputTokenType === 'native') {
      // VOI (native token)
      // Combined deposit: boxCost (if needed) + deposit amount in single transaction
      const BalanceBoxCost = 28500n;
      const boxCost = balA === 0n ? BalanceBoxCost : 0n;
      const totalPayment = boxCost + amountBigInt;

      if (DEBUG) {
        console.log(`[HumbleSwap Native Deposit] balA=${balA}, boxCost=${boxCost}, amountBigInt=${amountBigInt}, totalPayment=${totalPayment}`);
      }

      const depositResult = await builder.tokA.deposit(amountBigInt);
      if (depositResult && depositResult.obj) {
        buildO.push({
          ...depositResult.obj,
          appIndex: inputWrapped,
          from: sender,
          payment: totalPayment,
          note: new TextEncoder().encode(
            `Deposit ${new BigNumber(amountBigInt.toString()).dividedBy(
              new BigNumber(10).pow(decA)
            ).toFixed(decA)} ${inputSymbol} to application address ${algosdk.getApplicationAddress(
              inputWrapped
            )} from user address ${acc.addr}`
          ),
        });
        if (DEBUG) {
          console.log(`[HumbleSwap Native Deposit] Added deposit txn with payment=${totalPayment}`);
        }
      }
    } else {
      // ARC200 token - no deposit needed, token is already in ARC200 form
      // Just ensure the user has a balance box for this token
      // The balance check was already done above (balA), and if balA < amountBigInt
      // that's fine - the user should already have the ARC200 balance from a previous hop
      // or will receive it from the multi-hop transaction flow
      // Nothing to do here - approval will handle the rest
    }
  }

  // ===========================================
  // APPROVAL
  // ===========================================

  if (needsApproval) {
    // Following ulujs pattern: approval ALWAYS includes a payment (p1 = 28502)
    // This is required for NT200 tokens like wVOI
    const ApprovalPayment = 28502n;

    if (DEBUG) {
      console.log(`[HumbleSwap Approval] needsDeposit=${needsDeposit}, skipDeposit=${skipDeposit}, balA=${balA}, approvalPayment=${ApprovalPayment}`);
    }

    // Always set approval payment like ulujs does
    builder.tokA.setPaymentAmount(ApprovalPayment);

    // Get the approve method from the contract ABI
    const approveMethod = builder.tokA.contractABI.getMethodByName('arc200_approve');

    if (DEBUG) {
      console.log(`[HumbleSwap Approval] Building approval transactions with paymentAmount=${ApprovalPayment}`);
    }
    
    // Get full transaction group from arccjs (including potential payment transaction)
    // We need to temporarily disable objectOnly to get the payment transaction
    const originalObjectOnly = builder.tokA.objectOnly;
    builder.tokA.objectOnly = false;
    let approveTxns;
    try {
      approveTxns = await builder.tokA.createUtxns(approveMethod, [
        algosdk.getApplicationAddress(poolIdNum).toString(),
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

    if (DEBUG) {
      console.log(`[HumbleSwap Approval] arccjs returned ${approveTxns.length} txns, paymentTxnIndex=${paymentTxnIndex}, appCallTxnIndex=${appCallTxnIndex}`);
      if (paymentTxn) {
        const payAmt = paymentTxn.payment?.amount ?? paymentTxn.amount;
        console.log(`[HumbleSwap Approval] Payment txn amount: ${payAmt}`);
      }
      if (appCallTxn) {
        const appArgs = appCallTxn.applicationCall?.appArgs ?? appCallTxn.appArgs ?? [];
        console.log(`[HumbleSwap Approval] App call appArgs count: ${appArgs.length}`);
        // The first arg is the method selector, next should be the spender address, then the amount
        if (appArgs.length >= 1) {
          console.log(`[HumbleSwap Approval] Method selector: 0x${Buffer.from(appArgs[0]).toString('hex')}`);
        }
      }
    }

    const expectedAppAddress = algosdk.getApplicationAddress(inputWrapped).toString();
    
    if (!appCallTxn) {
      throw new Error('Failed to build approval app call transaction');
    }
    
    // Add payment transaction to buildO before the approval app call
    // Following ulujs pattern: approval ALWAYS includes a payment (28502)
    // Payment MUST come first - the contract checks CurrentApplicationAddress == payment.to
    if (paymentTxn) {
      // arccjs provided a payment transaction, use it
      const paymentAmount = paymentTxn.payment?.amount ?? paymentTxn.amount ?? 0n;

      buildO.push({
        appIndex: inputWrapped,
        from: sender,
        payment: BigInt(paymentAmount),
        paymentTxn: paymentTxn,
        paymentTxnBase64: paymentTxnBase64,
        note: paymentTxn.note,
      });
      if (DEBUG) {
        console.log(`[HumbleSwap Approval] Added payment txn from arccjs with amount=${paymentAmount}`);
      }
    } else {
      // arccjs didn't provide a payment transaction, create one manually
      // This ensures approval always has a preceding payment like ulujs
      buildO.push({
        appIndex: inputWrapped,
        from: sender,
        payment: ApprovalPayment,
        paymentTxn: null,
        paymentTxnBase64: null,
        note: new TextEncoder().encode(`Payment for approval`),
      });
      if (DEBUG) {
        console.log(`[HumbleSwap Approval] Added manual payment txn with amount=${ApprovalPayment}`);
      }
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
  // INPUT TOKEN BALANCE ENSUREMENT (for pool)
  // ===========================================
  // The pool needs a balance box on the INPUT wrapped token to receive tokens from user.
  // When the swap executes, it calls arc200_transferFrom(user, pool, amount) on the input token.
  // This requires the pool to have a balance box to receive the tokens.
  // This is separate from the user's balance box (created during deposit).

  const poolAddress = algosdk.getApplicationAddress(poolIdNum).toString();

  const poolInputBalanceR = await ciTokA.arc200_balanceOf(poolAddress);
  const poolHasInputBalance = poolInputBalanceR.success && poolInputBalanceR.returnValue > 0n;

  if (!poolHasInputBalance) {
    // Pool doesn't have a balance box on input token, create it
    // For NT200 tokens (like wVOI), we must use createBalanceBox method
    // arc200_transfer(addr, 0n) does NOT create balance boxes for NT200 tokens
    const poolInputBalanceResult = await builder.tokA.createBalanceBox(poolAddress);
    if (poolInputBalanceResult && poolInputBalanceResult.obj) {
      buildO.push({
        ...poolInputBalanceResult.obj,
        appIndex: inputWrapped, // Input wrapped token contract
        from: sender,
        payment: 28500, // Payment to create balance box (same as user balance box creation)
        note: new TextEncoder().encode(
          `Create balance box for pool ${poolAddress} on ${inputSymbol} contract`
        ),
      });
    }
  }

  // ===========================================
  // OUTPUT TOKEN BALANCE ENSUREMENT
  // ===========================================

  // For pure ARC200 tokens, we need to ensure both pool and user balance boxes exist
  // The pool needs its balance box to hold tokens, and the user needs their balance box
  // to receive tokens when the pool transfers to them
  
  // Check if output is pure ARC200 (use explicit type check instead of heuristics)
  const isOutputPureARC200 = outputTokenType === 'ARC200';
  
  // Check pool's balance - if it has a balance, the box exists
  const poolBalanceR = await ciTokB.arc200_balanceOf(poolAddress);
  const poolHasBalance = poolBalanceR.success && poolBalanceR.returnValue > 0n;

  // Determine if output token is NT200 (wrapped native or ASA) vs pure ARC200
  // NT200 tokens require createBalanceBox, pure ARC200 can use arc200_transfer
  const isOutputNT200 = outputTokenType === 'native' || outputTokenType === 'ASA';

  if (!poolHasBalance) {
    // Pool doesn't have a balance, so we need to create the balance box
    if (isOutputNT200) {
      // NT200 tokens (like wVOI) require createBalanceBox method
      const poolOutputBalanceResult = await builder.tokB.createBalanceBox(poolAddress);
      if (poolOutputBalanceResult && poolOutputBalanceResult.obj) {
        buildO.push({
          ...poolOutputBalanceResult.obj,
          appIndex: outputWrapped,
          from: sender,
          payment: 28500, // Payment to create balance box
          note: new TextEncoder().encode(
            `Create balance box for pool ${poolAddress} on ${outputSymbol} contract`
          ),
        });
      }
    } else {
      // Pure ARC200 - use arc200_transfer
      const transferResult = await builder.tokB.arc200_transfer(
        poolAddress,
        0n
      );
      if (transferResult && transferResult.obj) {
        buildO.push({
          ...transferResult.obj,
          appIndex: outputWrapped,
          from: sender,
          payment: 28501, // Standard payment for balance ensurement
          note: new TextEncoder().encode(
            `Transfer 0 ${outputSymbol} to application address ${poolAddress} from user address ${acc.addr}`
          ),
        });
      }
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
    // In algosdk 3.x, foreignApps is under applicationCall
    const decodedSwapTxns = swapTxns.map(txn => algosdk.decodeUnsignedTransaction(Buffer.from(txn, 'base64')));
    const swapTxn = decodedSwapTxns.find(txn => txn.type === algosdk.TransactionType.appl);
    if (swapTxn) {
      // algosdk 3.x: foreignApps is under applicationCall
      const rawForeignApps = swapTxn.applicationCall?.foreignApps ?? swapTxn.foreignApps ?? [];
      swapForeignApps = [...rawForeignApps];
      if (DEBUG) console.log(`[HumbleSwap] Decoded swap txn foreignApps from arccjs:`, swapForeignApps.map(a => Number(a)));
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
  
  // Determine if we need to withdraw the output token
  // - For ASA: withdraw converts wrapped ARC200 to underlying ASA
  // - For native (VOI): withdraw converts wVOI to native VOI
  // - For ARC200: no withdraw needed, token is already in ARC200 form
  // Use explicit outputTokenType instead of heuristics
  const needsWithdraw = (outputTokenType === 'ASA' || outputTokenType === 'native') && !outputHasExchange;

  if (!skipWithdraw && needsWithdraw) {
    // Withdraw output token (unless it has exchange, which means it auto-converts)
    // This is for NT200 tokens (like wVOI) and ASAs, not pure ARC200 tokens
    // Use createUtxns to get the full transaction group (similar to deposit)
    // This ensures we get any payment transactions that the contract expects
    const withdrawMethod = builder.tokB.contractABI.getMethodByName('withdraw');

    // Withdraw the buffered amount W (see computeWithdrawAmount): expectedAmountOut shaved
    // by WITHDRAW_BUFFER_BPS and floored at minAmountOut. Withdrawing exactly expectedAmountOut
    // reverts on adverse micro-drift (withdraw() reverts on amount > balance); withdrawing only
    // minAmountOut would strand (actual - min) as an invisible wrapped balance.
    const originalObjectOnly = builder.tokB.objectOnly;
    builder.tokB.objectOnly = false;
    let withdrawTxns;
    try {
      withdrawTxns = await builder.tokB.createUtxns(withdrawMethod, [withdrawAmountBigInt]);
    } finally {
      builder.tokB.objectOnly = originalObjectOnly;
    }

    // Decode transactions to find payment and app call
    const decodedWithdrawTxns = withdrawTxns.map(txn => {
      const decoded = algosdk.decodeUnsignedTransaction(Buffer.from(txn, 'base64'));
      decoded.group = undefined;
      return decoded;
    });

    const withdrawPaymentTxnIndex = decodedWithdrawTxns.findIndex(txn => txn.type === algosdk.TransactionType.pay);
    const withdrawAppCallTxnIndex = decodedWithdrawTxns.findIndex(txn => txn.type === algosdk.TransactionType.appl);
    const withdrawPaymentTxn = withdrawPaymentTxnIndex >= 0 ? decodedWithdrawTxns[withdrawPaymentTxnIndex] : null;
    const withdrawAppCallTxn = withdrawAppCallTxnIndex >= 0 ? decodedWithdrawTxns[withdrawAppCallTxnIndex] : null;
    const withdrawPaymentTxnBase64 = withdrawPaymentTxnIndex >= 0 ? withdrawTxns[withdrawPaymentTxnIndex] : null;

    // Add payment transaction if it exists (some withdraw operations may require preceding payment)
    if (withdrawPaymentTxn) {
      const paymentAmount = withdrawPaymentTxn.payment?.amount ?? withdrawPaymentTxn.amount;
      const paymentNote = withdrawPaymentTxn.payment?.note ?? withdrawPaymentTxn.note;
      buildO.push({
        appIndex: outputWrapped,
        from: sender,
        payment: BigInt(paymentAmount),
        paymentTxn: withdrawPaymentTxn,
        paymentTxnBase64: withdrawPaymentTxnBase64,
        note: paymentNote,
      });
    }

    // Add the withdraw app call transaction
    if (withdrawAppCallTxn) {
      const withdrawTxnObj = {
        appIndex: outputWrapped,
        from: sender,
        appCallTxn: withdrawAppCallTxn,
        note: new TextEncoder().encode(
          `Withdraw ${new BigNumber(withdrawAmountBigInt.toString()).dividedBy(
            new BigNumber(10).pow(decB)
          ).toFixed(decB)} ${outputSymbol} from application address ${algosdk.getApplicationAddress(
            outputWrapped
          )} to user address ${acc.addr}`
        ),
      };

      // If output is ASA, we need opt-in, so add asset transfer fields
      if (outputTokenType === 'ASA') {
        withdrawTxnObj.xaid = outputTokenIdNum;
        withdrawTxnObj.snd = acc.addr;
        withdrawTxnObj.arcv = acc.addr;
        withdrawTxnObj.foreignAssets = [outputTokenIdNum];
      }

      buildO.push(withdrawTxnObj);
    }
  }

  // ===========================================
  // BUILD TRANSACTION GROUP MANUALLY (NO SIMULATION!)
  // ===========================================
  
  // Get suggested params. Reuse caller-supplied request-scoped params when
  // provided (params are stable within a request); only fetch standalone.
  const suggestedParams = suggestedParamsIn || await algodClient.getTransactionParams().do();
  
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
        assetTransferTo = algosdk.getApplicationAddress(txnAppIndex).toString();
      } else {
        continue;
      }
      const assetTransferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        suggestedParams: {
          ...suggestedParams,
          flatFee: true,
          fee: 1000n,
        },
        sender: txnSender,
        receiver: assetTransferTo,
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

        // Convert addresses to strings (algosdk 3.x decoded transactions have Address instances)
        let paymentFrom;
        if (typeof originalPaymentTxn.sender === 'string') {
          paymentFrom = originalPaymentTxn.sender;
        } else if (originalPaymentTxn.sender instanceof algosdk.Address) {
          paymentFrom = originalPaymentTxn.sender.toString();
        } else if (originalPaymentTxn.sender && originalPaymentTxn.sender.publicKey) {
          paymentFrom = new algosdk.Address(originalPaymentTxn.sender.publicKey).toString();
        } else if (Buffer.isBuffer(originalPaymentTxn.sender)) {
          paymentFrom = new algosdk.Address(new Uint8Array(originalPaymentTxn.sender)).toString();
        } else if (originalPaymentTxn.sender instanceof Uint8Array) {
          paymentFrom = new algosdk.Address(originalPaymentTxn.sender).toString();
        } else if (Array.isArray(originalPaymentTxn.sender)) {
          paymentFrom = new algosdk.Address(new Uint8Array(originalPaymentTxn.sender)).toString();
        } else {
          throw new Error(`Invalid paymentFrom address: ${originalPaymentTxn.sender}`);
        }

        let paymentTo;
        if (typeof originalPaymentTxn.payment?.receiver === 'string') {
          paymentTo = originalPaymentTxn.payment.receiver;
        } else if (originalPaymentTxn.payment?.receiver instanceof algosdk.Address) {
          paymentTo = originalPaymentTxn.payment.receiver.toString();
        } else if (originalPaymentTxn.payment?.receiver && originalPaymentTxn.payment.receiver.publicKey) {
          paymentTo = new algosdk.Address(originalPaymentTxn.payment.receiver.publicKey).toString();
        } else if (Buffer.isBuffer(originalPaymentTxn.payment?.receiver)) {
          paymentTo = new algosdk.Address(new Uint8Array(originalPaymentTxn.payment.receiver)).toString();
        } else if (originalPaymentTxn.payment?.receiver instanceof Uint8Array) {
          paymentTo = new algosdk.Address(originalPaymentTxn.payment.receiver).toString();
        } else if (Array.isArray(originalPaymentTxn.payment?.receiver)) {
          paymentTo = new algosdk.Address(new Uint8Array(originalPaymentTxn.payment.receiver)).toString();
        } else {
          throw new Error(`Invalid paymentTo address: ${originalPaymentTxn.payment?.receiver}`);
        }

        // Recreate the transaction with ALL fields preserved exactly
        // Don't modify the decoded transaction directly as it may corrupt internal state
        const recreatedPaymentTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          suggestedParams: {
            ...suggestedParams,
            flatFee: true,
            fee: originalPaymentTxn.fee || 1000n,
          },
          sender: paymentFrom,
          receiver: paymentTo,
          amount: originalPaymentTxn.payment?.amount || originalPaymentTxn.amount,
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
      // Convert addresses to strings (algosdk 3.x decoded transactions have Address instances)
      let paymentFrom;
      if (typeof txn.paymentTxn.sender === 'string') {
        paymentFrom = txn.paymentTxn.sender;
      } else if (txn.paymentTxn.sender instanceof algosdk.Address) {
        paymentFrom = txn.paymentTxn.sender.toString();
      } else if (txn.paymentTxn.sender && txn.paymentTxn.sender.publicKey) {
        paymentFrom = new algosdk.Address(txn.paymentTxn.sender.publicKey).toString();
      } else if (txn.paymentTxn.sender instanceof Uint8Array) {
        paymentFrom = new algosdk.Address(txn.paymentTxn.sender).toString();
      } else {
        throw new Error(`Invalid paymentFrom address: ${JSON.stringify(txn.paymentTxn.sender)}`);
      }

      let paymentTo;
      if (typeof txn.paymentTxn.payment?.receiver === 'string') {
        paymentTo = txn.paymentTxn.payment.receiver;
      } else if (txn.paymentTxn.payment?.receiver instanceof algosdk.Address) {
        paymentTo = txn.paymentTxn.payment.receiver.toString();
      } else if (txn.paymentTxn.payment?.receiver && txn.paymentTxn.payment.receiver.publicKey) {
        paymentTo = new algosdk.Address(txn.paymentTxn.payment.receiver.publicKey).toString();
      } else if (txn.paymentTxn.payment?.receiver instanceof Uint8Array) {
        paymentTo = new algosdk.Address(txn.paymentTxn.payment.receiver).toString();
      } else {
        throw new Error(`Invalid paymentTo address: ${JSON.stringify(txn.paymentTxn.payment?.receiver)}`);
      }

      const paymentTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        suggestedParams: {
          ...suggestedParams,
          flatFee: true,
          fee: 1000n,
        },
        sender: paymentFrom,
        receiver: paymentTo, // Use arccjs's original address - don't override
        amount: txn.paymentTxn.payment?.amount || txn.paymentTxn.amount,
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
      const paymentToAddress = algosdk.getApplicationAddress(txnAppIndex).toString();
      const paymentTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        suggestedParams: {
          ...suggestedParams,
          flatFee: true,
          fee: 1000n,
        },
        sender: txnSender,
        receiver: paymentToAddress,
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
          fee: 1000n,
        },
        sender: txn.snd,
        receiver: txn.arcv,
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
      // In algosdk 3.x, these are at applicationCall.foreignAssets
      const finalForeignAssets = txn.foreignAssets || txn.appCallTxn.applicationCall?.foreignAssets || txn.appCallTxn.foreignAssets || [];

      // Get foreignApps from buildO if provided (e.g., for swap transaction), otherwise use from decoded txn
      // This is important because we explicitly set foreignApps for swap transactions
      // In algosdk 3.x, these are at applicationCall.foreignApps
      const finalForeignApps = txn.foreignApps || txn.appCallTxn.applicationCall?.foreignApps || txn.appCallTxn.foreignApps || [];

      
      // Recreate the app call transaction with updated params and foreignAssets
      // Convert address to string (algosdk 3.x decoded transactions have Address instances)
      let appCallFrom;
      if (typeof txn.appCallTxn.sender === 'string') {
        appCallFrom = txn.appCallTxn.sender;
      } else if (txn.appCallTxn.sender instanceof algosdk.Address) {
        appCallFrom = txn.appCallTxn.sender.toString();
      } else if (txn.appCallTxn.sender && txn.appCallTxn.sender.publicKey) {
        appCallFrom = new algosdk.Address(txn.appCallTxn.sender.publicKey).toString();
      } else if (txn.appCallTxn.sender instanceof Uint8Array) {
        appCallFrom = new algosdk.Address(txn.appCallTxn.sender).toString();
      } else {
        throw new Error(`Invalid appCallFrom address: ${txn.appCallTxn.sender}`);
      }
      
      // Normalize boxes - ensure appIndex is a number and name is Uint8Array
      // In algosdk 3.x, boxes are at applicationCall.boxes
      const normalizedBoxes = [];
      const rawBoxes = txn.appCallTxn.applicationCall?.boxes ?? txn.appCallTxn.boxes ?? [];
      if (Array.isArray(rawBoxes)) {
        for (const box of rawBoxes) {
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
      // In algosdk 3.x, appArgs are at applicationCall.appArgs
      const rawAppArgs = txn.appCallTxn.applicationCall?.appArgs ?? txn.appCallTxn.appArgs ?? [];
      const appArgs = rawAppArgs.map(arg => {
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
      
      // In algosdk 3.x, app-specific fields are nested under applicationCall
      const appIdx = txn.appCallTxn.applicationCall?.appIndex ?? txn.appCallTxn.appIndex;
      const onComplete = txn.appCallTxn.applicationCall?.onComplete ?? txn.appCallTxn.onComplete ?? 0;
      const accounts = txn.appCallTxn.applicationCall?.accounts ?? txn.appCallTxn.accounts ?? [];

      const appCallTxn = algosdk.makeApplicationCallTxnFromObject({
        suggestedParams: {
          ...suggestedParams,
          flatFee: true,
          fee: txn.fee || 4000n,
        },
        sender: appCallFrom,
        appIndex: Number(appIdx),
        appArgs: appArgs, // Use normalized appArgs
        onComplete: onComplete,
        foreignApps: finalForeignApps,
        foreignAssets: finalForeignAssets,
        accounts: accounts,
        boxes: normalizedBoxes,
        note: txn.appCallTxn.note,
      });
      appCallTxn.group = undefined; // Clear group ID - will be assigned later

      // In algosdk 3.x, ALL app call resources are under applicationCall, not at top level
      // makeApplicationCallTxnFromObject may not set them correctly, so set explicitly
      const appCall = appCallTxn.applicationCall || appCallTxn;

      // Set foreignApps with BigInt
      if (finalForeignApps && finalForeignApps.length > 0) {
        appCall.foreignApps = finalForeignApps.map(a => BigInt(a));
      }

      // Set foreignAssets with BigInt
      if (finalForeignAssets && finalForeignAssets.length > 0) {
        appCall.foreignAssets = finalForeignAssets.map(a => BigInt(a));
      }

      // Set accounts (convert to Address objects if needed)
      if (accounts && accounts.length > 0) {
        appCall.accounts = accounts.map(a => {
          if (typeof a === 'string') return algosdk.Address.fromString(a);
          if (a instanceof algosdk.Address) return a;
          if (a && a.publicKey) return new algosdk.Address(a.publicKey);
          return a;
        });
      }

      // Set boxes with BigInt appIndex
      if (normalizedBoxes.length > 0) {
        appCall.boxes = normalizedBoxes.map(b => ({
          appIndex: BigInt(b.appIndex),
          name: b.name
        }));
      }

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
      
      // Normalize boxes from txn.boxes if provided
      const txnBoxes = txn.boxes || [];
      const normalizedTxnBoxes = txnBoxes.map(b => ({
        appIndex: BigInt(typeof b.appIndex === 'number' ? b.appIndex : Number(b.appIndex)),
        name: b.name instanceof Uint8Array ? b.name : new Uint8Array(b.name)
      }));

      const txnForeignAssets = txn.foreignAssets || [];
      const txnAccounts = txn.accounts || [];

      const appCallTxn = algosdk.makeApplicationCallTxnFromObject({
        suggestedParams: {
          ...suggestedParams,
          flatFee: true,
          fee: txn.fee || 4000n,
        },
        sender: txnSender,
        appIndex: txnAppIndex,
        appArgs: appArgs,
        onComplete: txn.onComplete || 0,
        foreignApps: foreignApps,
        foreignAssets: txnForeignAssets,
        accounts: txnAccounts,
        boxes: normalizedTxnBoxes,
        note: txn.note,
      });
      appCallTxn.group = undefined; // Clear group ID - will be assigned later

      // In algosdk 3.x, ALL app call resources are under applicationCall, not at top level
      const appCall = appCallTxn.applicationCall || appCallTxn;

      // Set foreignApps with BigInt
      if (foreignApps && foreignApps.length > 0) {
        appCall.foreignApps = foreignApps.map(a => BigInt(a));
      }

      // Set foreignAssets with BigInt
      if (txnForeignAssets && txnForeignAssets.length > 0) {
        appCall.foreignAssets = txnForeignAssets.map(a => BigInt(a));
      }

      // Set accounts (convert to Address objects if needed)
      if (txnAccounts && txnAccounts.length > 0) {
        appCall.accounts = txnAccounts.map(a => {
          if (typeof a === 'string') return algosdk.Address.fromString(a);
          if (a instanceof algosdk.Address) return a;
          if (a && a.publicKey) return new algosdk.Address(a.publicKey);
          return a;
        });
      }

      // Set boxes with BigInt appIndex
      if (normalizedTxnBoxes.length > 0) {
        appCall.boxes = normalizedTxnBoxes;
      }

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
    const from = txn.sender.toString();
    const to = txn.payment?.receiver?.toString() || 'unknown';
    return `Payment: ${from} -> ${to}, Amount: ${txn.payment?.amount || txn.amount} microAlgos`;
  } else if (txn.type === 'axfer') {
    const from = txn.sender.toString();
    const to = txn.assetTransfer?.receiver?.toString() || 'unknown';
    return `Asset Transfer: ${from} -> ${to}, Asset: ${txn.assetTransfer?.assetIndex || txn.assetIndex}, Amount: ${txn.assetTransfer?.amount || txn.amount}`;
  } else if (txn.type === 'appl') {
    const from = txn.sender.toString();
    const noteText = txn.note ? new TextDecoder().decode(txn.note).substring(0, 40) : 'No note';
    let summary = `App Call: ${from} -> App ${txn.applicationCall?.appIndex || txn.appIndex}`;
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
