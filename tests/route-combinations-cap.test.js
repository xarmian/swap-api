// TASK-26: MAX_ROUTE_COMBINATIONS caps the per-request route-combination
// fan-out (findOptimalMultiHopRoute -> generateRouteCombinations), which is
// the primary lever against a single /quote evaluating up to 100 candidate
// pool combinations (each re-fetching live pool state). This pins:
//   - the default (no env var set) resolves to 10, not the old 100.
//   - MAX_ROUTE_COMBINATIONS is honored when set to a valid positive integer.
//   - a garbage/non-positive/non-integer env value falls back to 10 rather
//     than silently disabling the cap (0), making it unbounded (NaN/Infinity
//     comparisons), or throwing.
//
// lib/config.js computes MAX_ROUTE_COMBINATIONS ONCE at module-load time (an
// IIFE reading process.env), so each case sets the env var BEFORE a fresh
// dynamic import using a cache-busting query string — a bare re-import of
// '../lib/config.js' would otherwise resolve to an already-cached module
// instance from an earlier test/env value.
import test from 'node:test';
import assert from 'node:assert/strict';

async function withEnv(value, fn) {
  const prev = process.env.MAX_ROUTE_COMBINATIONS;
  if (value === undefined) delete process.env.MAX_ROUTE_COMBINATIONS;
  else process.env.MAX_ROUTE_COMBINATIONS = value;
  try {
    // MUST be awaited here (not just returned) — fn() is async (it performs
    // a dynamic import whose module body runs later, in a microtask), so
    // without awaiting, `finally` below would restore/delete the env var
    // BEFORE the imported module's top-level IIFE ever reads it.
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.MAX_ROUTE_COMBINATIONS;
    else process.env.MAX_ROUTE_COMBINATIONS = prev;
  }
}

let importCounter = 0;
async function importFreshConfig() {
  importCounter += 1;
  return import(`../lib/config.js?maxCombosTest=${importCounter}`);
}

test('MAX_ROUTE_COMBINATIONS defaults to 10 when unset', async () => {
  const { MAX_ROUTE_COMBINATIONS } = await withEnv(undefined, () => importFreshConfig());
  assert.equal(MAX_ROUTE_COMBINATIONS, 10);
});

test('MAX_ROUTE_COMBINATIONS honors a valid env override', async () => {
  const { MAX_ROUTE_COMBINATIONS } = await withEnv('25', () => importFreshConfig());
  assert.equal(MAX_ROUTE_COMBINATIONS, 25);
});

test('MAX_ROUTE_COMBINATIONS falls back to 10 on garbage/non-positive/non-integer values (never disables or unbounds the cap)', async () => {
  for (const bad of ['abc', '0', '-5', '3.5', 'NaN', '', 'Infinity']) {
    const { MAX_ROUTE_COMBINATIONS } = await withEnv(bad, () => importFreshConfig());
    assert.equal(MAX_ROUTE_COMBINATIONS, 10, `expected fallback of 10 for MAX_ROUTE_COMBINATIONS=${JSON.stringify(bad)}`);
  }
});

test('generateRouteCombinations defaults its own maxCombinations param to MAX_ROUTE_COMBINATIONS (10), not the old 100', async () => {
  const { generateRouteCombinations, MAX_ROUTE_COMBINATIONS } = await withEnv(undefined, () => importFreshConfig());
  assert.equal(MAX_ROUTE_COMBINATIONS, 10);

  // 2 hops x 20 pool options each = 400 raw combinations, well above either
  // cap, so generateRouteCombinations' own per-hop-limiting kicks in for
  // both calls below — this isolates the DEFAULT param value (10 vs the old
  // 100), not whether limiting happens at all.
  const poolOptions = [0, 1].map((hop) =>
    Array.from({ length: 20 }, (_, i) => ({ poolId: hop * 100 + i, dex: 'humbleswap' }))
  );
  const route = { poolOptions, intermediateTokens: [101], hops: 2 };

  // maxPoolsPerHop = ceil(sqrt(10)) = 4 -> 4*4 = 16 combinations generated.
  const combosDefault = generateRouteCombinations(route);
  assert.equal(combosDefault.length, 16, 'default (env-derived MAX_ROUTE_COMBINATIONS=10) limits to 4 pools/hop = 16 combinations');

  // maxPoolsPerHop = ceil(sqrt(100)) = 10 -> 10*10 = 100 combinations generated.
  const combosExplicit100 = generateRouteCombinations(route, 100);
  assert.equal(combosExplicit100.length, 100, 'an explicit maxCombinations=100 still behaves as before (proves the DEFAULT, not the function itself, was lowered)');
});
