import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPasswordStore } = require('../../templates/electron-app/electron/apps/passwordStore.cjs') as {
  createPasswordStore: (
    root: string,
    ipcMain: null,
    safeStorage: {
      isEncryptionAvailable: () => boolean;
      encryptString: (value: string) => Buffer;
      decryptString: (value: Buffer) => string;
    },
  ) => {
    unlock: () => { locked: boolean };
    add: (input: { service: string; username: string; secret: string }) => Array<{ id: string; service: string; username: string }>;
    list: () => Array<{ id: string; service: string; username: string }>;
    reveal: (id: string) => string;
  };
};

function safeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value: Buffer) => {
      const text = value.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('bad_cipher');
      return text.slice(4);
    },
  };
}

function withTemp(prefix: string, run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function isUnsafeLabel(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_label';
}

function encodeOnce(value: string): string {
  return Array.from(value, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
}

function remoteSamples(): string[] {
  const schemes = ['mailto', 'tel', 'sms', 'intent', 'market', 'https', 'javascript'] as const;
  const samples: string[] = [];
  for (const scheme of schemes) {
    const literal = scheme === 'https' ? 'https://example.test/a' : `${scheme}:${scheme === 'mailto' ? 'ada@example.test' : 'local'}`;
    const payload = scheme === 'https' ? '//example.test/a' : scheme === 'mailto' ? 'ada@example.test' : 'local';
    samples.push(
      literal,
      literal.toUpperCase(),
      `${scheme} :${payload}`,
      `${scheme}%3a${payload}`,
      `${scheme.toUpperCase()}%3A${payload}`,
      encodeOnce(literal),
      encodeOnce(literal).toUpperCase(),
      `see ${scheme}%3a${payload}`,
    );
  }
  samples.push(
    '//cdn.example/a',
    '//CDN.example/a',
    'http://example.test/a',
    '%2F%2Fcdn.example/a',
    '%2f%2fcdn.example/a',
    'see %2F%2Fcdn.example/a',
    'java%73cript:alert(1)',
    'mail%74o:ada@example.test',
    'ht%74ps://example.test/a',
    'sms%20%3A+974',
    'JavaScript:alert(1)',
    'market://details',
    'intent:#Intent;end',
  );
  return samples;
}

test('add refuses a remote service or username, including one percent-decode, and leaves the vault file unchanged', () => {
  withTemp('loam-vault-label-', (root) => {
    const file = path.join(root, '.loam-vault.json');
    const store = createPasswordStore(root, null, safeStorage());
    const samples = remoteSamples();
    assert.ok(samples.length > 40);
    for (const sample of samples) assert.ok(sample.length <= 100 && sample.trim().length > 0, sample);
    assert.throws(
      () => store.add({ service: 'Mail', username: 'ada', secret: 'local-secret' }),
      (error: unknown) => error instanceof Error && error.message === 'vault_locked',
    );
    assert.equal(fs.existsSync(file), false);
    assert.equal(store.unlock().locked, false);
    for (const sample of samples) {
      assert.throws(() => store.add({ service: sample, username: 'ada', secret: 'local-secret' }), isUnsafeLabel, `service ${sample}`);
      assert.equal(fs.existsSync(file), false, sample);
      assert.throws(() => store.add({ service: 'Mail', username: sample, secret: 'local-secret' }), isUnsafeLabel, `username ${sample}`);
      assert.equal(fs.existsSync(file), false, sample);
    }
    const saved = store.add({ service: 'البريد', username: 'khamis', secret: 'جملة سر' });
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.service, 'البريد');
    assert.equal(saved[0]?.username, 'khamis');
    assert.deepEqual(Object.keys(saved[0] ?? {}).sort(), ['id', 'service', 'username']);
    const seeded = fs.readFileSync(file);
    for (const sample of samples) {
      assert.throws(() => store.add({ service: sample, username: 'ada', secret: 'mailto:ada@example.test' }), isUnsafeLabel, sample);
      assert.deepEqual(fs.readFileSync(file), seeded);
      assert.throws(() => store.add({ service: 'Mail', username: sample, secret: 'https://example.test' }), isUnsafeLabel, sample);
      assert.deepEqual(fs.readFileSync(file), seeded);
    }
    assert.deepEqual(store.list(), saved);
    assert.equal(store.reveal(saved[0]?.id ?? ''), 'جملة سر');
  });
});

test('a normal service and username pass when the vault is unlocked even if the secret contains a remote mark', () => {
  withTemp('loam-vault-label-ok-', (root) => {
    const file = path.join(root, '.loam-vault.json');
    const store = createPasswordStore(root, null, safeStorage());
    store.unlock();
    const secret = [
      'mailto:ada@example.test',
      'tel:+97400000000',
      'sms:+97400000000',
      'intent:scan',
      'market://details',
      'https://example.test/a',
      'javascript:alert(1)',
      '//cdn.example/a',
      'mailto%3Aada@example.test',
      '%2F%2Fcdn.example/a',
    ].join('\n');
    assert.ok(secret.length <= 500);
    const pairs = [
      { service: 'البريد', username: 'khamis' },
      { service: 'hotel', username: 'supermarket' },
      { service: 'note 100% done', username: 'ready%20now' },
      { service: 'Mail', username: 'ada@local' },
      { service: 'javascript notes', username: 'رسالة sms محلية' },
    ];
    const ids: string[] = [];
    for (const pair of pairs) {
      const saved = store.add({ service: pair.service, username: pair.username, secret });
      const added = saved[saved.length - 1];
      assert.equal(added?.service, pair.service);
      assert.equal(added?.username, pair.username);
      assert.equal(store.reveal(added?.id ?? ''), secret);
      ids.push(added?.id ?? '');
    }
    assert.equal(store.list().length, pairs.length);
    assert.equal(fs.existsSync(file), true);
    const stored = fs.readFileSync(file, 'utf8');
    assert.equal(stored.includes('mailto:ada@example.test'), false);
    assert.equal(stored.includes(secret), false);
    for (const id of ids) assert.equal(store.reveal(id), secret);
  });
});
