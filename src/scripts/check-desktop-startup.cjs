// Exercise the actual Electron startup code without launching processes or waiting.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const version = require(path.join(root, 'package.json')).version;
const source = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');

function harness({ occupied = false, wrongProfile = false, readyAt = Infinity, exitFirst = false } = {}) {
  let now = 0;
  const children = [];
  const dataDir = path.join(root, 'test-profile', 'data');
  const profileId = createHash('sha256').update(dataDir.toLowerCase()).digest('hex');
  const http = { get(url, callback) {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => {};
    queueMicrotask(() => {
      const running = children.length > 0 && now >= readyAt;
      if (!occupied && !running) { request.emit('error', new Error('ECONNREFUSED')); return; }
      const response = new EventEmitter();
      response.statusCode = 200;
      response.resume = () => {};
      callback(response);
      response.emit('data', JSON.stringify({ application: 'Loam', version, apiVersion: 1,
        profileId: wrongProfile ? 'another-profile' : profileId }));
      response.emit('end');
    });
    return request;
  } };
  const app = { isPackaged: false, setName() {}, setPath() {}, getPath() { return root; },
    setAppUserModelId() {}, requestSingleInstanceLock() { return true; }, on() {},
    whenReady() { return { then() {} }; }, quit() {} };
  const context = vm.createContext({
    __dirname: path.join(root, 'electron'), console: { log() {}, error() {} },
    process: { env: { LOAM_DATA_DIR: dataDir }, platform: 'win32', execPath: 'mock-electron.exe',
      stdout: { write() {} }, stderr: { write() {} } },
    Date: { now: () => now },
    setTimeout(callback, delay) { now += delay; queueMicrotask(callback); return 1; },
    setInterval() { throw new Error('Unexpected real watchdog startup'); },
    require(name) {
      if (name === 'electron') return { app, ipcMain: { handle() {} } };
      if (name === 'node:fs') return { existsSync: () => true };
      if (name === 'node:http') return http;
      if (name === 'node:child_process') return { spawn() {
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kills = 0; child.kill = () => { child.kills++; };
        children.push(child);
        if (exitFirst && children.length === 1) queueMicrotask(() => child.emit('exit', 1));
        return child;
      } };
      if (name === './updater.cjs' || name === './mcp-bridge.cjs') return {};
      return require(name);
    },
  });
  vm.runInContext(source + '\nglobalThis.subject = { ping, ensureServer, child: () => serverChild };', context);
  return { subject: context.subject, children, elapsed: () => now };
}

(async () => {
  const foreign = harness({ occupied: true, wrongProfile: true });
  assert.equal(await foreign.subject.ping(), false);
  await assert.rejects(foreign.subject.ensureServer(), /المنفذ/);
  assert.equal(foreign.children.length, 0, 'Must not replace another profile server');

  const same = harness({ occupied: true });
  assert.equal(await same.subject.ensureServer(), 'external');
  assert.equal(same.children.length, 0);

  const slow = harness({ readyAt: 45_000 });
  assert.equal(await slow.subject.ensureServer(), 'spawned');
  assert.ok(slow.elapsed() >= 45_000);
  assert.equal(slow.children.length, 1, 'Slow MCP startup must retain its original process');
  assert.equal(slow.children[0].kills, 0);

  const stalled = harness();
  await assert.rejects(stalled.subject.ensureServer(), /مهلة/);
  assert.ok(stalled.elapsed() >= 120_000);
  assert.equal(stalled.children.length, 1, 'A live timeout must not spawn replacements');
  assert.equal(stalled.children[0].kills, 1);
  assert.equal(stalled.subject.child(), stalled.children[0], 'Retain ownership for shutdown cleanup');

  const crashed = harness({ exitFirst: true, readyAt: 2500 });
  assert.equal(await crashed.subject.ensureServer(), 'spawned-retry2');
  assert.equal(crashed.children.length, 2);
  assert.ok(crashed.children.every(child => child.kills === 0));
  console.log('PASS desktop startup: profile collision, matching reuse, slow startup, owned timeout cleanup, early-exit retry (virtual clock).');
})().catch(error => { console.error(error); process.exitCode = 1; });
