# Swap API

A REST API for generating swap quotes and unsigned transactions using the [ulujs library](https://github.com/temptemp3/ulujs) on the Voi Network.

## Features

- Generate swap quotes with price impact calculation
- Create unsigned transaction groups for token swaps
- Support for ARC200 token pairs
- Local config for pools and ASA↔ARC200 mappings
- Configurable slippage tolerance
- AMM constant product formula for accurate pricing
- Multi-pool routing with optimal split calculation across multiple pools
- Support for multiple DEXes (HumbleSwap and Nomadex)
- Automatic pool discovery

## Installation

```bash
npm install
```

**Note:** This project requires `algosdk@^2.11.0` for compatibility with ulujs. The correct version is specified in `package.json` and will be installed automatically.

## Configuration

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Environment variables:
- `PORT` - API server port (default: 3000)
- `ALGOD_URL` - Algorand node URL (default: https://mainnet-api.voi.nodely.dev)
- `INDEXER_URL` - Algorand indexer URL (default: https://mainnet-idx.voi.nodely.dev)

### Local Config

Pools and token mappings are defined in `config/pools.json`. Optional token metadata (symbols/decimals) can be supplied in `config/tokens.json`.

Example `config/pools.json` entry for a HumbleSwap pool (`395553`):

```json
{
  "poolId": 395553,
  "dex": "humbleswap",
  "name": "USDC/VOI",
  "tokens": {
    "underlyingToWrapped": {
      "0": 390001,
      "302190": 395614
    },
    "wrappedPair": {
      "tokA": 390001,
      "tokB": 395614
    },
    "unwrap": [390001]
  },
  "slippageDefault": 0.01
}
```

Example `config/pools.json` entry for a Nomadex pool (`411756`):

```json
{
  "poolId": 411756,
  "dex": "nomadex",
  "name": "VOI/USDC",
  "tokens": {
    "tokA": {
      "id": 0,
      "type": "native"
    },
    "tokB": {
      "id": 302190,
      "type": "ASA"
    }
  },
  "slippageDefault": 0.01
}
```

## Usage

Start the server:

```bash
npm start
```

## API Endpoints

### POST /quote

Generate a swap quote and unsigned transaction group. The API supports both single-pool and multi-pool routing modes.

**Request Body:**

```json
{
  "address": "4LI2Z52C3WKIPFTVMCUJ5LSYU4KLUA6JNMQAQQRI6RAVIMZWAPI52F5YKY",
  "inputToken": 395614,
  "outputToken": 390001,
  "amount": "100000",
  "slippageTolerance": 0.01,
  "poolId": "395553",
  "dex": ["humbleswap", "nomadex"]
}
```

**Request Parameters:**

- `inputToken` (number, required) - Input token ID (underlying token, not wrapped)
- `outputToken` (number, required) - Output token ID (underlying token, not wrapped)
- `amount` (string, required) - Amount to swap (in base units)
- `address` (string, optional) - User's Algorand address (required for transaction generation)
- `slippageTolerance` (number, optional) - Slippage tolerance as decimal (e.g., 0.01 for 1%, default: 0.01)
- `poolId` (string, optional) - Pool contract ID. If provided, uses single-pool mode. If omitted, automatically discovers and routes across multiple matching pools
- `dex` (array of strings, optional) - Filter pools by DEX names (e.g., `["humbleswap", "nomadex"]`). Defaults to all configured DEXes

**Important:** 
- You may provide underlying ASA IDs (e.g., `302190` for USDC and `0` for VOI). The API resolves to the pool's wrapped ARC200 tokens using the local config and returns an atomic group that wraps → swaps → unwraps as needed.
- When `poolId` is omitted, the API automatically discovers all matching pools for the token pair and calculates an optimal split across them to maximize output.
- If `address` is not provided, the response will include quotes but no `unsignedTransactions` array.

**Response (Single Pool):**

```json
{
  "quote": {
    "inputAmount": "100000",
    "outputAmount": "241364206",
    "minimumOutputAmount": "238950564",
    "rate": 2413.6878332294536,
    "priceImpact": 0.001896375624964502
  },
  "unsignedTransactions": [
    "i6RhYW10zgABhqCkYXJjdsQgF41jnTu+6KCltC6Pxt+U2tAqr/c8B+BWAwIqYpVKcKyjZmVlzQPoomZ2zgDE6QWjZ2VurHZvaW1haW4tdjEuMKJnaMQgr20fSQI8gWe/kFZziNonSPCXLwcQmH/nxROvnnueWOmjZ3JwxCDznpLqegHnwTaM4goeTREq6DqO2pUY4rH9BDJiUzLGhKJsds4AxOzto3NuZMQg4tGs90LdlIeWdWConq5YpxS6A8lrIAhCKPRBVDM2A9GkdHlwZaVheGZlcqR4YWlkzgAEnG4=",
    "..."
  ],
  "poolId": "401594",
  "route": {
    "pools": [
      {
        "poolId": "401594",
        "dex": "humbleswap",
        "inputAmount": "100000",
        "outputAmount": "241364206"
      }
    ]
  }
}
```

**Response (Multi-Pool):**

```json
{
  "quote": {
    "inputAmount": "100000",
    "outputAmount": "245000000",
    "minimumOutputAmount": "242550000",
    "rate": 2450.0,
    "priceImpact": 0.0015
  },
  "unsignedTransactions": [
    "..."
  ],
  "poolId": null,
  "route": {
    "pools": [
      {
        "poolId": "401594",
        "dex": "humbleswap",
        "inputAmount": "60000",
        "outputAmount": "147000000"
      },
      {
        "poolId": "411756",
        "dex": "nomadex",
        "inputAmount": "40000",
        "outputAmount": "98000000"
      }
    ]
  }
}
```

**Response Fields:**

- `quote.inputAmount` - Input amount
- `quote.outputAmount` - Expected output amount (aggregated across all pools in multi-pool mode)
- `quote.minimumOutputAmount` - Minimum output after slippage tolerance (aggregated across all pools)
- `quote.rate` - Exchange rate (outputAmount / inputAmount), accounting for token decimals
- `quote.priceImpact` - Weighted average price impact as decimal (e.g., 0.001896 for ~0.19%)
- `unsignedTransactions` - Array of base64-encoded unsigned transactions (empty if `address` not provided)
- `poolId` - Pool contract ID used for the swap (single pool) or `null` (multi-pool)
- `route.pools` - Array of pools used in the swap, showing the split allocation for each pool

### GET /pool/:poolId

Get information about a specific swap pool. The response structure varies by DEX type.

**Parameters:**

- `poolId` (URL parameter, required) - Pool contract ID

**Response (HumbleSwap Pool):**

```json
{
  "poolId": "401594",
  "dex": "humbleswap",
  "tokA": 302190,
  "tokB": 0,
  "reserves": {
    "A": "1000000000",
    "B": "2000000000"
  },
  "fees": {
    "protoFee": 5,
    "lpFee": 25,
    "totFee": 30
  },
  "liquidity": {
    "lpHeld": "0",
    "lpMinted": "1414213562"
  },
  "locked": false
}
```

**Response (Nomadex Pool):**

```json
{
  "poolId": "411756",
  "dex": "nomadex",
  "tokA": 0,
  "tokB": 302190,
  "reserves": {
    "A": "1000000000",
    "B": "2000000000"
  },
  "fees": {
    "totFee": 30
  }
}
```

**Response Fields:**

- `poolId` - Pool contract ID
- `dex` - DEX type ("humbleswap" or "nomadex")
- `tokA` - Token A ID
- `tokB` - Token B ID
- `reserves.A` - Reserve amount for token A
- `reserves.B` - Reserve amount for token B
- `fees.totFee` - Total fee in basis points (always present)
- `fees.protoFee` - Protocol fee in basis points (HumbleSwap only)
- `fees.lpFee` - LP fee in basis points (HumbleSwap only)
- `liquidity.lpHeld` - LP tokens held (HumbleSwap only)
- `liquidity.lpMinted` - LP tokens minted (HumbleSwap only)
- `locked` - Whether pool is locked (HumbleSwap only)

### GET /health

Health check endpoint.

**Response:**

```json
{
  "status": "ok"
}
```

## How It Works

1. The API receives a swap request with input/output tokens and amount
2. **Pool Discovery**: If `poolId` is provided, uses that specific pool. Otherwise, automatically discovers all matching pools for the token pair from the local config, optionally filtered by DEX type
3. **Multi-Pool Routing** (when multiple pools match): Calculates an optimal split across pools using mathematical optimization to maximize total output. For two pools, uses calculus to find the optimal allocation. For more pools, tests common split strategies
4. For each pool (or pool in the route):
   - Fetches pool information from the swap200 contract (HumbleSwap) or Nomadex contract using ulujs
   - Calculates the output amount using the AMM constant product formula: `(reserveOut * amountIn * (10000 - fee)) / (reserveIn * 10000 + amountIn * (10000 - fee))`
   - Calculates price impact by comparing spot prices before and after the trade:
     - Spot price before: `outputReserve / inputReserve`
     - Spot price after: `(outputReserve - outputAmount) / (inputReserve + inputAmount)`
     - Price impact: `|(priceAfter - priceBefore) / priceBefore|`
     - This measures the percentage change in the pool's spot price due to the trade, which is the standard AMM definition of price impact
5. Aggregates quotes across all pools in the route (for multi-pool swaps), calculating weighted average price impact
6. Uses the local config to resolve ASA↔ARC200 mappings
7. Generates unsigned transactions using the ulujs swap method in simulation mode (includes wrap → swap → unwrap in one group when required). For multi-pool routes, generates transactions for each pool in the route
8. Returns the quote (with route breakdown) and unsigned transactions for the user to sign and submit

## Transaction Signing and Submission

The API returns unsigned transactions that must be:

1. Signed by the user's wallet
2. Assembled into a transaction group
3. Submitted to an Algorand node

Example using algosdk:

```javascript
const algosdk = require('algosdk');

// Decode unsigned transactions
const txns = unsignedTransactions.map(txn =>
  algosdk.decodeUnsignedTransaction(Buffer.from(txn, 'base64'))
);

// Sign transactions (use your wallet's signing method)
const signedTxns = await wallet.signTransactions(txns);

// Submit to node
const { txId } = await algodClient.sendRawTransaction(signedTxns).do();
await algosdk.waitForConfirmation(algodClient, txId, 4);
```

## Pool Discovery

The pool ID can be provided in the request body to use a specific pool, or omitted to enable automatic pool discovery and multi-pool routing. You can view all configured pools via `GET /config/pools`.

## Error Handling

The API returns appropriate HTTP status codes:

- `200` - Success
- `400` - Bad request (missing or invalid parameters)
- `500` - Internal server error (pool info fetch failed, transaction generation failed, etc.)

Error responses include an `error` field with a description:

```json
{
  "error": "Missing required fields: inputToken, outputToken, amount"
}
```

## Dependencies

- `express` - Web framework
- `ulujs` - Algorand smart contract interaction library
- `algosdk@^2.11.0` - Algorand JavaScript SDK (v2.11.x for ulujs compatibility)
- `cors` - CORS middleware
- `dotenv` - Environment variable management

## License

ISC
