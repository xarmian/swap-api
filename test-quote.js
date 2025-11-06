// Example test script for the swap API
import axios from 'axios';

const API_URL = process.env.API_URL || 'http://localhost:3000';

async function testQuote() {
  try {
    console.log('Testing /quote endpoint...\n');

    const requestBody = {
      address: '4LI2Z52C3WKIPFTVMCUJ5LSYU4KLUA6JNMQAQQRI6RAVIMZWAPI52F5YKY',
      inputToken: 302190,  // USDC ASA (will be wrapped to aUSDC)
      outputToken: 0,      // Native VOI (will be wrapped to wVOI)
      amount: '100000',
      slippageTolerance: 0.01,
      poolId: '395553'
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
}

runTests();
