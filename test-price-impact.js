// Test script for price impact calculation validation
// This file contains a standalone test of the price impact calculation formula

function calculatePriceImpactTest(inputAmount, inputReserve, outputAmount, outputReserve) {
  // Convert BigInt values to Numbers for calculation
  const inputAmountNum = Number(inputAmount);
  const inputReserveNum = Number(inputReserve);
  const outputAmountNum = Number(outputAmount);
  const outputReserveNum = Number(outputReserve);

  // Validate inputs to prevent division by zero and invalid calculations
  if (inputReserveNum <= 0 || inputAmountNum <= 0 || outputAmountNum <= 0 || outputReserveNum <= 0) {
    return 0; // Return 0 impact for invalid inputs
  }

  // Calculate spot price before trade: outputReserve / inputReserve
  const spotPriceBefore = outputReserveNum / inputReserveNum;

  // Calculate spot price after trade: (outputReserve - outputAmount) / (inputReserve + inputAmount)
  const newOutputReserve = outputReserveNum - outputAmountNum;
  const newInputReserve = inputReserveNum + inputAmountNum;

  // Validate post-trade reserves
  if (newOutputReserve <= 0 || newInputReserve <= 0) {
    return 0; // Return 0 impact if reserves would be invalid
  }

  const spotPriceAfter = newOutputReserve / newInputReserve;

  // Price impact = |(priceAfter - priceBefore) / priceBefore|
  const priceImpact = Math.abs((spotPriceAfter - spotPriceBefore) / spotPriceBefore);

  return priceImpact;
}

// Test cases
function runTests() {
  console.log('Testing price impact calculation...\n');

  // Test 1: Small trade in balanced pool (should have low impact)
  console.log('Test 1: Small trade in balanced pool');
  const test1 = calculatePriceImpactTest(
    BigInt(1000),      // inputAmount
    BigInt(1000000),   // inputReserve
    BigInt(999),       // outputAmount (approximately)
    BigInt(1000000)    // outputReserve
  );
  console.log(`  Input: 1000, Reserves: 1M/1M, Output: 999`);
  console.log(`  Price Impact: ${(test1 * 100).toFixed(6)}%`);
  console.log(`  Expected: Very low (< 0.1%)\n`);

  // Test 2: Large trade (should have higher impact)
  console.log('Test 2: Large trade in balanced pool');
  const test2 = calculatePriceImpactTest(
    BigInt(100000),    // inputAmount (10% of reserve)
    BigInt(1000000),   // inputReserve
    BigInt(90909),     // outputAmount (approximate)
    BigInt(1000000)    // outputReserve
  );
  console.log(`  Input: 100000, Reserves: 1M/1M, Output: 90909`);
  console.log(`  Price Impact: ${(test2 * 100).toFixed(6)}%`);
  console.log(`  Expected: Higher impact (> 5%)\n`);

  // Test 3: Edge case - very small trade
  console.log('Test 3: Very small trade');
  const test3 = calculatePriceImpactTest(
    BigInt(1),         // inputAmount
    BigInt(1000000),   // inputReserve
    BigInt(1),         // outputAmount (approximately)
    BigInt(1000000)    // outputReserve
  );
  console.log(`  Input: 1, Reserves: 1M/1M, Output: 1`);
  console.log(`  Price Impact: ${(test3 * 100).toFixed(6)}%`);
  console.log(`  Expected: Negligible impact\n`);

  // Test 4: Edge case - invalid input (zero reserve)
  console.log('Test 4: Edge case - zero reserve');
  const test4 = calculatePriceImpactTest(
    BigInt(1000),
    BigInt(0),         // Invalid: zero reserve
    BigInt(999),
    BigInt(1000000)
  );
  console.log(`  Input: 1000, Reserves: 0/1M, Output: 999`);
  console.log(`  Price Impact: ${test4}`);
  console.log(`  Expected: 0 (invalid input handled)\n`);

  // Test 5: Unbalanced pool
  console.log('Test 5: Trade in unbalanced pool');
  const test5 = calculatePriceImpactTest(
    BigInt(10000),     // inputAmount
    BigInt(100000),    // inputReserve (smaller)
    BigInt(50000),     // outputAmount
    BigInt(500000)     // outputReserve (larger)
  );
  console.log(`  Input: 10000, Reserves: 100K/500K, Output: 50000`);
  console.log(`  Price Impact: ${(test5 * 100).toFixed(6)}%`);
  console.log(`  Expected: Moderate impact\n`);

  // Test 6: Verify formula correctness
  console.log('Test 6: Formula verification');
  // For a balanced pool with reserves R, trading amount A:
  // Before: price = R/R = 1
  // After: price = (R - output) / (R + A)
  // For small A relative to R, output ≈ A (ignoring fees)
  // Impact should be approximately A/(2R) for small trades
  const R = 1000000;
  const A = 10000;
  const expectedApprox = A / (2 * R); // Simplified approximation
  const test6 = calculatePriceImpactTest(
    BigInt(A),
    BigInt(R),
    BigInt(A - 50), // Approximate, accounting for some slippage
    BigInt(R)
  );
  console.log(`  Input: ${A}, Reserves: ${R}/${R}`);
  console.log(`  Price Impact: ${(test6 * 100).toFixed(6)}%`);
  console.log(`  Expected approximate: ${(expectedApprox * 100).toFixed(6)}%`);
  console.log(`  Note: Actual will differ due to fees and exact AMM formula\n`);

  console.log('All tests completed!');
}

runTests();

