'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FILE = 'build-menu-widgets.json';

function registryFile(dataDir) {
  return path.join(dataDir, FILE);
}

function isStartIdentity(value) {
  return typeof value === 'string' && /^\d{1,32}$/.test(value);
}

function readRegularStat(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  if (stat.nlink > 1) throw new Error('unsafe_path');
  return stat;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code && error.code !== 'ENOENT') throw error;
    return null;
  }
}

function readRecords(dataDir) {
  const file = registryFile(dataDir);
  if (!readRegularStat(file)) return [];
  const text = readText(file);
  if (text === null) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row) => row
      && Number.isInteger(row.pid) && row.pid > 0
      && typeof row.nonce === 'string' && /^[a-f0-9]{32}$/.test(row.nonce)
      && typeof row.workspace === 'string' && path.isAbsolute(row.workspace)
      && isStartIdentity(row.identity));
  } catch {
    return [];
  }
}

function refuseSharedDestination(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    return;
  }
  if (stat.nlink > 1) throw new Error('unsafe_path');
}

function writeRecords(dataDir, records) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = registryFile(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  refuseSharedDestination(file);
  refuseSharedDestination(tmp);
  fs.writeFileSync(tmp, `${JSON.stringify(records)}\n`);
  refuseSharedDestination(file);
  fs.renameSync(tmp, file);
}

function noncePath(workspace) {
  return path.join(workspace, '.loam', 'build-menu', 'widget-nonce');
}

function writeWidgetNonce(workspace, nonce) {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error('invalid_request');
  const file = noncePath(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  refuseSharedDestination(file);
  fs.writeFileSync(file, `${nonce}\n`);
}

function nonceMatches(record) {
  const file = noncePath(record.workspace);
  if (!readRegularStat(file)) return false;
  const text = readText(file);
  if (text === null) return false;
  return text.replace(/\r?\n$/, '') === record.nonce;
}

function manifestIsWidget(workspace) {
  if (!path.isAbsolute(workspace)) return false;
  let cursor = workspace;
  try {
    for (const part of ['.loam', 'build-menu']) {
      cursor = path.join(cursor, part);
      const relative = path.relative(workspace, cursor);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    }
    cursor = path.join(cursor, 'manifest.json');
    const relative = path.relative(workspace, cursor);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    return false;
  }
  const stat = readRegularStat(cursor);
  if (!stat || stat.size > 65536) return false;
  const text = readText(cursor);
  if (text === null) return false;
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    return Boolean(parsed && parsed.selection && parsed.selection.kind === 'widget');
  } catch {
    return false;
  }
}

function rememberWidget(dataDir, record) {
  if (!path.isAbsolute(dataDir) || !path.isAbsolute(record.workspace)) throw new Error('unsafe_path');
  if (!isStartIdentity(record.identity)) throw new Error('invalid_request');
  const records = readRecords(dataDir).filter((row) => row.pid !== record.pid);
  records.push({
    pid: record.pid,
    nonce: record.nonce,
    workspace: record.workspace,
    identity: record.identity,
  });
  writeRecords(dataDir, records);
}

function forgetWidget(dataDir, pid) {
  if (!path.isAbsolute(dataDir)) return;
  const records = readRecords(dataDir).filter((row) => row.pid !== pid);
  writeRecords(dataDir, records);
}

function powershellExecutable() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function readPosixStartIdentity(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = text.lastIndexOf(')');
    if (end < 0) return null;
    const start = text.slice(end + 2).split(' ')[19];
    return isStartIdentity(start) ? start : null;
  } catch {
    return null;
  }
}

function readWidgetStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform !== 'win32') return readPosixStartIdentity(pid);
  try {
    const command = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { exit 0 }; $p.StartTime.ToUniversalTime().Ticks`;
    const output = execFileSync(powershellExecutable(), [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ], {
      windowsHide: true,
      timeout: 8000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const ticks = String(output).replace(/^\uFEFF/, '').trim();
    return isStartIdentity(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

function planWidgetQuit(dataDir, lookup) {
  if (!path.isAbsolute(dataDir) || typeof lookup !== 'function') return { ask: false, pids: [] };
  const keep = [];
  const pids = [];
  for (const record of readRecords(dataDir)) {
    let live = null;
    try {
      live = lookup(record.pid);
    } catch {
      live = null;
    }
    if (!isStartIdentity(live) || live !== record.identity) continue;
    if (!nonceMatches(record)) continue;
    if (!manifestIsWidget(record.workspace)) continue;
    keep.push(record);
    pids.push(record.pid);
  }
  writeRecords(dataDir, keep);
  return { ask: pids.length > 0, pids };
}

function ownedStopArgs(pid) {
  return ['/PID', String(pid), '/T', '/F'];
}

module.exports = {
  rememberWidget,
  forgetWidget,
  planWidgetQuit,
  ownedStopArgs,
  writeWidgetNonce,
  readWidgetStartIdentity,
};
