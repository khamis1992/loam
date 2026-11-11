import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { text } = require('../../templates/electron-app/electron/apps/helpers.cjs') as {
  text: (value: unknown, label: string, max?: number) => string;
};
const { createHabitStore } = require('../../templates/electron-app/electron/apps/habitStore.cjs') as {
  createHabitStore: (root: string) => {
    add: (input: { name: string; reminder: string; days: number[] }) => unknown;
    list: () => Array<{ name: string }>;
  };
};
const { createPasswordStore } = require('../../templates/electron-app/electron/apps/passwordStore.cjs') as {
  createPasswordStore: (
    root: string,
    ipc: undefined,
    safeStorage: {
      isEncryptionAvailable: () => boolean;
      encryptString: (value: string) => Buffer;
      decryptString: (value: Buffer) => string;
    },
  ) => {
    unlock: () => { locked: boolean };
    add: (input: { service: string; username: string; secret: string }) => unknown;
    list: () => unknown[];
  };
};

const ARABIC = 'قراءة';

const COLON_SCHEMES: ReadonlyArray<readonly [string, string]> = [
  ['mailto', 'user@example.test'],
  ['tel', '+97400000000'],
  ['sms', '+97400000000'],
  ['intent', 'scan'],
  ['market', 'details?id=app'],
  ['javascript', 'alert(1)'],
  ['data', 'text/html,hi'],
  ['file', '///c:/secret'],
  ['blob', 'null/uuid'],
  ['https', '//evil.example/a'],
  ['http', '//evil.example/a'],
];

function rejectedValues(): string[] {
  const values: string[] = [];
  for (const [name, rest] of COLON_SCHEMES) {
    const upper = name.toUpperCase();
    const quoted = `"${name}"+":${rest}"`;
    values.push(
      `${name}:${rest}`,
      `${upper}:${rest}`,
      `${name} :${rest}`,
      `${name}%3A${rest}`,
      `${upper}%3a${rest}`,
      quoted,
      `'${name}' + ':${rest}'`,
      `${name.slice(0, 2)}+${name.slice(2)}:${rest}`,
      `${name.slice(0, 4)}"${name.slice(4)}:${rest}`,
      encodeURIComponent(quoted),
      `%20${name}%3A${rest}`,
    );
  }
  values.push(
    '//evil.example/a',
    '//EVIL.example/a',
    '%2F%2Fevil.example/a',
    '%2f%2fevil.example/a',
    '"/"+"/"',
    "'/'+'/'",
    '/+/evil.example/a',
    'java%73cript:alert(1)',
    'قبل mailto:a@b.c',
  );
  return values;
}

function invalidLabel(label: string) {
  if (label === 'service' || label === 'username') return (error: unknown) => error instanceof Error && (error.message === 'unsafe_label' || error.message === `Invalid ${label}`);
  return (error: unknown) => error instanceof Error && error.message === `Invalid ${label}`;
}

function withRoot(prefix: string, run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('text refuses schemes, one percent-decode, and quote or plus splits, and keeps a short Arabic label', () => {
  assert.equal(text(`  ${ARABIC}  `, 'label'), ARABIC);
  assert.equal(text('ملاحظة قصيرة', 'label'), 'ملاحظة قصيرة');
  const values = rejectedValues();
  assert.ok(values.length > 40);
  for (const value of values) {
    assert.ok(value.length <= 80, value);
    assert.throws(() => text(value, 'label'), invalidLabel('label'), value);
  }
});

test('a rejected text value is not written by habit or password stores', () => {
  const values = rejectedValues();
  withRoot('loam-44-habits-', (root) => {
    const file = path.join(root, '.loam-habits.json');
    const store = createHabitStore(root);
    assert.throws(() => store.add({ name: 'mailto:user@example.test', reminder: '09:00', days: [1] }), invalidLabel('habit name'));
    assert.equal(fs.existsSync(file), false);
    store.add({ name: ARABIC, reminder: '09:00', days: [1] });
    const saved = fs.readFileSync(file);
    assert.equal(store.list()[0]?.name, ARABIC);
    for (const value of values) {
      assert.throws(() => store.add({ name: value, reminder: '09:00', days: [1] }), invalidLabel('habit name'), value);
      assert.deepEqual(fs.readFileSync(file), saved, value);
      assert.deepEqual(fs.readdirSync(root), ['.loam-habits.json'], value);
    }
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]?.name, ARABIC);
  });

  withRoot('loam-44-vault-', (root) => {
    const file = path.join(root, '.loam-vault.json');
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value).reverse(),
      decryptString: (value: Buffer) => Buffer.from(value).reverse().toString('utf8'),
    };
    const store = createPasswordStore(root, undefined, safeStorage);
    store.unlock();
    assert.throws(
      () => store.add({ service: 'https://evil.example/a', username: ARABIC, secret: 'سر' }),
      invalidLabel('service'),
    );
    assert.equal(fs.existsSync(file), false);
    store.add({ service: 'مثال', username: ARABIC, secret: 'سر' });
    const saved = fs.readFileSync(file);
    assert.equal(saved.includes('https://evil.example'), false);
    for (const value of values) {
      assert.throws(() => store.add({ service: value, username: ARABIC, secret: 'سر' }), invalidLabel('service'), value);
      assert.throws(() => store.add({ service: 'مثال', username: value, secret: 'سر' }), invalidLabel('username'), value);
      assert.deepEqual(fs.readFileSync(file), saved, value);
      assert.deepEqual(fs.readdirSync(root), ['.loam-vault.json'], value);
    }
    assert.equal(store.list().length, 1);
  });
});
