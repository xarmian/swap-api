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
import { enforcedMinAmountOut } from '../lib/transactions.js';

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

test('reported == enforced: the production enforcement boundary passes minOutput through with NO buffer (TASK-6)', () => {
  // enforcedMinAmountOut (lib/transactions.js) is the SINGLE source of every
  // swap's on-chain minAmountOut (both DEX call sites route through it). The
  // response reports the SAME split.minOutput (Σ in lib/handlers.js), so the
  // user-facing floor must equal the enforced floor. The TASK-6 bug applied a
  // 0.99 haircut here, dropping the enforced minimum ~1% below what was reported.
  // This observes the REAL production helper, so reintroducing that haircut in
  // transactions.js would fail this test (it is not a local re-derivation).
  const cases = [1_000_000n, 999n, 250_000n, 3n, 0n, 123_456_789n];
  for (const minOutput of cases) {
    const reported = minOutput.toString();               // what handlers.js reports
    const enforced = enforcedMinAmountOut(minOutput);    // what transactions.js enforces
    assert.equal(enforced, reported, `enforced must equal reported for ${minOutput}`);
    // A reintroduced 0.99 buffer would produce a strictly smaller value.
    const buffered = ((minOutput * 99n) / 100n).toString();
    if (minOutput >= 100n) {
      assert.notEqual(enforced, buffered, 'enforced minimum must not be quietly buffered down ~1%');
    }
  }
});

test('reported == enforced: aggregate reported total equals the enforced minAmountOut sum (multi-pool split)', () => {
  // Per split, minOutput = applySlippageToOutput(expectedOutput, slippage).
  // handlers.js reports Σ BigInt(split.minOutput); transactions.js enforces
  // enforcedMinAmountOut(split.minOutput) per swap. With the real boundary, the
  // two aggregates must coincide exactly (no per-split haircut).
  const slippage = 0.005;
  const expectedOutputs = [1_000_000n, 250_000n, 3n]; // multi-pool split incl. a tiny leg
  const minOutputs = expectedOutputs.map((o) => applySlippageToOutput(o, slippage));

  const reportedTotal = minOutputs.reduce((s, m) => s + BigInt(m), 0n);
  const enforcedTotal = minOutputs.reduce((s, m) => s + BigInt(enforcedMinAmountOut(m)), 0n);
  assert.equal(enforcedTotal, reportedTotal);
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
