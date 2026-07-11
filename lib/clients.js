import algosdk from 'algosdk';
import dotenv from 'dotenv';
import { TimeoutRetryHTTPClient } from './httpClient.js';

dotenv.config();

const ALGOD_URL = process.env.ALGOD_URL || 'https://mainnet-api.voi.nodely.dev';
const INDEXER_URL = process.env.INDEXER_URL || 'https://mainnet-idx.voi.nodely.dev';

// Algorand clients (using Voi mainnet). Requests are bounded by a timeout
// and idempotent reads get one bounded retry — see lib/httpClient.js.
const algodHTTPClient = new TimeoutRetryHTTPClient(
  { 'X-Algo-API-Token': process.env.ALGOD_TOKEN || '' },
  ALGOD_URL,
  process.env.ALGOD_PORT || ''
);
const algodClient = new algosdk.Algodv2(algodHTTPClient, ALGOD_URL, process.env.ALGOD_PORT || '');

const indexerHTTPClient = new TimeoutRetryHTTPClient(
  { 'X-Indexer-API-Token': process.env.INDEXER_TOKEN || '' },
  INDEXER_URL,
  process.env.INDEXER_PORT || ''
);
const indexerClient = new algosdk.Indexer(indexerHTTPClient, INDEXER_URL, process.env.INDEXER_PORT || '');

export { algodClient, indexerClient };

