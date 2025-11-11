// Example test script for the swap API
import axios from 'axios';

const API_URL = process.env.API_URL || 'http://localhost:3000';

async function testQuote() {
  try {
    console.log('Testing /quote endpoint...\n');

    const requestBody = {
      address: 'BUD2763FMK6EYVKGHWWUN4QKHPSPCVFUEPPI4PQCPGYVPGQ6GNKBX6IXCQ',
      inputToken: 0,  // UNIT
      outputToken: 420069,      // Native VOI (will be wrapped to wVOI)
      amount: '80000000000', // 1 UNIT
      slippageTolerance: 0.01,
    };

    console.log('Request:');
    console.log(JSON.stringify(requestBody, null, 2));
    console.log('\n');

    const response = await axios.post(`${API_URL}/quote`, requestBody);

    console.log('Response:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n');

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

async function testUnwrapBatch() {
  try {
    console.log('Testing /unwrap endpoint (batch)...\n');

    const requestBody = {
      address: 'BUD2763FMK6EYVKGHWWUN4QKHPSPCVFUEPPI4PQCPGYVPGQ6GNKBX6IXCQ',
      items: [
        { wrappedTokenId: 390001, amount: '100000' },
        { wrappedTokenId: 395614, amount: '250000' }
      ]
    };

    console.log('Request:');
    console.log(JSON.stringify(requestBody, null, 2));
    console.log('\n');

    const response = await axios.post(`${API_URL}/unwrap`, requestBody);

    console.log('Response:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n');

    console.log('Batch unwrap test successful!');
    if (Array.isArray(response.data.items)) {
      console.log('Items (wrapped -> unwrapped):');
      for (const it of response.data.items) {
        console.log(`  ${it.wrappedTokenId} -> ${it.unwrappedTokenId} amount ${it.amount}`);
      }
    }
    console.log(`Transactions returned: ${response.data.unsignedTransactions.length}`);
    console.log(`Reported network fee: ${response.data.networkFee}`);
  } catch (error) {
    console.error('Batch unwrap test failed!');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Error:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('Error:', error.message);
    }
    process.exit(1);
  }
}

// Test health endpoint
async function testHealth() {
  try {
    console.log('Testing /health endpoint...\n');
    const response = await axios.get(`${API_URL}/health`);
    console.log('Response:', response.data);
    console.log('Health check passed!\n');
  } catch (error) {
    console.error('Health check failed!');
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Run tests
async function runTests() {
  await testHealth();
  await testQuote();
  await testUnwrapBatch();
}

runTests();
