// Unit tests for the pure math helpers in lib/utils.js.
// Run with: node --test tests/utils-math.test.js
//
// These import the REAL functions from lib/utils.js (no hand-copied logic — the
// former tests/test-price-impact.js copy of calculatePriceImpact is deleted, so
// this suite actually catches regressions in the shipped code).
//
// Pure BigInt / arithmetic: no network, no chain, no node_modules required.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRate,
  bigIntSqrt,
  calculatePriceImpact
} from '../lib/utils.js';

// --- calculateRate ---------------------------------------------------------

test('calculateRate: equal decimals gives the raw output/input ratio', () => {
  // 2000 out for 1000 in, both 6 decimals => 2.0 per input token.
  assert.equal(calculateRate(2000n, 1000n, 6, 6), 2);
});

test('calculateRate: normalizes for differing token decimals', () => {
  // 1 unit of a 6-dec token (1e6 base) for 1 unit of a 2-dec token (1e2 base):
  // human rate is (1e6/1e6) / (1e2/1e2) = 1.0 despite the raw ratio being 1e4.
  assert.equal(calculateRate(1_000_000n, 100n, 2, 6), 1);
});

test('calculateRate: preserves sub-integer ratios (no floor-to-zero)', () => {
  // A naive BigInt division (output/input) would floor 1/2 to 0; the 1e18-scaled
  // path must report 0.5.
  assert.equal(calculateRate(500n, 1000n, 6, 6), 0.5);
});

test('calculateRate: zero input returns 0 (no div-by-zero)', () => {
  assert.equal(calculateRate(1000n, 0n, 6, 6), 0);
});

test('calculateRate: does not lose precision above 2^53 (never Number()s raw amounts)', () => {
  // Reserves/amounts well beyond 2^53; equal decimals so the answer is exactly 2.
  const out = 2n * (2n ** 60n);
  const inn = 2n ** 60n;
  assert.equal(calculateRate(out, inn, 6, 6), 2);
});

// --- bigIntSqrt ------------------------------------------------------------

test('bigIntSqrt: exact squares', () => {
  assert.equal(bigIntSqrt(0n), 0n);
  assert.equal(bigIntSqrt(1n), 1n);
  assert.equal(bigIntSqrt(4n), 2n);
  assert.equal(bigIntSqrt(16n), 4n);
  assert.equal(bigIntSqrt(10000n), 100n);
});

test('bigIntSqrt: floors non-perfect squares (rounds DOWN)', () => {
  assert.equal(bigIntSqrt(2n), 1n);
  assert.equal(bigIntSqrt(3n), 1n);
  assert.equal(bigIntSqrt(15n), 3n);
  assert.equal(bigIntSqrt(24n), 4n);
});

test('bigIntSqrt: correct for values far beyond 2^53 (Number(sqrt) would be wrong)', () => {
  const root = 12345678901234567n;
  const n = root * root;
  assert.equal(bigIntSqrt(n), root);
  assert.equal(bigIntSqrt(n + 1n), root);          // floor holds just above
  assert.equal(bigIntSqrt(n - 1n), root - 1n);     // and just below
});

test('bigIntSqrt: negative input throws', () => {
  assert.throws(() => bigIntSqrt(-1n), /negative/);
});

// --- calculatePriceImpact --------------------------------------------------

test('calculatePriceImpact: matches the documented spot-price formula', () => {
  // in=1000, inRes=1e6, out=997, outRes=1e6.
  // before = 1.0; after = 999003/1001000 = 0.998004995...; impact = 0.001995005.
  const impact = calculatePriceImpact(1000n, 1_000_000n, 997n, 1_000_000n);
  assert.ok(Math.abs(impact - 0.001995004995) < 1e-9,
    `expected ~0.001995005, got ${impact}`);
});

test('calculatePriceImpact: larger trades move the price more (monotonic)', () => {
  const small = calculatePriceImpact(1000n, 1_000_000n, 997n, 1_000_000n);
  const large = calculatePriceImpact(100_000n, 1_000_000n, 90_000n, 1_000_000n);
  assert.ok(large > small, `expected larger trade to have more impact (${large} > ${small})`);
});

test('calculatePriceImpact: non-positive inputs return 0 (no div-by-zero, no NaN)', () => {
  assert.equal(calculatePriceImpact(0n, 1_000_000n, 997n, 1_000_000n), 0);
  assert.equal(calculatePriceImpact(1000n, 0n, 997n, 1_000_000n), 0);
  assert.equal(calculatePriceImpact(1000n, 1_000_000n, 0n, 1_000_000n), 0);
  assert.equal(calculatePriceImpact(1000n, 1_000_000n, 997n, 0n), 0);
});

test('calculatePriceImpact: output draining the whole reserve returns 0 (invalid post-trade state)', () => {
  assert.equal(calculatePriceImpact(1000n, 1_000_000n, 1_000_000n, 1_000_000n), 0);
});
