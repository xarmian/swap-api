// Unit tests for the HumbleSwap buffered withdraw amount (lib/humbleswap-arccjs.js).
// Run with: node --test tests/humbleswap-withdraw-buffer.test.js
//
// withdraw(uint64) REVERTS when the requested amount exceeds the caller's wrapped
// balance (TASK-41 verified this on-chain: `assert callerBalance >= amount`, no clamp
// or withdraw-all). Reserve drift between quote-time and submission means the actual
// credited output A only satisfies A >= minAmountOut, so withdrawing exactly
// expectedAmountOut reverts swaps whose A lands in [minAmountOut, expectedAmountOut).
// We instead withdraw:
//   W = max( minAmountOut, floor(expectedAmountOut * (10000 - 10) / 10000) )
// preserving the invariant minAmountOut <= W <= expectedAmountOut.
//
// Pure BigInt math: no network, no chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeWithdrawAmount } from '../lib/humbleswap-arccjs.js';

// Independent reference of the buffered formula (0.1% = 10 bps).
function ref(expected, min) {
  const buffered = (expected * (10000n - 10n)) / 10000n;
  return buffered > min ? buffered : min;
}

test('applies the 0.1% buffer when it stays above the minimum', () => {
  // expected large, min well below the buffered value: W == floor(expected * 0.999).
  const expected = 1_000_000n;
  const min = 900_000n;
  const W = computeWithdrawAmount(expected, min);
  assert.equal(W, 999_000n); // floor(1_000_000 * 9990 / 10000)
  assert.equal(W, ref(expected, min));
});

test('floors at the minimum when the buffer would push below it', () => {
  // Buffered value (999_000) < min (999_500): the max(...) floor binds -> W == min.
  const expected = 1_000_000n;
  const min = 999_500n;
  const W = computeWithdrawAmount(expected, min);
  assert.equal(W, min);
  assert.equal(W, ref(expected, min));
});

test('invariant min <= W <= expected across a range of inputs', () => {
  const cases = [
    [1_000_000n, 1n],
    [1_000_000n, 500_000n],
    [1_000_000n, 999_000n],
    [1_000_000n, 999_500n],
    [1_000_000n, 1_000_000n], // min == expected (zero slippage band)
    [123_456_789n, 100_000_000n],
    [7n, 1n],
    [1n, 1n],
  ];
  for (const [expected, min] of cases) {
    const W = computeWithdrawAmount(expected, min);
    assert.ok(W >= min, `W (${W}) below min (${min})`);
    assert.ok(W <= expected, `W (${W}) above expected (${expected})`);
    assert.equal(W, ref(expected, min));
  }
});

test('W never exceeds expected even when min == expected', () => {
  // When the slippage band is zero, buffered < min == expected, so W == expected (not above).
  const expected = 5_000_000n;
  const W = computeWithdrawAmount(expected, expected);
  assert.equal(W, expected);
  assert.ok(W <= expected);
});

test('uses floor division (no rounding up) for the buffer', () => {
  // expected = 10001, buffer 10 bps: 10001 * 9990 / 10000 = 99909990/10000 = 9990.999 -> 9990.
  const expected = 10001n;
  const min = 1n;
  assert.equal(computeWithdrawAmount(expected, min), 9990n);
});

test('BigInt-clean above 2^53 (no Number precision loss)', () => {
  // Values beyond Number.MAX_SAFE_INTEGER (2^53) must stay exact.
  const expected = 9_007_199_254_740_993n; // 2^53 + 1
  const min = 1n;
  const buffered = (expected * 9990n) / 10000n;
  const W = computeWithdrawAmount(expected, min);
  assert.equal(W, buffered);
  assert.equal(W, 8_998_192_055_486_252n);
  // Number-based math would lose precision here; confirm the low digits survive exactly.
  assert.notEqual(W, BigInt(Math.floor(Number(expected) * 0.999)));
  assert.ok(W <= expected && W >= min);
});

test('handles very large uint64-scale outputs exactly', () => {
  const expected = 18_000_000_000_000_000_000n; // near uint64 max
  const min = 17_000_000_000_000_000_000n;
  const W = computeWithdrawAmount(expected, min);
  assert.equal(W, (expected * 9990n) / 10000n);
  assert.ok(W >= min && W <= expected);
});
