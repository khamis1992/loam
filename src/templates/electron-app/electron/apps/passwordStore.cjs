const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readJson, writeJsonAtomic, text } = require('./helpers.cjs');

const REMOTE_LABEL = /(?<![A-Za-z])(?:mailto|tel|sms|intent|market|https|javascript)(?![A-Za-z])\s*:|\/\//i;

function decodePercentOnce(value) {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function remoteLabel(value) {
  const decoded = decodePercentOnce(value);
  return REMOTE_LABEL.test(value) || REMOTE_LABEL.test(decoded);
}

function secretText(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > 500) throw new Error('Invalid secret');
  return normalized;
}

function createPasswordStore(rootDirectory, ipcMain, safeStorage) {
  const file = path.join(rootDirectory, '.loam-vault.json');
  let locked = true;

  function available() {
    if (!safeStorage?.isEncryptionAvailable()) throw new Error('secure_storage_unavailable');
  }

  function records() {
    const data = readJson(file, { records: [] });
    return Array.isArray(data.records) ? data.records : [];
  }

  function list() {
    return records().map(({ id, service, username }) => ({ id, service, username }));
  }

  function unlock() {
    available();
    locked = false;
    return { locked };
  }

  function lock() {
    locked = true;
    return { locked };
  }

  function add(input) {
    available();
    if (locked) throw new Error('vault_locked');
    const serviceLabel = String(input?.service ?? '').trim();
    const usernameLabel = String(input?.username ?? '').trim();
    if (remoteLabel(serviceLabel) || remoteLabel(usernameLabel)) throw new Error('unsafe_label');
    const service = text(input.service, 'service', 100);
    const username = text(input.username, 'username', 160);
    const secret = secretText(input.secret);
    const all = records();
    const record = {
      id: randomUUID(),
      service,
      username,
      secretEncrypted: safeStorage.encryptString(secret).toString('base64'),
    };
    all.push(record);
    writeJsonAtomic(file, { records: all });
    return list();
  }

  function reveal(id) {
    available();
    if (locked) throw new Error('vault_locked');
    const record = records().find((candidate) => candidate.id === id);
    if (!record || typeof record.secretEncrypted !== 'string') throw new Error('Secret not found');
    return safeStorage.decryptString(Buffer.from(record.secretEncrypted, 'base64'));
  }

  function remove(id) {
    if (locked) throw new Error('vault_locked');
    const remaining = records().filter((record) => record.id !== id);
    if (remaining.length === records().length) throw new Error('Secret not found');
    writeJsonAtomic(file, { records: remaining });
    return list();
  }

  ipcMain?.handle('vault:list', () => list());
  ipcMain?.handle('vault:unlock', () => unlock());
  ipcMain?.handle('vault:lock', () => lock());
  ipcMain?.handle('vault:add', (_event, input) => add(input));
  ipcMain?.handle('vault:reveal', (_event, id) => reveal(id));
  ipcMain?.handle('vault:remove', (_event, id) => remove(id));
  return { list, unlock, lock, add, reveal, remove };
}

module.exports = { createPasswordStore };
