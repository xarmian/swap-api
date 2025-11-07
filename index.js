import express from 'express';
import cors from 'cors';
import { swap200, CONTRACT, swap } from 'ulujs';
import algosdk from 'algosdk';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getPoolInfo as getNomadexPoolInfo,
  calculateOutputAmount as calculateNomadexOutput,
  buildSwapTransactions as buildNomadexSwapTransactions,
  getTokenTypeFromConfig
} from './lib/nomadex.js';

dotenv.config();

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Algorand clients (using Voi mainnet)
const algodClient = new algosdk.Algodv2(
  '',
  process.env.ALGOD_URL || 'https://mainnet-api.voi.nodely.dev',
  ''
);
const indexerClient = new algosdk.Indexer(
  '',
  process.env.INDEXER_URL || 'https://mainnet-idx.voi.nodely.dev',
  ''
);

// --- Config loading (local pools/tokens) ---

let poolsConfig = null;
let tokensConfig = null;
const decimalsCache = new Map();

function loadJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function loadConfigsOnce() {
  if (poolsConfig && tokensConfig) return;
  const poolsPath = path.join(__dirname, 'config', 'pools.json');
  const tokensPath = path.join(__dirname, 'config', 'tokens.json');
  poolsConfig = loadJSON(poolsPath);
  tokensConfig = loadJSON(tokensPath) || { tokens: {} };
  if (!poolsConfig || !Array.isArray(poolsConfig.pools)) {
    throw new Error('Invalid or missing config/pools.json');
  }
}

function getPoolConfigById(poolId) {
  loadConfigsOnce();
  const pid = Number(poolId);
  const found = poolsConfig.pools.find(p => Number(p.poolId) === pid);
  return found || null;
}

function getTokenMetaFromConfig(tokenId) {
  loadConfigsOnce();
  const t = tokensConfig.tokens[String(tokenId)];
  return t || null;
}

async function getTokenDecimals(tokenId) {
  const key = String(tokenId);
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  const cfg = getTokenMetaFromConfig(key);
  if (cfg && typeof cfg.decimals === 'number') {
    decimalsCache.set(key, cfg.decimals);
    return cfg.decimals;
  }
  if (Number(key) === 0) {
    decimalsCache.set(key, 6);
    return 6;
  }
  try {
    const resp = await indexerClient.lookupAssetByID(Number(key)).do();
    const dec = resp && resp.asset && typeof resp.asset.params.decimals === 'number'
      ? resp.asset.params.decimals
      : 6;
    decimalsCache.set(key, dec);
    return dec;
  } catch (e) {
    // Fallback to 6
    decimalsCache.set(key, 6);
    return 6;
  }
}

// AMM constant product formula helpers
function calculateOutputAmount(inputAmount, inputReserve, outputReserve, fee) {
  // fee is in basis points (e.g., 30 for 0.3%)
  const amountInWithFee = BigInt(inputAmount) * BigInt(10000 - fee);
  const numerator = amountInWithFee * BigInt(outputReserve);
  const denominator = BigInt(inputReserve) * BigInt(10000) + amountInWithFee;
  return numerator / denominator;
}

/**
 * Calculates price impact for an AMM swap using the standard formula.
 * 
 * Price impact measures how much the pool's spot price changes due to a trade.
 * This uses the standard AMM approach: comparing spot prices before and after the trade.
 * 
 * Formula:
 * - Spot price before: outputReserve / inputReserve
 * - Spot price after: (outputReserve - outputAmount) / (inputReserve + inputAmount)
 * - Price impact: |(priceAfter - priceBefore) / priceBefore|
 * 
 * This is more accurate than comparing effective price vs spot price, as it directly
 * measures the change in the pool's price state.
 * 
 * @param {BigInt|string|number} inputAmount - Amount of input token being swapped
 * @param {BigInt|string|number} inputReserve - Current reserve of input token in pool
 * @param {BigInt|string|number} outputAmount - Amount of output token received (after fees)
 * @param {BigInt|string|number} outputReserve - Current reserve of output token in pool
 * @returns {number} Price impact as a decimal (e.g., 0.01 = 1% impact)
 */
function calculatePriceImpact(inputAmount, inputReserve, outputAmount, outputReserve) {
  // Convert BigInt values to Numbers for calculation
  const inputAmountNum = Number(inputAmount);
  const inputReserveNum = Number(inputReserve);
  const outputAmountNum = Number(outputAmount);
  const outputReserveNum = Number(outputReserve);

  // Validate inputs to prevent division by zero and invalid calculations
  if (inputReserveNum <= 0 || inputAmountNum <= 0 || outputAmountNum <= 0 || outputReserveNum <= 0) {
    return 0; // Return 0 impact for invalid inputs
  }

  // Calculate spot price before trade: outputReserve / inputReserve
  const spotPriceBefore = outputReserveNum / inputReserveNum;

  // Calculate spot price after trade: (outputReserve - outputAmount) / (inputReserve + inputAmount)
  // This represents the new pool price after the trade executes
  const newOutputReserve = outputReserveNum - outputAmountNum;
  const newInputReserve = inputReserveNum + inputAmountNum;

  // Validate post-trade reserves
  if (newOutputReserve <= 0 || newInputReserve <= 0) {
    return 0; // Return 0 impact if reserves would be invalid
  }

  const spotPriceAfter = newOutputReserve / newInputReserve;

  // Price impact = |(priceAfter - priceBefore) / priceBefore|
  // This measures the percentage change in the pool's spot price due to the trade
  const priceImpact = Math.abs((spotPriceAfter - spotPriceBefore) / spotPriceBefore);

  return priceImpact;
}

// No external token lookup; use local config

/**
 * Handle Nomadex quote request
 */
async function handleNomadexQuote(req, res, params) {
  try {
    const { address, inputToken, outputToken, amount, slippage, poolContractId, poolCfg } = params;

    // Validate tokens match pool configuration
    const tokA = poolCfg.tokens?.tokA;
    const tokB = poolCfg.tokens?.tokB;
    
    if (!tokA || !tokB) {
      return res.status(400).json({ error: 'Invalid pool configuration: missing token information' });
    }

    const inputTokenNum = Number(inputToken);
    const outputTokenNum = Number(outputToken);
    const tokANum = Number(tokA.id);
    const tokBNum = Number(tokB.id);

    // Validate input/output tokens match pool
    const validPair =
      (inputTokenNum === tokANum && outputTokenNum === tokBNum) ||
      (inputTokenNum === tokBNum && outputTokenNum === tokANum);

    if (!validPair) {
      return res.status(400).json({
        error: `Token pair (${inputToken}, ${outputToken}) does not match pool tokens (${tokANum}, ${tokBNum})`
      });
    }

    // Get token types from config
    const inputTokenType = getTokenTypeFromConfig(poolCfg, inputTokenNum);
    const outputTokenType = getTokenTypeFromConfig(poolCfg, outputTokenNum);

    if (!inputTokenType || !outputTokenType) {
      return res.status(400).json({ error: 'Could not determine token types from pool configuration' });
    }

    // Get pool info
    const poolInfo = await getNomadexPoolInfo(poolContractId, algodClient, indexerClient, poolCfg);

    // Note: tokA can be 0 (native token), so we check for null/undefined explicitly
    if (poolInfo.tokA === null || poolInfo.tokA === undefined || poolInfo.tokB === null || poolInfo.tokB === undefined) {
      return res.status(500).json({ error: 'Failed to determine pool token IDs' });
    }

    // Determine swap direction (alpha to beta = tokA to tokB)
    const isDirectionAlphaToBeta = inputTokenNum === poolInfo.tokA && outputTokenNum === poolInfo.tokB;
    const inputReserve = isDirectionAlphaToBeta ? poolInfo.reserveA : poolInfo.reserveB;
    const outputReserve = isDirectionAlphaToBeta ? poolInfo.reserveB : poolInfo.reserveA;

    // Calculate quote
    const amountBigInt = BigInt(amount);
    const outputAmount = calculateNomadexOutput(amountBigInt, inputReserve, outputReserve, poolInfo.fee);
    const minimumOutputAmount = (outputAmount * BigInt(Math.floor((1 - slippage) * 10000))) / BigInt(10000);
    const priceImpact = calculatePriceImpact(amountBigInt, inputReserve, outputAmount, outputReserve);
    const rate = Number(outputAmount) / Number(amountBigInt);

    // Build swap transactions
    let unsignedTransactions = [];
    try {
      unsignedTransactions = await buildNomadexSwapTransactions({
        sender: address,
        poolId: poolContractId,
        inputToken: inputTokenNum,
        outputToken: outputTokenNum,
        amountIn: amountBigInt.toString(),
        minAmountOut: minimumOutputAmount.toString(),
        isDirectionAlphaToBeta,
        inputTokenType,
        outputTokenType,
        algodClient
      });
    } catch (txnError) {
      console.error('Error building Nomadex transactions:', txnError);
      return res.status(200).json({
        quote: {
          inputAmount: amountBigInt.toString(),
          outputAmount: outputAmount.toString(),
          minimumOutputAmount: minimumOutputAmount.toString(),
          rate: rate,
          priceImpact: priceImpact
        },
        unsignedTransactions: [],
        poolId: poolContractId.toString(),
        error: 'Failed to generate swap transactions: ' + txnError.message
      });
    }

    res.json({
      quote: {
        inputAmount: amountBigInt.toString(),
        outputAmount: outputAmount.toString(),
        minimumOutputAmount: minimumOutputAmount.toString(),
        rate: rate,
        priceImpact: priceImpact
      },
      unsignedTransactions: unsignedTransactions,
      poolId: poolContractId.toString()
    });

  } catch (error) {
    console.error('Error generating Nomadex quote:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}

// POST /quote endpoint
app.post('/quote', async (req, res) => {
  try {
    const {
      address,
      inputToken,
      outputToken,
      amount,
      slippageTolerance,
      poolId
    } = req.body;

    // Validate request
    if (!address || inputToken === undefined || outputToken === undefined || !amount || !poolId) {
      return res.status(400).json({
        error: 'Missing required fields: address, inputToken, outputToken, amount, poolId'
      });
    }

    // Default slippage tolerance to 1% if not provided
    const slippage = slippageTolerance || 0.01;

    const poolContractId = poolId;

    // Load pool config
    const poolCfg = getPoolConfigById(poolContractId);
    if (!poolCfg) {
      return res.status(400).json({ error: `Pool ${poolContractId} not found in config` });
    }

    const inputTokenStr = String(inputToken);
    const outputTokenStr = String(outputToken);
    const dex = poolCfg.dex || 'humbleswap'; // Default to humbleswap for backward compatibility

    // Route to appropriate DEX handler
    if (dex === 'nomadex') {
      // Handle Nomadex pool
      return await handleNomadexQuote(req, res, {
        address,
        inputToken: inputTokenStr,
        outputToken: outputTokenStr,
        amount,
        slippage,
        poolContractId,
        poolCfg
      });
    } else {
      // Handle HumbleSwap pool (existing logic)
      const u2w = poolCfg.tokens && poolCfg.tokens.underlyingToWrapped ? poolCfg.tokens.underlyingToWrapped : {};
      const inputWrapped = u2w[inputTokenStr];
      const outputWrapped = u2w[outputTokenStr];
      if (inputWrapped === undefined) {
        return res.status(400).json({ error: `No wrapped mapping for input token ${inputTokenStr} in pool ${poolContractId}` });
      }
      if (outputWrapped === undefined) {
        return res.status(400).json({ error: `No wrapped mapping for output token ${outputTokenStr} in pool ${poolContractId}` });
      }

      // Validate wrapped pair matches pool
      const pair = poolCfg.tokens.wrappedPair || {};
      const wrappedPairOk =
        (Number(pair.tokA) === Number(inputWrapped) && Number(pair.tokB) === Number(outputWrapped)) ||
        (Number(pair.tokA) === Number(outputWrapped) && Number(pair.tokB) === Number(inputWrapped));
      if (!wrappedPairOk) {
        return res.status(400).json({ error: 'Resolved wrapped tokens do not match pool configured pair' });
      }
    }

    // Create swap instance using ulujs swap class
    const swapInstance = new swap(Number(poolContractId), algodClient, indexerClient, {
      acc: { addr: address, sk: new Uint8Array(0) },
      simulate: true,
      formatBytes: true,
      waitForConfirmation: false
    });

    // Build token objects for swap using local config and decimals cache
    const inputDecimals = await getTokenDecimals(inputTokenStr);
    const outputDecimals = await getTokenDecimals(outputTokenStr);
    const amountInDecimal = Number(amount) / (10 ** inputDecimals);

    // tokenA is the input wrapped contract with underlying tokenId included
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

    // Get pool info for quote calculation
    const infoResult = await swapInstance.Info();
    if (!infoResult.success) {
      return res.status(500).json({
        error: 'Failed to fetch pool information',
        details: infoResult.error
      });
    }

    const poolInfo = infoResult.returnValue;
    const { poolBals, protoInfo } = poolInfo;

    // Determine swap direction
    const swapAForB = tokenA.contractId === poolInfo.tokA && tokenB.contractId === poolInfo.tokB;
    const inputReserve = swapAForB ? poolBals.A : poolBals.B;
    const outputReserve = swapAForB ? poolBals.B : poolBals.A;

    // Calculate quote
    const totalFee = protoInfo.totFee;
    const outputAmount = calculateOutputAmount(amount, inputReserve, outputReserve, totalFee);
    const minimumOutputAmount = (outputAmount * BigInt(Math.floor((1 - slippage) * 10000))) / BigInt(10000);
    const priceImpact = calculatePriceImpact(amount, inputReserve, outputAmount, outputReserve);
    const rate = Number(outputAmount) / Number(amount);

    // Generate swap transactions (wrap → swap → unwrap as needed)
    const swapResult = await swapInstance.swap(
      address,
      Number(poolContractId),
      tokenA,
      tokenB,
      [], // extraTxns
      {
        debug: false,
        slippage: slippage,
        degenMode: false,
        skipWithdraw: false
      }
    );

    if (!swapResult || !swapResult.success) {
      return res.status(200).json({
        quote: {
          inputAmount: amount.toString(),
          outputAmount: outputAmount.toString(),
          minimumOutputAmount: minimumOutputAmount.toString(),
          rate: rate,
          priceImpact: priceImpact
        },
        unsignedTransactions: [],
        poolId: poolContractId.toString(),
        error: 'Failed to generate swap transactions' + (swapResult?.error ? `: ${JSON.stringify(swapResult.error)}` : '')
      });
    }

    res.json({
      quote: {
        inputAmount: amount.toString(),
        outputAmount: outputAmount.toString(),
        minimumOutputAmount: minimumOutputAmount.toString(),
        rate: rate,
        priceImpact: priceImpact
      },
      unsignedTransactions: swapResult.txns,
      poolId: poolContractId.toString()
    });

  } catch (error) {
    console.error('Error generating quote:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /pool/:poolId - Get pool information
app.get('/pool/:poolId', async (req, res) => {
  try {
    const { poolId } = req.params;

    if (!poolId) {
      return res.status(400).json({ error: 'Pool ID is required' });
    }

    // Get pool config to determine DEX type
    const poolCfg = getPoolConfigById(poolId);
    const dex = poolCfg?.dex || 'humbleswap';

    if (dex === 'nomadex') {
      // Handle Nomadex pool
      try {
        const poolInfo = await getNomadexPoolInfo(Number(poolId), algodClient, indexerClient, poolCfg);
        
        res.json({
          poolId: poolId,
          dex: 'nomadex',
          tokA: poolInfo.tokA,
          tokB: poolInfo.tokB,
          reserves: {
            A: poolInfo.reserveA,
            B: poolInfo.reserveB
          },
          fees: {
            totFee: poolInfo.fee
          }
        });
      } catch (error) {
        console.error('Error fetching Nomadex pool info:', error);
        return res.status(500).json({
          error: 'Failed to fetch pool information',
          details: error.message
        });
      }
    } else {
      // Handle HumbleSwap pool (existing logic)
      const swapContract = new swap200(Number(poolId), algodClient, indexerClient);
      const infoResult = await swapContract.Info();

      if (!infoResult.success) {
        return res.status(500).json({
          error: 'Failed to fetch pool information',
          details: infoResult.error
        });
      }

      const poolInfo = infoResult.returnValue;

      res.json({
        poolId: poolId,
        dex: 'humbleswap',
        tokA: poolInfo.tokA,
        tokB: poolInfo.tokB,
        reserves: {
          A: poolInfo.poolBals.A,
          B: poolInfo.poolBals.B
        },
        fees: {
          protoFee: poolInfo.protoInfo.protoFee,
          lpFee: poolInfo.protoInfo.lpFee,
          totFee: poolInfo.protoInfo.totFee
        },
        liquidity: {
          lpHeld: poolInfo.lptBals.lpHeld,
          lpMinted: poolInfo.lptBals.lpMinted
        },
        locked: poolInfo.protoInfo.locked
      });
    }

  } catch (error) {
    console.error('Error fetching pool info:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Optional: GET /config/pools - return configured pools for discovery
app.get('/config/pools', (req, res) => {
  try {
    loadConfigsOnce();
    res.json(poolsConfig);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load pools config', message: e.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start server only when running directly (local development)
// When imported as a module (Vercel), export the app instead
// In ESM, check if we're not in a serverless environment
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Swap API server running on port ${PORT}`);
    console.log(`Algod: ${process.env.ALGOD_URL || 'https://mainnet-api.voi.nodely.dev'}`);
    console.log(`Indexer: ${process.env.INDEXER_URL || 'https://mainnet-idx.voi.nodely.dev'}`);
  });
}

// Export app for Vercel serverless function
export default app;
