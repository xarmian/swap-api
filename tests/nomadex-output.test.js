// Unit tests for Nomadex calculateOutputAmount.
// Run with: node --test tests/nomadex-output.test.js
//
// These pin the JS quote against the pool's on-chain swap subroutine
// (`label109` in the pool approval program, verified by disassembling app
// 411756):
//
//   out = amountIn * reserveOut * (SCALE - totalFee) / ((amountIn + reserveIn) * SCALE)
//
// with SCALE = NOMADEX_FEE_SCALE = 1e14 and totalFee = swap_fee + platform_fee
// (uint256 fractions of SCALE), computed as a SINGLE trailing floor division.
// The fee is applied ONLY to the numerator; the denominator uses the RAW
// (amountIn + reserveIn). calculateOutputAmount takes the fee in these exact
// SCALE units (feeScale), so it reproduces the contract output bit-for-bit,
// including sub-basis-point fees.
//
// No network access and no node_modules required (pure BigInt math).
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOutputAmount, NOMADEX_FEE_SCALE } from '../lib/nomadex.js';

const SCALE = NOMADEX_FEE_SCALE; // 1e14, matches the on-chain 0x5af3107a4000

// Independent reference of the exact on-chain arithmetic in SCALE units.
function onChainOut(amountIn, reserveIn, reserveOut, feeScale) {
  const inn = BigInt(amountIn);
  const rin = BigInt(reserveIn);
  const rout = BigInt(reserveOut);
  const numerator = inn * rout * (SCALE - BigInt(feeScale));
  const denominator = (inn + rin) * SCALE;
  return numerator / denominator; // single floor division, matches TEAL `b/`
}

// Convert whole basis points to the exact SCALE fraction (bps is a multiple of
// SCALE/10000 = 1e10, so this is lossless). Mirrors the operator-override path.
function bpsToScale(bps) {
  return BigInt(bps) * (SCALE / 10000n);
}

test('finding fixture: in=resIn=resOut=1000, fee=200bps => 490 (not the old 494)', () => {
  const out = calculateOutputAmount(1000, 1000, 1000, bpsToScale(200));
  assert.equal(out, 490n);
  assert.notEqual(out, 494n); // old Uniswap-style fee-adjusted denominator gave 494
});

test('sub-basis-point fee matches the contract exactly (no bp-rounding loss)', () => {
  // totalFee = 2,003,000,000,000 == 200.3 bps. in=resIn=resOut=1e9.
  // Chain output is 489,985,000; a ceil-to-201-bps approximation would wrongly
  // give 489,950,000. The exact SCALE fee reproduces the contract value.
  const feeScale = 2003000000000n;
  const out = calculateOutputAmount(1_000_000_000n, 1_000_000_000n, 1_000_000_000n, feeScale);
  assert.equal(out, 489985000n);
  assert.equal(out, onChainOut(1_000_000_000n, 1_000_000_000n, 1_000_000_000n, feeScale));
  assert.notEqual(out, 489950000n); // the lossy ceil-to-bps result we must NOT return
});

test('matches the on-chain SCALE-based formula exactly (symmetric reserves)', () => {
  const cases = [
    [1000n, 1000n, 1000n, bpsToScale(200)],
    [1n, 1000n, 1000n, bpsToScale(200)],
    [999999n, 1000n, 1000n, bpsToScale(200)],
    [123456n, 1000n, 1000n, bpsToScale(100)],
    [1000n, 1000n, 1000n, 0n],                 // zero-fee edge
    [1000n, 1000n, 1000n, SCALE - 1n],         // fee just under 100%
    [1000n, 1000n, 1000n, 1n],                 // 1e-14 fee: exercises sub-bp path
  ];
  for (const [amountIn, rin, rout, feeScale] of cases) {
    const js = calculateOutputAmount(amountIn, rin, rout, feeScale);
    assert.equal(js, onChainOut(amountIn, rin, rout, feeScale),
      `mismatch for in=${amountIn} feeScale=${feeScale}`);
  }
});

test('matches on-chain formula for asymmetric reserves and large values', () => {
  const cases = [
    [1_000_000n, 5_000_000n, 250_000_000n, bpsToScale(30)],
    [7n, 5_000_000n, 250_000_000n, bpsToScale(30)],
    [999_999_999n, 12_345_678n, 87_654_321n, bpsToScale(250)],
    [1_000_000_000_000_000_000n, 3_000_000_000_000n, 9_000_000_000_000n, bpsToScale(200)],
  ];
  for (const [amountIn, rin, rout, feeScale] of cases) {
    const js = calculateOutputAmount(amountIn, rin, rout, feeScale);
    assert.equal(js, onChainOut(amountIn, rin, rout, feeScale),
      `mismatch for in=${amountIn} rin=${rin} rout=${rout} feeScale=${feeScale}`);
  }
});

test('fee is applied to the numerator only, not the denominator (regression on the bug)', () => {
  // The OLD fee-adjusted-input denominator produced:
  //   1000*9800*1000 / (1000*10000 + 1000*9800) = 9.8e9 / 1.98e7 = 494.
  const feeAdjustedInput = 1000n * (10000n - 200n);
  const oldStyle = (feeAdjustedInput * 1000n) / (1000n * 10000n + feeAdjustedInput);
  assert.equal(oldStyle, 494n); // sanity: what the removed formula produced
  assert.equal(calculateOutputAmount(1000, 1000, 1000, bpsToScale(200)), 490n);
});

test('output truncates toward zero with a single division (matches TEAL b/)', () => {
  const amountIn = 7n, rin = 13n, rout = 101n, feeScale = 0n;
  const exactNumer = amountIn * rout * (SCALE - feeScale);
  const exactDenom = (amountIn + rin) * SCALE;
  assert.equal(calculateOutputAmount(amountIn, rin, rout, feeScale), exactNumer / exactDenom);
  // 7*101 = 707; (7+13)=20; 707/20 = 35.35 -> 35 (fee 0 cancels SCALE).
  assert.equal(calculateOutputAmount(amountIn, rin, rout, feeScale), 35n);
});

test('non-positive input or reserves return 0 (no div-by-zero, no bogus output)', () => {
  assert.equal(calculateOutputAmount(0n, 1000n, 1000n, bpsToScale(200)), 0n);
  assert.equal(calculateOutputAmount(-1000n, 1000n, 1000n, bpsToScale(200)), 0n); // would zero the denominator
  assert.equal(calculateOutputAmount(-5n, 1000n, 1000n, bpsToScale(200)), 0n);    // would otherwise be bogus
  assert.equal(calculateOutputAmount(1000n, 0n, 1000n, bpsToScale(200)), 0n);
  assert.equal(calculateOutputAmount(1000n, 1000n, 0n, bpsToScale(200)), 0n);
});

test('accepts string and BigInt inputs identically', () => {
  const a = calculateOutputAmount('1000', '1000', '1000', '20000000000'); // 2e10 == 20 bps
  const b = calculateOutputAmount(1000n, 1000n, 1000n, 20000000000n);
  assert.equal(a, b);
  assert.equal(a, onChainOut(1000n, 1000n, 1000n, 20000000000n));
});
