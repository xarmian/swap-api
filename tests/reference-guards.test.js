import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

test('reference arrays use type-safe guards', () => {
  const lib = new URL('../lib/', import.meta.url);
  const offenders = [];
  for (const file of readdirSync(lib).filter(name => name.endsWith('.js'))) {
    readFileSync(new URL(file, lib), 'utf8').split('\n').forEach((line, index) => {
      if (/\b(foreignApps|foreignAssets|swapForeignApps|depositForeignAssets)\.includes\(/.test(line) && !line.includes('// ref-includes-ok')) {
        offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `Unsafe reference guards:\n${offenders.join('\n')}`);
});
