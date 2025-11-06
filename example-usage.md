# Example Usage

## Starting the Server

```bash
npm start
```

The server will start on port 3000 (or the port specified in your .env file).

## Example 1: Get Pool Information

First, let's get information about a pool:

```bash
curl http://localhost:3000/pool/401594
```

Response:
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

## Example 2: Get a Swap Quote

Now let's get a quote for swapping 100,000 units of token 302190 for native token (0):

```bash
curl -X POST http://localhost:3000/quote \
  -H "Content-Type: application/json" \
  -d '{
    "address": "4LI2Z52C3WKIPFTVMCUJ5LSYU4KLUA6JNMQAQQRI6RAVIMZWAPI52F5YKY",
    "inputToken": 302190,
    "outputToken": 0,
    "amount": "100000",
    "slippageTolerance": 0.01,
    "poolId": "401594"
  }'
```

Response:
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
    "iqRhcGFhksQEdK6pk8QgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABhqCkYXBpZM4ABgleo2ZlZc0D6KJmds4AxOkFo2dlbqx2b2ltYWluLXYxLjCiZ2jEIK9tH0kCPIFnv5BWc4jaJ0jwly8HEJh/58UTr557nljpo2dycMQg856S6noB58E2jOIKHk0RKug6jtqVGOKx/QQyYlMyxoSibHbOAMTs7aNzbmTEIOLRrPdC3ZSHlnVgqJ6uWKcUugPJayAIQij0QVQzNgPRpHR5cGWkYXBwbA==",
    "iqRhcGFhk8QEtUIhJcQg2FoVEFsWBMI9Tjb2v+4FCi2Gl0w1q+c3J4CkDyjjOfDEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYagpGFwaWTOAAYJXqNmZWXNA+iiZnbOAMTpBaNnZW6sdm9pbWFpbi12MS4womdoxCCvbR9JAjyBZ7+QVnOI2idI8JcvBxCYf+fFE6+ee55Y6aNncnDEIPOekup6AefBNoziCh5NESroOo7alRjisf0EMmJTMsaEomx2zgDE7O2jc25kxCDi0az3Qt2Uh5Z1YKierlinFLoDyWsgCEIo9EFUMzYD0aR0eXBlpGFwcGw=",
    "i6RhcGFhlMQEnLvtu8QBAMQgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABhqDEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAORYR/pGFwYniRgaFuxAEApGFwaWTOAAYJIaNmZWXOABKtQKJmds4AxOkFo2dlbqx2b2ltYWluLXYxLjCiZ2jEIK9tH0kCPIFnv5BWc4jaJ0jwly8HEJh/58UTr557nljpo2dycMQg856S6noB58E2jOIKHk0RKug6jtqVGOKx/QQyYlMyxoSibHbOAMTs7aNzbmTEIOLRrPdC3ZSHlnVgqJ6uWKcUugPJayAIQij0QVQzNgPRpHR5cGWkYXBwbA=="
  ],
  "poolId": "401594"
}
```

## Example 3: Using the Test Script

Run the included test script:

```bash
node test-quote.js
```

This will test both the health endpoint and the quote endpoint.

## Example 4: Signing and Submitting Transactions

After getting the unsigned transactions from the API, you need to:

1. Decode the transactions
2. Sign them with your wallet
3. Submit them to the network

Here's an example using algosdk:

```javascript
const algosdk = require('algosdk');

async function signAndSubmit(unsignedTransactions, wallet) {
  // Initialize algod client
  const algodClient = new algosdk.Algodv2(
    '',
    'https://mainnet-api.voi.nodly.io',
    ''
  );

  // Decode unsigned transactions
  const txns = unsignedTransactions.map(txn =>
    algosdk.decodeUnsignedTransaction(Buffer.from(txn, 'base64'))
  );

  // Assign group ID
  algosdk.assignGroupID(txns);

  // Sign transactions (this depends on your wallet implementation)
  // Example with a simple secret key:
  const signedTxns = txns.map(txn => txn.signTxn(wallet.sk));

  // Submit to network
  const { txId } = await algodClient.sendRawTransaction(signedTxns).do();

  console.log('Transaction submitted! TxID:', txId);

  // Wait for confirmation
  const confirmedTxn = await algosdk.waitForConfirmation(
    algodClient,
    txId,
    4
  );

  console.log('Transaction confirmed in round:', confirmedTxn['confirmed-round']);

  return txId;
}
```

## Understanding the Response

### Quote Fields

- **inputAmount**: The amount you're swapping (same as your input)
- **outputAmount**: The expected amount you'll receive
- **minimumOutputAmount**: The minimum you'll accept (based on slippage tolerance)
- **rate**: The exchange rate (outputAmount / inputAmount)
- **priceImpact**: How much your trade affects the pool price (0.0019 = 0.19% impact)

### Important Notes

1. The `amount` should be in base units (considering token decimals)
2. Token ID `0` represents the native token (VOI)
3. Slippage tolerance of 0.01 = 1% slippage protection
4. Price impact shows how much your trade moves the market
5. All unsigned transactions must be signed and submitted together as a group
