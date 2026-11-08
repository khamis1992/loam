import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHabitStore } = require('../electron/apps/habitStore.cjs');
const { createMarkdownStore } = require('../electron/apps/markdownStore.cjs');
const { createPasswordStore } = require('../electron/apps/passwordStore.cjs');
const { createPhotoStore } = require('../electron/apps/photoStore.cjs');

function temporary(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

test('habit store completes once, calculates streaks and emits due reminders', () => {
  const root = temporary('loam-habits-');
  const now = () => new Date(2026, 0, 8, 9, 0, 0);
  const reminders = [];
  const store = createHabitStore(root, undefined, { now, notify: (habit) => reminders.push(habit.name) });
  const [habit] = store.add({ name: 'Read', reminder: '09:00', days: [4] });
  const second = createHabitStore(root, undefined, { now, notify: (habit) => reminders.push(habit.name) });
  second.checkReminders();
  second.checkReminders();
  assert.deepEqual(reminders, ['Read']);
  store.complete(habit.id);
  store.complete(habit.id);
  assert.equal(store.list()[0].streak, 1);
  assert.equal(store.list()[0].weeklyCompletions, 1);
  assert.throws(() => store.add({ name: 'Bad', reminder: '99:00', days: [1] }), /Invalid reminder/);
});

test('markdown store persists only markdown inside its fixture', () => {
  const root = temporary('loam-markdown-');
  const store = createMarkdownStore(root);
  store.write('notes.md', '# Safe\n\n**Markdown**');
  assert.equal(store.read('notes.md').content, '# Safe\n\n**Markdown**');
  assert.deepEqual(store.list(), ['notes.md']);
  assert.throws(() => store.write('../outside.md', 'bad'), /Invalid file name/);
  assert.throws(() => store.read('notes.txt'), /Expected a .md file/);
});

test('password store encrypts secrets and enforces locking', () => {
  const root = temporary('loam-vault-');
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value).reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString('utf8'),
  };
  const store = createPasswordStore(root, undefined, safeStorage);
  assert.throws(() => store.reveal('missing'), /vault_locked/);
  store.unlock();
  const [record] = store.add({ service: 'Example', username: 'me', secret: 'plain-secret' });
  assert.equal(store.reveal(record.id), 'plain-secret');
  assert.equal(fs.readFileSync(path.join(root, '.loam-vault.json'), 'utf8').includes('plain-secret'), false);
  store.lock();
  assert.throws(() => store.reveal(record.id), /vault_locked/);
  store.unlock();
  store.remove(record.id);
  assert.deepEqual(store.list(), []);
  const unavailable = createPasswordStore(temporary('loam-vault-off-'), undefined, { isEncryptionAvailable: () => false });
  assert.throws(() => unavailable.unlock(), /secure_storage_unavailable/);
});

test('photo store hashes exact duplicates and copies without deleting originals', () => {
  const root = temporary('loam-photos-');
  const store = createPhotoStore(root);
  const files = store.scan();
  assert.equal(files.length, 3);
  assert.equal(files.filter((file) => file.duplicateOf).length, 1);
  assert.equal(store.sort().sortedCount, 3);
  assert.equal(fs.readdirSync(path.join(root, 'sorted')).length, 3);
  for (const file of files) assert.ok(fs.existsSync(path.join(root, file.name)));
});
