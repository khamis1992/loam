import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHabitStore } = require('../../templates/electron-app/electron/apps/habitStore.cjs') as {
  createHabitStore: (root: string) => {
    add: (input: { name: string; reminder: string; days: number[] }) => Array<{ name: string }>;
    list: () => Array<{ name: string }>;
  };
};

function encodeMarks(value: string): string {
  return value.replace(/[:/]/g, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function encodeAll(value: string): string {
  return [...Buffer.from(value)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
}

function remoteNames(): string[] {
  const literals = [
    'mailto:user@example.test',
    'MAILTO:user@example.test',
    'tel:+97400000000',
    'TEL:+97400000000',
    'sms:+97400000000',
    'SMS:+97400000000',
    'intent:#Intent;end',
    'INTENT:#Intent;end',
    'market://details?id=app',
    'MARKET://details?id=app',
    'https://example.test/a',
    'HTTPS://example.test/a',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '//example.test/a',
    '//HOST/a',
  ];
  const names: string[] = [];
  for (const literal of literals) {
    const marked = encodeMarks(literal);
    const encoded = encodeAll(literal);
    for (const name of [literal, marked, marked.toUpperCase(), encoded, `قبل ${literal}`, `قبل ${marked}`]) {
      if (name.length <= 80) names.push(name);
    }
  }
  return names;
}

test('a remote habit name throws and leaves the previous file unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-habit-remote-'));
  try {
    const store = createHabitStore(root);
    const file = path.join(root, '.loam-habits.json');
    assert.equal(fs.existsSync(file), false);
    assert.throws(() => store.add({ name: 'mailto:user@example.test', reminder: '09:00', days: [1] }));
    assert.equal(fs.existsSync(file), false);

    const saved = store.add({ name: 'قراءة', reminder: '09:00', days: [1, 2, 3, 4, 5] });
    assert.equal(saved[0]?.name, 'قراءة');
    const previous = fs.readFileSync(file);
    const names = remoteNames();
    assert.ok(names.length > 16);
    for (const name of names) {
      assert.throws(
        () => store.add({ name, reminder: '09:00', days: [1] }),
        (error: unknown) => error instanceof Error,
        name,
      );
      assert.deepEqual(fs.readFileSync(file), previous);
    }
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]?.name, 'قراءة');

    const again = store.add({ name: 'صلاة الفجر', reminder: '05:00', days: [0, 1, 2, 3, 4, 5, 6] });
    assert.deepEqual(again.map((habit) => habit.name), ['قراءة', 'صلاة الفجر']);
    assert.deepEqual(store.list().map((habit) => habit.name), ['قراءة', 'صلاة الفجر']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
