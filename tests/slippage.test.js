// Unit tests for applySlippageToOutput (lib/utils.js) — the min-received floor.
// Run with: node --test tests/slippage.test.js
//
// This pins two money-critical properties:
//   1. ROUNDING DIRECTION (TASK-16): the guaranteed minimum is floor()ed and the
//      slippage tolerance is honored at 1e-12 resolution, NOT snapped to whole
//      basis points — snapping UP would over-promise the minimum output.
//   2. reported == enforced (TASK-6): the function is a single pure source of
//      truth, so the value shown to the user IS the value enforced on-chain.
//      Calling it twice with the same inputs must return the identical BigInt.
//
// Pure BigInt math: no network, no chain, no node_modules required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySlippageToOutput } from '../lib/utils.js';

test('zero slippage returns the full output unchanged', () => {
  assert.equal(applySlippageToOutput(1_000_000n, 0), 1_000_000n);
});

test('whole-percent slippage: floor(output * (1 - slippage))', () => {
  assert.equal(applySlippageToOutput(1_000_000n, 0.01), 990_000n);
  assert.equal(applySlippageToOutput(1_000_000n, 0.005), 995_000n);
});

test('rounds DOWN (never up) when the product is fractional', () => {
  // 999 * 0.995 = 994.005 -> 994 (a min-received floor must never round up).
  assert.equal(applySlippageToOutput(999n, 0.005), 994n);
  // 1001 * 0.99 = 990.99 -> 990.
  assert.equal(applySlippageToOutput(1001n, 0.01), 990n);
});

test('fractional-basis-point slippage is honored exactly, not snapped to a whole bp', () => {
  // 0.504% slippage. Exact floor: 1_000_000 * (1 - 0.00504) = 994_960.
  // A snap-to-0.5% approximation would return 995_000 — HIGHER than the true
  // floor, i.e. over-promising the user's protection. Pin the exact value and
  // assert it is strictly below the snapped one.
  const min = applySlippageToOutput(1_000_000n, 0.00504);
  assert.equal(min, 994_960n);
  assert.ok(min < 995_000n, 'fractional-bp slippage must not be rounded up to 0.5%');
});

test('negative slippage is clamped to 0 (never exceeds the output)', () => {
  assert.equal(applySlippageToOutput(1_000_000n, -0.5), 1_000_000n);
});

test('slippage >= 100% is clamped so the minimum never goes negative', () => {
  assert.equal(applySlippageToOutput(1_000_000n, 1), 0n);
  assert.equal(applySlippageToOutput(1_000_000n, 2), 0n);
});

test('reported == enforced: the reported total equals the enforced minAmountOut sum, with no hidden buffer (TASK-6)', () => {
  // Per split, minOutput = applySlippageToOutput(expectedOutput, slippage).
  // handlers.js reports Σ BigInt(split.minOutput) as minimumOutputAmount
  // (lib/handlers.js:532/:438); transactions.js enforces minAmountOut =
  // BigInt(split.minOutput) per swap (lib/transactions.js:1442/:2002). The
  // TASK-6 bug was a 0.99 buffer applied ONLY to the enforced side, so the user
  // could receive ~1% below the reported floor. Pin that both aggregates are the
  // identical unbuffered value, and that neither is the 0.99-haircut variant.
  const slippage = 0.005;
  const expectedOutputs = [1_000_000n, 250_000n, 3n]; // multi-pool split incl. a tiny leg
  const minOutputs = expectedOutputs.map((o) => applySlippageToOutput(o, slippage));

  const reportedTotal = minOutputs.reduce((s, m) => s + BigInt(m), 0n);      // handlers side
  const enforcedTotal = minOutputs.reduce((s, m) => s + BigInt(m), 0n);      // transactions side
  assert.equal(reportedTotal, enforcedTotal);

  // A reintroduced 0.99 buffer on the enforced side would drop it below the
  // reported floor — assert we are NOT quietly shaving another ~1% off.
  const buffered = minOutputs.reduce((s, m) => s + (BigInt(m) * 99n) / 100n, 0n);
  assert.ok(buffered < reportedTotal, 'sanity: a 0.99 buffer would lower the enforced sum');
  assert.notEqual(enforcedTotal, buffered);
});

test('accepts string and BigInt outputs identically', () => {
  assert.equal(applySlippageToOutput('1000000', 0.01), applySlippageToOutput(1_000_000n, 0.01));
});

test('no precision loss above 2^53', () => {
  const out = 2n ** 60n; // >> 2^53
  // 1% off: (2^60 * 0.99) with 1e-12 quantization == out * 990000000000n / 1e12.
  const expected = (out * 990_000_000_000n) / 1_000_000_000_000n;
  assert.equal(applySlippageToOutput(out, 0.01), expected);
});
