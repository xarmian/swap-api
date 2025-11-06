# Swap API

A REST API for generating swap quotes and unsigned transactions using the [ulujs library](https://github.com/temptemp3/ulujs) on the Voi Network.

## Features

- Generate swap quotes with price impact calculation
- Create unsigned transaction groups for token swaps
- Support for ARC200 token pairs
- Local config for pools and ASA↔ARC200 mappings
- Configurable slippage tolerance
- AMM constant product formula for accurate pricing

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

Example `config/pools.json` entry for pool `395553`:

```json
{
  "poolId": 395553,
  "name": "USDC/VOI (ARC200)",
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

## Usage

Start the server:

```bash
npm start
```

## API Endpoints

### POST /quote

Generate a swap quote and unsigned transaction group.

**Request Body:**

```json
{
  "address": "4LI2Z52C3WKIPFTVMCUJ5LSYU4KLUA6JNMQAQQRI6RAVIMZWAPI52F5YKY",
  "inputToken": 395614,
  "outputToken": 390001,
  "amount": "100000",
  "slippageTolerance": 0.01,
  "poolId": "395553"
}
```

**Request Parameters:**

- `address` (string, required) - User's Algorand address
- `inputToken` (number, required) - Input token ID (must match pool's tokA or tokB)
- `outputToken` (number, required) - Output token ID (must match pool's tokA or tokB)
- `amount` (string, required) - Amount to swap (in base units)
- `slippageTolerance` (number, optional) - Slippage tolerance as decimal (e.g., 0.01 for 1%, default: 0.01)
- `poolId` (string, required) - Pool contract ID

**Important:** You may provide underlying ASA IDs (e.g., `302190` for USDC and `0` for VOI). The API resolves to the pool's wrapped ARC200 tokens using the local config and returns an atomic group that wraps → swaps → unwraps as needed.

**Response:**

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
  "poolId": "401594"
}
```

**Response Fields:**

- `quote.inputAmount` - Input amount
- `quote.outputAmount` - Expected output amount
- `quote.minimumOutputAmount` - Minimum output after slippage tolerance
- `quote.rate` - Exchange rate (outputAmount / inputAmount)
- `quote.priceImpact` - Price impact as decimal (e.g., 0.001896 for ~0.19%)
- `unsignedTransactions` - Array of base64-encoded unsigned transactions
- `poolId` - Pool contract ID used for the swap

### GET /pool/:poolId

Get information about a specific swap pool.

**Parameters:**

- `poolId` (URL parameter, required) - Pool contract ID

**Response:**

```json
{
  "poolId": "401594",
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
2. It fetches pool information from the swap200 contract using ulujs
3. Calculates the output amount using the AMM constant product formula: `(reserveOut * amountIn * (10000 - fee)) / (reserveIn * 10000 + amountIn * (10000 - fee))`
4. Calculates price impact based on spot price vs. effective price
5. Uses the local config to resolve ASA↔ARC200 mappings
6. Generates unsigned transactions using the ulujs swap method in simulation mode (includes wrap → swap → unwrap in one group when required)
7. Returns the quote and unsigned transactions for the user to sign and submit

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

The pool ID must be provided in the request body. You can view configured pools via `GET /config/pools`.

## Error Handling

The API returns appropriate HTTP status codes:

- `200` - Success
- `400` - Bad request (missing or invalid parameters)
- `500` - Internal server error (pool info fetch failed, transaction generation failed, etc.)

Error responses include an `error` field with a description:

```json
{
  "error": "Missing required fields: address, inputToken, outputToken, amount"
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
