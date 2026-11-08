import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decideAutostart, widgetReleaseMatrix, type WidgetReleaseMode } from '../widget/autostartPolicy.js';

const modes: readonly WidgetReleaseMode[] = ['portable', 'development', 'installed'];

test('electron template does not register a login item or write startup and stays opaque', () => {
  const source = fs.readFileSync(new URL('../../templates/electron-app/electron/main.cjs', import.meta.url), 'utf8');
  assert.equal(source.includes('setLoginItemSettings'), false);
  const startupOrRunWrite = [
    'shell:startup',
    'Start Menu\\Programs\\Startup',
    'Microsoft\\Windows\\Start Menu\\Programs\\Startup',
    'CurrentVersion\\Run',
    'HKCU\\',
    'HKLM\\',
    'reg add',
    'RegSetValue',
  ];
  for (const phrase of startupOrRunWrite) {
    assert.equal(source.includes(phrase), false, phrase);
  }
  assert.equal(source.includes('transparent: false'), true);
});

test('decideAutostart stays disabled for portable, development, and installed', () => {
  for (const mode of modes) {
    const decision = decideAutostart({
      requested: true,
      userGranted: true,
      portable: mode === 'portable',
      mode,
    });
    assert.equal(decision.enabled, false);
  }
  for (const row of widgetReleaseMatrix()) {
    assert.equal(row.enabled, false);
    assert.equal(modes.includes(row.mode), true);
  }
});
