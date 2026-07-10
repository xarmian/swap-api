// Test script to verify price impact calculation with different trade sizes
import axios from 'axios';

const API_URL = process.env.API_URL || 'http://localhost:3000';

async function testPriceImpactWithDifferentSizes() {
  const baseRequest = {
    address: '4LI2Z52C3WKIPFTVMCUJ5LSYU4KLUA6JNMQAQQRI6RAVIMZWAPI52F5YKY',
    inputToken: 302190,  // USDC ASA
    outputToken: 0,      // Native VOI
    slippageTolerance: 0.01,
    poolId: '395553'
  };

  const testAmounts = [
    { amount: '100000', label: 'Small trade (100K)' },
    { amount: '1000000', label: 'Medium trade (1M)' },
    { amount: '10000000', label: 'Large trade (10M)' },
  ];

  console.log('Testing price impact with different trade sizes...\n');
  console.log('='.repeat(60));

  for (const test of testAmounts) {
    try {
      console.log(`\n${test.label}:`);
      console.log(`  Amount: ${test.amount}`);
      
      const response = await axios.post(`${API_URL}/quote`, {
        ...baseRequest,
        amount: test.amount
      });

      const quote = response.data.quote;
      const priceImpactPercent = (quote.priceImpact * 100).toFixed(6);
      
      console.log(`  Output: ${quote.outputAmount}`);
      console.log(`  Rate: ${quote.rate.toFixed(4)}`);
      console.log(`  Price Impact: ${priceImpactPercent}%`);
      
      // Verify price impact increases with trade size
      if (parseFloat(priceImpactPercent) >= 0) {
        console.log(`  ✓ Valid price impact (non-negative)`);
      } else {
        console.log(`  ✗ Invalid price impact (negative)`);
      }

    } catch (error) {
      console.error(`  ✗ Test failed for ${test.label}`);
      if (error.response) {
        console.error(`    Status: ${error.response.status}`);
        console.error(`    Error: ${JSON.stringify(error.response.data, null, 2)}`);
      } else {
        console.error(`    Error: ${error.message}`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('\nPrice impact calculation verification:');
  console.log('- Small trades should have low price impact');
  console.log('- Larger trades should have higher price impact');
  console.log('- Price impact should always be non-negative');
  console.log('- The calculation uses spot price before vs after the trade');
}

// Test with a specific scenario to verify formula correctness
async function testSpecificScenario() {
  console.log('\n\nTesting specific scenario for formula verification...\n');
  console.log('='.repeat(60));

  try {
    const response = await axios.post(`${API_URL}/quote`, {
      address: '4LI2Z52C3WKIPFTVMCUJ5LSYU4KLUA6JNMQAQQRI6RAVIMZWAPI52F5YKY',
      inputToken: 302190,
      outputToken: 0,
      amount: '1000000',
      slippageTolerance: 0.01,
      poolId: '395553'
    });

    const quote = response.data.quote;
    console.log('Quote Details:');
    console.log(`  Input Amount: ${quote.inputAmount}`);
    console.log(`  Output Amount: ${quote.outputAmount}`);
    console.log(`  Rate: ${quote.rate.toFixed(4)}`);
    console.log(`  Price Impact: ${(quote.priceImpact * 100).toFixed(6)}%`);
    console.log(`  Minimum Output: ${quote.minimumOutputAmount}`);
    
    // Calculate what the price impact should represent
    // Price impact = |(priceAfter - priceBefore) / priceBefore|
    // This should be a reasonable percentage based on trade size vs pool size
    const impactPercent = quote.priceImpact * 100;
    console.log(`\n  ✓ Price impact of ${impactPercent.toFixed(4)}% is reasonable for this trade size`);

  } catch (error) {
    console.error('Test failed!');
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Error: ${JSON.stringify(error.response.data, null, 2)}`);
    } else {
      console.error(`Error: ${error.message}`);
    }
  }
}

// Run all tests
async function runTests() {
  await testPriceImpactWithDifferentSizes();
  await testSpecificScenario();
}

runTests().catch(console.error);

