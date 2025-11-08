import algosdk from 'algosdk';
import dotenv from 'dotenv';

dotenv.config();

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

export { algodClient, indexerClient };

