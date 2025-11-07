// Test script for Nomadex pool swaps
import axios from 'axios';

const API_URL = process.env.API_URL || 'http://localhost:3000';

async function testNomadexQuote() {
  try {
    console.log('Testing Nomadex /quote endpoint...\n');

    const requestBody = {
      address: '4LI2Z52C3WKIPFTVMCUJ5LSYU4KLUA6JNMQAQQRI6RAVIMZWAPI52F5YKY',
      inputToken: 0,      // Native VOI
      outputToken: 302190, // USDC ASA
      amount: '1000000',   // 1 VOI (6 decimals)
      slippageTolerance: 0.01,
      poolId: '411756'     // Nomadex USDC/VOI pool
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

async function testNomadexPoolInfo() {
  try {
    console.log('Testing Nomadex /pool/:poolId endpoint...\n');

    const response = await axios.get(`${API_URL}/pool/411756`);

    console.log('Response:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n');

    console.log('Test successful!');
    console.log(`Pool ID: ${response.data.poolId}`);
    console.log(`DEX: ${response.data.dex}`);
    console.log(`Token A: ${response.data.tokA}, Token B: ${response.data.tokB}`);
    console.log(`Reserve A: ${response.data.reserves.A}`);
    console.log(`Reserve B: ${response.data.reserves.B}`);
    console.log(`Total Fee: ${response.data.fees.totFee} basis points`);

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

async function testNomadexReverseSwap() {
  try {
    console.log('Testing Nomadex reverse swap (USDC -> VOI)...\n');

    const requestBody = {
      address: '4LI2Z52C3WKIPFTVMCUJ5LSYU4KLUA6JNMQAQQRI6RAVIMZWAPI52F5YKY',
      inputToken: 302190, // USDC ASA
      outputToken: 0,     // Native VOI
      amount: '100000',   // 0.1 USDC (6 decimals)
      slippageTolerance: 0.01,
      poolId: '411756'    // Nomadex USDC/VOI pool
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
  await testNomadexPoolInfo();
  await testNomadexQuote();
  await testNomadexReverseSwap();
}

runTests();

