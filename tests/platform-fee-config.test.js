// TASK-55: getPlatformFeeConfig validates PLATFORM_FEE_BPS and FAILS FAST on a
// SET-but-invalid value, instead of letting a fractional/non-finite/negative
// value flow into a later BigInt(feeBps) and throw an opaque RangeError.
//
// The no-silent-defaults rule means a misconfigured fee must be LOUD: we never
// clamp/default a bad value to 0. Distinction pinned here:
//   - UNSET / empty PLATFORM_FEE_BPS  -> valid "no fee" config (feeBps = 0), no throw.
//   - SET valid non-negative integer  -> parses exactly as before.
//   - SET but non-integer / non-finite / negative -> clear Error naming the var + value.
//
// getPlatformFeeConfig reads process.env directly, so each case swaps the env
// var and restores it afterward. It is exported REAL for unit testing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getPlatformFeeConfig } from '../lib/quotes.js';

// Run `fn` with PLATFORM_FEE_BPS set to `value` (or unset when `value === undefined`),
// restoring the prior env afterward.
function withFeeBps(value, fn) {
  const prev = process.env.PLATFORM_FEE_BPS;
  if (value === undefined) delete process.env.PLATFORM_FEE_BPS;
  else process.env.PLATFORM_FEE_BPS = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PLATFORM_FEE_BPS;
    else process.env.PLATFORM_FEE_BPS = prev;
  }
}

test('valid non-negative integer bps parses exactly as before', () => {
  withFeeBps('30', () => {
    assert.equal(getPlatformFeeConfig().feeBps, 30);
  });
  withFeeBps('0', () => {
    assert.equal(getPlatformFeeConfig().feeBps, 0);
  });
});

test('unset PLATFORM_FEE_BPS is a valid no-fee config (feeBps = 0, no throw)', () => {
  withFeeBps(undefined, () => {
    assert.doesNotThrow(() => getPlatformFeeConfig());
    assert.equal(getPlatformFeeConfig().feeBps, 0);
  });
});

test('empty PLATFORM_FEE_BPS is a valid no-fee config (feeBps = 0, no throw)', () => {
  withFeeBps('', () => {
    assert.doesNotThrow(() => getPlatformFeeConfig());
    assert.equal(getPlatformFeeConfig().feeBps, 0);
  });
});

test('whitespace-only PLATFORM_FEE_BPS is treated as no-fee (feeBps = 0, no throw), as before', () => {
  withFeeBps('   ', () => {
    assert.doesNotThrow(() => getPlatformFeeConfig());
    assert.equal(getPlatformFeeConfig().feeBps, 0);
  });
});

test('surrounding whitespace around a valid integer is tolerated', () => {
  withFeeBps('  30  ', () => {
    assert.equal(getPlatformFeeConfig().feeBps, 30);
  });
});

test('fractional PLATFORM_FEE_BPS throws a clear error naming the var and value', () => {
  withFeeBps('30.5', () => {
    assert.throws(() => getPlatformFeeConfig(), (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /PLATFORM_FEE_BPS/);
      assert.match(err.message, /30\.5/);
      return true;
    });
  });
});

test('non-numeric PLATFORM_FEE_BPS throws a clear error naming the var and value', () => {
  withFeeBps('abc', () => {
    assert.throws(() => getPlatformFeeConfig(), (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /PLATFORM_FEE_BPS/);
      assert.match(err.message, /abc/);
      return true;
    });
  });
});

test('coercion-underflow values that Number() rounds to 0 still throw (no silent default)', () => {
  // Number("1e-324") === 0 and Number("-1e-324") === 0, so a plain
  // Number.isInteger/negativity check would silently swallow these as feeBps=0.
  // Validating the raw STRING as an integer literal rejects them loudly.
  for (const bad of ['1e-324', '-1e-324', '9007199254740992.5', '1e2', '0x10']) {
    withFeeBps(bad, () => {
      assert.throws(() => getPlatformFeeConfig(), (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /PLATFORM_FEE_BPS/);
        return true;
      }, `expected "${bad}" to throw`);
    });
  }
});

test('digit strings past Number.MAX_SAFE_INTEGER throw (no silent precision loss)', () => {
  // Number("9007199254740993") === 9007199254740992 (precision lost); a plain
  // Number.isInteger check would accept the corrupted value. isSafeInteger rejects it.
  for (const bad of ['9007199254740993', '99999999999999999999']) {
    withFeeBps(bad, () => {
      assert.throws(() => getPlatformFeeConfig(), (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /PLATFORM_FEE_BPS/);
        return true;
      }, `expected "${bad}" to throw`);
    });
  }
});

test('negative PLATFORM_FEE_BPS throws a clear error', () => {
  withFeeBps('-1', () => {
    assert.throws(() => getPlatformFeeConfig(), /PLATFORM_FEE_BPS/);
  });
});

test('non-finite PLATFORM_FEE_BPS (Infinity) throws before reaching BigInt()', () => {
  withFeeBps('Infinity', () => {
    assert.throws(() => getPlatformFeeConfig(), /PLATFORM_FEE_BPS/);
  });
});

test('feeAddress handling is unchanged (null when unset, passthrough when set)', () => {
  const prevAddr = process.env.PLATFORM_FEE_ADDR;
  try {
    delete process.env.PLATFORM_FEE_ADDR;
    withFeeBps('10', () => {
      assert.equal(getPlatformFeeConfig().feeAddress, null);
    });
    process.env.PLATFORM_FEE_ADDR = 'FEEADDR';
    withFeeBps('10', () => {
      assert.equal(getPlatformFeeConfig().feeAddress, 'FEEADDR');
    });
  } finally {
    if (prevAddr === undefined) delete process.env.PLATFORM_FEE_ADDR;
    else process.env.PLATFORM_FEE_ADDR = prevAddr;
  }
});
