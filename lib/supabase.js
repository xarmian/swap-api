import { createClient } from '@supabase/supabase-js';
import algosdk from 'algosdk';

// Initialize Supabase client if enabled
let supabaseClient = null;

function getSupabaseClient() {
  if (supabaseClient !== null) {
    return supabaseClient;
  }

  const enabled = process.env.SUPABASE_ENABLED === 'true' || process.env.SUPABASE_ENABLED === '1';
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;

  if (!enabled || !url || !key) {
    supabaseClient = false; // Mark as disabled to avoid re-checking
    return null;
  }

  try {
    supabaseClient = createClient(url, key);
    return supabaseClient;
  } catch (error) {
    console.error('Failed to initialize Supabase client:', error);
    supabaseClient = false;
    return null;
  }
}

/**
 * Extract group ID from base64-encoded transactions
 * @param {Array<string>} transactions - Array of base64-encoded transaction strings
 * @returns {string|null} Group ID as base64 string, or null if not available
 */
export function extractGroupId(transactions) {
  if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
    return null;
  }

  try {
    // Decode the first transaction to get the group ID
    const firstTxnBase64 = transactions[0];
    const txnBuffer = Buffer.from(firstTxnBase64, 'base64');
    const txn = algosdk.decodeUnsignedTransaction(txnBuffer);

    if (txn.group) {
      // Group ID is a 32-byte Buffer, convert to base64 string
      return Buffer.from(txn.group).toString('base64');
    }

    return null;
  } catch (error) {
    console.error('Error extracting group ID from transactions:', error);
    return null;
  }
}

/**
 * Log a quote request to Supabase
 * @param {Object} data - Quote request data
 * @param {string} data.address - User address (nullable)
 * @param {string} data.inputToken - Input token ID
 * @param {string} data.outputToken - Output token ID
 * @param {string} data.inputAmount - Input amount as string
 * @param {string|null} data.outputAmount - Output amount as string (nullable)
 * @param {string|null} data.minimumOutputAmount - Minimum output amount as string (nullable)
 * @param {number|null} data.rate - Exchange rate (nullable)
 * @param {number|null} data.priceImpact - Price impact (nullable)
 * @param {string|null} data.routeType - Route type: 'direct' or 'multi-hop' (nullable)
 * @param {string|null} data.poolId - Single pool ID (nullable)
 * @param {Object|null} data.route - Full route details as object (nullable)
 * @param {number|null} data.slippageTolerance - Slippage tolerance (nullable)
 * @param {string|null} data.networkFeeEstimate - Network fee estimate as string (nullable)
 * @param {Array<string>|null} data.transactions - Base64-encoded transactions (nullable)
 * @param {string|null} data.error - Error message if request failed (nullable)
 */
export async function logQuoteRequest(data) {
  const client = getSupabaseClient();
  if (!client) {
    return; // Supabase disabled or not configured
  }

  // Extract group ID from transactions if available
  let groupId = null;
  if (data.transactions && data.transactions.length > 0) {
    groupId = extractGroupId(data.transactions);
  }

  const record = {
    request_type: 'quote',
    address: data.address || null,
    input_token: String(data.inputToken),
    output_token: String(data.outputToken),
    input_amount: String(data.inputAmount),
    output_amount: data.outputAmount ? String(data.outputAmount) : null,
    minimum_output_amount: data.minimumOutputAmount ? String(data.minimumOutputAmount) : null,
    rate: data.rate !== null && data.rate !== undefined ? Number(data.rate) : null,
    price_impact: data.priceImpact !== null && data.priceImpact !== undefined ? Number(data.priceImpact) : null,
    route_type: data.routeType || null,
    pool_id: data.poolId || null,
    route: data.route || null,
    slippage_tolerance: data.slippageTolerance !== null && data.slippageTolerance !== undefined ? Number(data.slippageTolerance) : null,
    network_fee_estimate: data.networkFeeEstimate ? String(data.networkFeeEstimate) : null,
    group_id: groupId,
    error: data.error || null
  };

  try {
    // Fire and forget - don't await, don't throw
    client.from('sb_api_requests').insert(record).then(
      () => {
        // Success - silently continue
      },
      (error) => {
        console.error('Failed to log quote request to Supabase:', error);
      }
    );
  } catch (error) {
    console.error('Error logging quote request to Supabase:', error);
  }
}

/**
 * Log an unwrap request to Supabase
 * @param {Object} data - Unwrap request data
 * @param {string} data.address - User address
 * @param {Array<Object>} data.items - Array of unwrap items with wrappedTokenId, unwrappedTokenId, amount
 * @param {string|null} data.networkFeeEstimate - Network fee estimate as string (nullable)
 * @param {Array<string>|null} data.transactions - Base64-encoded transactions (nullable)
 * @param {string|null} data.error - Error message if request failed (nullable)
 */
export async function logUnwrapRequest(data) {
  const client = getSupabaseClient();
  if (!client) {
    return; // Supabase disabled or not configured
  }

  // Extract group ID from transactions if available
  let groupId = null;
  if (data.transactions && data.transactions.length > 0) {
    groupId = extractGroupId(data.transactions);
  }

  const record = {
    request_type: 'unwrap',
    address: data.address || null,
    items: data.items || null,
    network_fee_estimate: data.networkFeeEstimate ? String(data.networkFeeEstimate) : null,
    group_id: groupId,
    error: data.error || null
  };

  try {
    // Fire and forget - don't await, don't throw
    client.from('sb_api_requests').insert(record).then(
      () => {
        // Success - silently continue
      },
      (error) => {
        console.error('Failed to log unwrap request to Supabase:', error);
      }
    );
  } catch (error) {
    console.error('Error logging unwrap request to Supabase:', error);
  }
}

