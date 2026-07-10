// Unit tests for the HumbleSwap constant-product output (lib/humbleswap.js).
// Run with: node --test tests/humbleswap-output.test.js
//
// HumbleSwap uses the standard Uniswap-v2 fee-adjusted-INPUT curve:
//   amountInWithFee = amountIn * (10000 - feeBps)
//   out = (amountInWithFee * reserveOut) / (reserveIn * 10000 + amountInWithFee)
// with a single trailing floor division. (This differs from Nomadex, which
// applies the fee to the numerator only — see nomadex-output.test.js.)
//
// Pure BigInt math: no network, no chain, no node_modules required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOutputAmount } from '../lib/humbleswap.js';

// Independent reference of the fee-adjusted-input formula.
function ref(amountIn, reserveIn, reserveOut, feeBps) {
  const inWithFee = BigInt(amountIn) * BigInt(10000 - feeBps);
  return (inWithFee * BigInt(reserveOut)) / (BigInt(reserveIn) * 10000n + inWithFee);
}

test('matches the fee-adjusted-input formula (0.3% fee, symmetric reserves)', () => {
  // in=1000, rin=rout=1e6, 30 bps: 997*1e9 / (1e10 + 997000) => 996.
  const out = calculateOutputAmount(1000n, 1_000_000n, 1_000_000n, 30);
  assert.equal(out, ref(1000n, 1_000_000n, 1_000_000n, 30));
  assert.equal(out, 996n);
});

test('applies the fee to the input inside the denominator (regression vs numerator-only)', () => {
  // The Nomadex-style numerator-only formula would give a DIFFERENT value;
  // pin that HumbleSwap uses the fee-adjusted denominator.
  const in_ = 1000n, rin = 1000n, rout = 1000n, feeBps = 200;
  assert.equal(calculateOutputAmount(in_, rin, rout, feeBps), 494n); // fee-adjusted-input
  // (numerator-only would be 490n — see nomadex-output.test.js)
});

test('matches the reference across asymmetric and large reserves', () => {
  const cases = [
    [1_000_000n, 5_000_000n, 250_000_000n, 30],
    [7n, 5_000_000n, 250_000_000n, 30],
    [999_999_999n, 12_345_678n, 87_654_321n, 250],
    [1_000_000_000_000_000_000n, 3_000_000_000_000n, 9_000_000_000_000n, 100],
    [1000n, 1000n, 1000n, 0], // zero-fee edge
  ];
  for (const [a, ri, ro, f] of cases) {
    assert.equal(calculateOutputAmount(a, ri, ro, f), ref(a, ri, ro, f),
      `mismatch for in=${a} rin=${ri} rout=${ro} fee=${f}`);
  }
});

test('floors toward zero (single division)', () => {
  // in=7, rin=13, rout=101, fee=0: 7*101 / (13*10000/10000 approx)... use ref.
  assert.equal(calculateOutputAmount(7n, 13n, 101n, 0), ref(7n, 13n, 101n, 0));
});

test('accepts string and BigInt inputs identically', () => {
  const a = calculateOutputAmount('1000', '1000000', '1000000', 30);
  const b = calculateOutputAmount(1000n, 1_000_000n, 1_000_000n, 30);
  assert.equal(a, b);
});
