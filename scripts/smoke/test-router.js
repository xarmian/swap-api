// Test script for router/aggregator functionality
// Tests pool discovery and optimal routing across multiple DEXes
import axios from 'axios';

const API_URL = process.env.API_URL || 'http://localhost:3000';

async function testRouterWithoutPoolId() {
  try {
    console.log('Testing Router/Aggregator - Pool Discovery (no poolId)...\n');

    const requestBody = {
      address: 'BUD2763FMK6EYVKGHWWUN4QKHPSPCVFUEPPI4PQCPGYVPGQ6GNKBX6IXCQ',
      inputToken: 302190,  // USDC ASA (underlying token)
      outputToken: 0,       // Native VOI
      amount: '5000000',  // 100 USDC (6 decimals)
      slippageTolerance: 0.01
      // No poolId - should discover pools automatically
    };

    console.log('Request:');
    console.log(JSON.stringify(requestBody, null, 2));
    console.log('\n');

    const response = await axios.post(`${API_URL}/quote`, requestBody);

    console.log('Response:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n');

    if (response.data.error) {
      console.warn('Warning: Transaction generation failed, but quote was calculated');
      console.warn('Error:', response.data.error);
    }

    console.log('Test successful!');
    console.log(`Quote: ${response.data.quote.inputAmount} input → ${response.data.quote.outputAmount} output`);
    console.log(`Rate: ${response.data.quote.rate}`);
    console.log(`Price Impact: ${(response.data.quote.priceImpact * 100).toFixed(4)}%`);
    console.log(`Number of transactions: ${response.data.unsignedTransactions.length}`);
    
    if (response.data.route) {
      console.log('\nRoute Summary:');
      console.log(`Number of pools used: ${response.data.route.pools.length}`);
      response.data.route.pools.forEach((pool, idx) => {
        console.log(`  Pool ${idx + 1}:`);
        console.log(`    Pool ID: ${pool.poolId}`);
        console.log(`    DEX: ${pool.dex}`);
        console.log(`    Input Amount: ${pool.inputAmount}`);
        console.log(`    Output Amount: ${pool.outputAmount}`);
      });
    }

  } catch (error) {
    console.error('Test failed!');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Error:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('Error:', error.message);
    }
    process.exit(1);
  }
}

async function testRouterWithDexFilter() {
  try {
    console.log('\n\nTesting Router/Aggregator - With DEX Filter (nomadex only)...\n');

    const requestBody = {
      address: 'BUD2763FMK6EYVKGHWWUN4QKHPSPCVFUEPPI4PQCPGYVPGQ6GNKBX6IXCQ',
      inputToken: 302190,  // USDC ASA
      outputToken: 0,       // Native VOI
      amount: '100000000',  // 100 USDC
      slippageTolerance: 0.01,
      dex: ['nomadex']     // Only use Nomadex pools
    };

    console.log('Request:');
    console.log(JSON.stringify(requestBody, null, 2));
    console.log('\n');

    const response = await axios.post(`${API_URL}/quote`, requestBody);

    console.log('Response:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n');

    if (response.data.error) {
      console.warn('Warning: Transaction generation failed, but quote was calculated');
      console.warn('Error:', response.data.error);
    }

    console.log('Test successful!');
    console.log(`Quote: ${response.data.quote.inputAmount} input → ${response.data.quote.outputAmount} output`);
    console.log(`Rate: ${response.data.quote.rate}`);
    console.log(`Price Impact: ${(response.data.quote.priceImpact * 100).toFixed(4)}%`);
    console.log(`Number of transactions: ${response.data.unsignedTransactions.length}`);
    
    if (response.data.route) {
      console.log('\nRoute Summary:');
      response.data.route.pools.forEach((pool, idx) => {
        console.log(`  Pool ${idx + 1}: ${pool.dex} pool ${pool.poolId} - ${pool.inputAmount} in → ${pool.outputAmount} out`);
      });
    }

  } catch (error) {
    console.error('Test failed!');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Error:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('Error:', error.message);
    }
    process.exit(1);
  }
}

async function testRouterWithHumbleSwapFilter() {
  try {
    console.log('\n\nTesting Router/Aggregator - With DEX Filter (humbleswap only)...\n');

    const requestBody = {
      address: 'BUD2763FMK6EYVKGHWWUN4QKHPSPCVFUEPPI4PQCPGYVPGQ6GNKBX6IXCQ',
      inputToken: 302190,  // USDC ASA
      outputToken: 0,       // Native VOI
      amount: '100000000',  // 100 USDC
      slippageTolerance: 0.01,
      dex: ['humbleswap']  // Only use HumbleSwap pools
    };

    console.log('Request:');
    console.log(JSON.stringify(requestBody, null, 2));
    console.log('\n');

    const response = await axios.post(`${API_URL}/quote`, requestBody);

    console.log('Response:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n');

    if (response.data.error) {
      console.warn('Warning: Transaction generation failed, but quote was calculated');
      console.warn('Error:', response.data.error);
    }

    console.log('Test successful!');
    console.log(`Quote: ${response.data.quote.inputAmount} input → ${response.data.quote.outputAmount} output`);
    console.log(`Rate: ${response.data.quote.rate}`);
    console.log(`Price Impact: ${(response.data.quote.priceImpact * 100).toFixed(4)}%`);
    console.log(`Number of transactions: ${response.data.unsignedTransactions.length}`);
    
    if (response.data.route) {
      console.log('\nRoute Summary:');
      response.data.route.pools.forEach((pool, idx) => {
        console.log(`  Pool ${idx + 1}: ${pool.dex} pool ${pool.poolId} - ${pool.inputAmount} in → ${pool.outputAmount} out`);
      });
    }

  } catch (error) {
    console.error('Test failed!');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Error:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('Error:', error.message);
    }
    process.exit(1);
  }
}

// Run tests
async function runTests() {
  await testRouterWithoutPoolId();
  // await testRouterWithDexFilter();
  // await testRouterWithHumbleSwapFilter();
}

runTests();

