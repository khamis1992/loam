import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadConfig } from '../config.js';
import { verifyApplication } from '../agent/appVerification.js';
import { BackendSandbox } from '../agent/backendSandbox.js';
import type { OllamaClient } from '../ollama.js';

const archived = path.resolve('output/verification/bot-tickets-recovered-pass-20261019');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-ticket-restart-holdout-'));
const hashes: Record<string, string> = {};
for (const name of ['server.mjs', 'index.html']) {
  const bytes = fs.readFileSync(path.join(archived, name));
  fs.writeFileSync(path.join(root, name), bytes);
  hashes[name] = createHash('sha256').update(bytes).digest('hex');
}
const original = JSON.parse(fs.readFileSync(path.join(archived, 'app-verification.json'), 'utf8'));
const update = structuredClone(original.scenarios.find((s: {name:string}) => s.name === 'Update version'));
assert.ok(update);
update.name = 'Updated ticket survives backend process restart';
update.steps.push({ action: 'restartBackend' }, { action: 'textExact', selector: '.ticket[data-id="a"] [data-version]', value: '2' });
fs.writeFileSync(path.join(root, 'app-verification.json'), JSON.stringify({ entry: original.entry, runtime: original.runtime, scenarios: [update] }));
const cfg = loadConfig(); cfg.workspace = root;
let calls = 0;
const model = { chat: async () => { calls++; throw Error('A failed runtime must not reach vision'); } } as unknown as OllamaClient;
const result = await verifyApplication({ cfg, ollama: model, request: 'Updated tickets must survive restarting the backend server process' });
assert.equal(result.pass, false);
assert.equal(result.checks.length, 2);
assert.ok(result.checks.every(c => !c.pass && c.restarts?.length === 1 && /locator.innerText/.test(c.error ?? '') && (c.error ?? '').includes('data-version')));
assert.equal(calls, 0);
const sandbox = await BackendSandbox.start(root, 'server.mjs');
let before: unknown, after: unknown;
try {
  const created = await sandbox.request('/api/tickets', 'POST', {'content-type':'application/json'}, Buffer.from(JSON.stringify({id:'holdout',title:'Must survive'})).toString('base64'));
  assert.equal(created.status, 201);
  const query = { database:'/tmp/tickets.sqlite',table:'tickets',columns:['id','title','status','version'],rows:[] };
  before = await sandbox.readSqlite(query); assert.deepEqual(before, [['holdout','Must survive','open',1]]);
  await sandbox.restart(); after = await sandbox.readSqlite(query); assert.deepEqual(after, []);
} finally { await sandbox.close(); }
for (const [name, hash] of Object.entries(hashes)) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'), hash);
fs.writeFileSync('docs/evidence/bot-restart-holdout.json', JSON.stringify({ at: new Date().toISOString(), source: archived, workspace: root, unchangedSourceHashes: hashes, result, databaseBeforeRestart: before, databaseAfterRestart: after, outcome: 'Previously generated application loses data on process restart; new gate rejects both viewports', visualCalls: calls }, null, 2));
console.log('PASS unchanged previously generated ticket application rejected for startup data loss on both viewports');
