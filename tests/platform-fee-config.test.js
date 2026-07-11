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
// TASK-56 extends the fail-fast policy with a hard ceiling: 10000 bps = 100% of
// the multi-pool gain is the maximum sensible fee, so feeBps == 10000 is allowed
// but any value > 10000 throws at config read (previously only console.warn'd).
//
// getPlatformFeeConfig reads process.env directly, so each case swaps the env
// var and restores it afterward. It is exported REAL for unit testing.
import test from 'node:test';
import assert from 'node:assert/strict';
import algosdk from 'algosdk';
import { getPlatformFeeConfig } from '../lib/quotes.js';

// A real, checksum-valid AVM/Algorand address, derived (not hardcoded) so it can
// never drift into a checksum-invalid literal. Used wherever a test needs a
// valid PLATFORM_FEE_ADDR.
const VALID_FEE_ADDR = algosdk.generateAccount().addr.toString();

// Run `fn` with PLATFORM_FEE_BPS set to `value` (or unset when `value === undefined`),
// restoring the prior env afterward. A valid PLATFORM_FEE_ADDR is set for the
// duration so these BPS-parsing cases exercise ONLY the bps logic — nonzero-fee
// values would otherwise trip the new addr requirement. Address-validation is
// covered separately by withFeeConfig below.
function withFeeBps(value, fn) {
  const prev = process.env.PLATFORM_FEE_BPS;
  const prevAddr = process.env.PLATFORM_FEE_ADDR;
  if (value === undefined) delete process.env.PLATFORM_FEE_BPS;
  else process.env.PLATFORM_FEE_BPS = value;
  process.env.PLATFORM_FEE_ADDR = VALID_FEE_ADDR;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PLATFORM_FEE_BPS;
    else process.env.PLATFORM_FEE_BPS = prev;
    if (prevAddr === undefined) delete process.env.PLATFORM_FEE_ADDR;
    else process.env.PLATFORM_FEE_ADDR = prevAddr;
  }
}

// Run `fn` with BOTH PLATFORM_FEE_BPS and PLATFORM_FEE_ADDR set (or unset when
// the value is `undefined`), restoring both afterward. Used by the fee-address
// validation cases so each fully controls the addr state.
function withFeeConfig(bps, addr, fn) {
  const prevBps = process.env.PLATFORM_FEE_BPS;
  const prevAddr = process.env.PLATFORM_FEE_ADDR;
  if (bps === undefined) delete process.env.PLATFORM_FEE_BPS;
  else process.env.PLATFORM_FEE_BPS = bps;
  if (addr === undefined) delete process.env.PLATFORM_FEE_ADDR;
  else process.env.PLATFORM_FEE_ADDR = addr;
  try {
    return fn();
  } finally {
    if (prevBps === undefined) delete process.env.PLATFORM_FEE_BPS;
    else process.env.PLATFORM_FEE_BPS = prevBps;
    if (prevAddr === undefined) delete process.env.PLATFORM_FEE_ADDR;
    else process.env.PLATFORM_FEE_ADDR = prevAddr;
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

test('feeBps == 10000 is allowed (100%-of-gain ceiling, no throw)', () => {
  withFeeBps('10000', () => {
    assert.doesNotThrow(() => getPlatformFeeConfig());
    assert.equal(getPlatformFeeConfig().feeBps, 10000);
  });
});

test('feeBps == 10001 throws a clear error naming the var, value, and 10000 max', () => {
  withFeeBps('10001', () => {
    assert.throws(() => getPlatformFeeConfig(), (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /PLATFORM_FEE_BPS/);
      assert.match(err.message, /10001/);
      assert.match(err.message, /10000/);
      return true;
    });
  });
});

// TASK-58: a NONZERO platform fee requires a valid PLATFORM_FEE_ADDR — the fee
// output has no recipient (routed to nowhere / lost) or produces a broken
// transaction without one. Fail LOUDLY at config-read time (fail-fast, no
// silent default), which via the eager getPlatformFeeConfig() call in index.js
// also fails the server boot / serverless cold start. The zero-fee path is
// deliberately untouched: no fee is charged, so the addr is not required.

test('nonzero fee + valid PLATFORM_FEE_ADDR: no throw, address returned verbatim', () => {
  withFeeConfig('10', VALID_FEE_ADDR, () => {
    assert.doesNotThrow(() => getPlatformFeeConfig());
    const cfg = getPlatformFeeConfig();
    assert.equal(cfg.feeBps, 10);
    assert.equal(cfg.feeAddress, VALID_FEE_ADDR);
  });
});

test('nonzero fee + missing PLATFORM_FEE_ADDR throws, naming the var', () => {
  withFeeConfig('10', undefined, () => {
    assert.throws(() => getPlatformFeeConfig(), (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /PLATFORM_FEE_ADDR/);
      return true;
    });
  });
});

test('nonzero fee + empty PLATFORM_FEE_ADDR throws (treated as missing)', () => {
  withFeeConfig('10', '', () => {
    assert.throws(() => getPlatformFeeConfig(), /PLATFORM_FEE_ADDR/);
  });
});

test('nonzero fee + malformed PLATFORM_FEE_ADDR (bad checksum) throws via isValidAddress', () => {
  // A right-length AVM address string with a flipped final char -> checksum
  // fails, so algosdk.isValidAddress rejects it (a plain non-empty check would
  // let it through and route the fee to a broken/unowned address).
  const badChecksum = VALID_FEE_ADDR.slice(0, -1) + (VALID_FEE_ADDR.slice(-1) === 'A' ? 'B' : 'A');
  withFeeConfig('10', badChecksum, () => {
    assert.throws(() => getPlatformFeeConfig(), (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /PLATFORM_FEE_ADDR/);
      return true;
    });
  });
});

test('nonzero fee + malformed PLATFORM_FEE_ADDR (junk/wrong length) throws', () => {
  withFeeConfig('10', 'FEEADDR', () => {
    assert.throws(() => getPlatformFeeConfig(), /PLATFORM_FEE_ADDR/);
  });
});

test('zero fee (feeBps=0) does NOT require an address: no throw even when unset', () => {
  withFeeConfig('0', undefined, () => {
    assert.doesNotThrow(() => getPlatformFeeConfig());
    assert.equal(getPlatformFeeConfig().feeBps, 0);
    assert.equal(getPlatformFeeConfig().feeAddress, null);
  });
});

test('unset fee does NOT require an address: no throw, feeAddress null', () => {
  withFeeConfig(undefined, undefined, () => {
    assert.doesNotThrow(() => getPlatformFeeConfig());
    assert.equal(getPlatformFeeConfig().feeBps, 0);
    assert.equal(getPlatformFeeConfig().feeAddress, null);
  });
});

test('zero fee + malformed address is still fine (no fee charged, addr ignored)', () => {
  withFeeConfig('0', 'FEEADDR', () => {
    assert.doesNotThrow(() => getPlatformFeeConfig());
    assert.equal(getPlatformFeeConfig().feeAddress, 'FEEADDR');
  });
});

test('unset fee + malformed address is still fine (no fee charged, addr ignored)', () => {
  withFeeConfig(undefined, 'FEEADDR', () => {
    assert.doesNotThrow(() => getPlatformFeeConfig());
    assert.equal(getPlatformFeeConfig().feeBps, 0);
    assert.equal(getPlatformFeeConfig().feeAddress, 'FEEADDR');
  });
});
