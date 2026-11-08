import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decideAutostart, type WidgetReleaseMode } from '../widget/autostartPolicy.js';

const modes: readonly WidgetReleaseMode[] = ['portable', 'development', 'installed'];

test('decideAutostart stays disabled for portable, development, and installed when requested and granted', () => {
  for (const mode of modes) {
    const decision = decideAutostart({
      requested: true,
      userGranted: true,
      portable: mode === 'portable',
      mode,
    });
    assert.equal(decision.enabled, false);
    assert.equal(decision.reason, 'startup is unavailable');
  }
});

test('decideAutostart does not flip the default when startup was not requested', () => {
  assert.deepEqual(decideAutostart({ requested: false, userGranted: false, portable: false }), {
    enabled: false,
    reason: 'default',
  });
  for (const mode of ['development', 'installed'] as const) {
    assert.deepEqual(decideAutostart({ requested: false, userGranted: false, portable: false, mode }), {
      enabled: false,
      reason: 'default',
    });
  }
  assert.equal(decideAutostart({ requested: false, userGranted: false, portable: true, mode: 'portable' }).enabled, false);
});

test('autostart policy does not call setLoginItemSettings or write a Windows run key', () => {
  const source = fs.readFileSync(new URL('../widget/autostartPolicy.ts', import.meta.url), 'utf8');
  const forbidden = [
    'setLoginItemSettings',
    'openAtLogin',
    'HKCU',
    'HKLM',
    'CurrentVersion\\Run',
    'reg add',
    'shell:startup',
  ];
  for (const phrase of forbidden) {
    assert.equal(source.includes(phrase), false, phrase);
  }
});
