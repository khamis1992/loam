import test from 'node:test';
import assert from 'node:assert/strict';
import { safariLabel } from '../safari/label.js';

test('a non-darwin safari label says source-only and tested false', () => {
  for (const platform of ['win32', 'linux', 'freebsd', 'android', 'cygwin']) {
    const label = safariLabel({ platform });
    assert.equal(label.label, 'source-only');
    assert.equal(label.safariTested, false);
    assert.equal(label.xcodeRan, false);
  }
  if (process.platform !== 'darwin') {
    const here = safariLabel();
    assert.equal(here.label, 'source-only');
    assert.equal(here.safariTested, false);
    assert.equal(here.xcodeRan, false);
  }
});

test('win32 rejects a caller that claims Xcode or Safari ran', () => {
  assert.throws(() => safariLabel({ platform: 'win32', xcodeRan: true }), /invalid_request/);
  assert.throws(() => safariLabel({ platform: 'win32', safariTested: true }), /invalid_request/);
  assert.throws(() => safariLabel({ platform: 'win32', xcodeRan: true, safariTested: true }), /invalid_request/);
  if (process.platform === 'win32') {
    assert.throws(() => safariLabel({ xcodeRan: true }), /invalid_request/);
    assert.throws(() => safariLabel({ safariTested: true }), /invalid_request/);
  }
  const honest = safariLabel({ platform: 'win32', xcodeRan: false, safariTested: false });
  assert.equal(honest.label, 'source-only');
  assert.equal(honest.safariTested, false);
  assert.equal(honest.xcodeRan, false);
});

test('a lying non-windows caller is not echoed, and darwin stays untested', () => {
  const linux = safariLabel({ platform: 'linux', xcodeRan: true, safariTested: true });
  assert.equal(linux.label, 'source-only');
  assert.equal(linux.safariTested, false);
  assert.equal(linux.xcodeRan, false);
  const darwin = safariLabel({ platform: 'darwin', xcodeRan: true, safariTested: true });
  assert.equal(darwin.safariTested, false);
  assert.equal(darwin.xcodeRan, false);
  assert.equal(darwin.label, 'source-only');
});
