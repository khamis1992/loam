import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { BackendSandbox } from "../agent/backendSandbox.js";
import { parseAppContract, verifyApplication } from "../agent/appVerification.js";
import { AcceptanceGuard } from "../agent/acceptanceGuard.js";
import type { OllamaClient } from "../ollama.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-restart-check-"));
const cfg = loadConfig(); cfg.workspace = root;
const contract = { entry: "index.html", runtime: { type: "node", entry: "server.mjs" }, scenarios: [{ name: "Persist across process replacement", steps: [
  { action: "click", selector: "#add" }, { action: "textExact", selector: "#count", value: "1" },
  { action: "restartBackend" }, { action: "textExact", selector: "#count", value: "1" },
  { action: "restartBackend" }, { action: "textExact", selector: "#count", value: "1" },
], sqliteChecks: [{ database: "/tmp/state.sqlite", table: "counter", columns: ["n"], rows: [[1]] }] }] };
const file = path.join(root, "app-verification.json");
fs.writeFileSync(file, JSON.stringify(contract));
fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><meta name="viewport" content="width=device-width"><button id="add">Add</button><output id="count">Loading</output><script>async function update(method='GET'){count.textContent=(await(await fetch('/count',{method})).json()).n}add.onclick=()=>update('POST');update()</script>`);
const service = `import http from 'node:http';import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
// INITIALIZATION
const db=new DatabaseSync('/tmp/state.sqlite');db.exec('CREATE TABLE IF NOT EXISTS counter(n INTEGER); INSERT INTO counter SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM counter)');
http.createServer((q,r)=>{if(q.url==='/count'){if(q.method==='POST')db.exec('UPDATE counter SET n=n+1');r.setHeader('content-type','application/json');r.end(JSON.stringify(db.prepare('SELECT n FROM counter').get()));return}r.setHeader('content-type','text/html');r.end(fs.readFileSync('/app/index.html'))}).listen(3000,'127.0.0.1');`;
fs.writeFileSync(path.join(root, "server.mjs"), service);
let visualCalls = 0;
const model = { chat: async () => { visualCalls++; return { content: '{"verdict":"pass","reason":"fixture","issues":[]}', model: "fixture", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } }; } } as unknown as OllamaClient;
assert.throws(() => parseAppContract(JSON.stringify({ ...contract, runtime: undefined })), /backend/i);
assert.throws(() => parseAppContract(JSON.stringify({ ...contract, scenarios: [{ ...contract.scenarios[0], steps: [...contract.scenarios[0]!.steps, { action: "restartBackend" }] }] })), /two backend restarts/);
const guard = new AcceptanceGuard(); guard.check(root);
fs.writeFileSync(file, JSON.stringify({ ...contract, scenarios: [{ ...contract.scenarios[0], steps: contract.scenarios[0]!.steps.filter(s => s.action !== "restartBackend") }] }));
assert.throws(() => guard.check(root), /Frozen acceptance scenario/);
fs.writeFileSync(file, JSON.stringify(contract));
const good = await verifyApplication({ cfg, ollama: model, request: "Preserve database after server restart" });
assert.equal(good.pass, true, good.reason);
assert.equal(good.checks.length, 2);
for (const check of good.checks) { assert.equal(check.restarts?.length, 2); for (const r of check.restarts!) assert.notEqual(r.previousPid, r.currentPid); }
assert.equal(visualCalls, 1);
fs.writeFileSync(path.join(root, "server.mjs"), service.replace('// INITIALIZATION', "fs.rmSync('/tmp/state.sqlite',{force:true});"));
const bad = await verifyApplication({ cfg, ollama: model, request: "Preserve database after server restart" });
assert.equal(bad.pass, false);
assert.ok(bad.checks.every(c => !c.pass && c.restarts?.length === 1));
assert.equal(visualCalls, 1, "visual PASS cannot override data lost at startup");
fs.writeFileSync(path.join(root, "server.mjs"), service);
const sandbox = await BackendSandbox.start(root, "server.mjs");
try {
  const before = await sandbox.inspect() as any;
  await sandbox.request('/count', 'POST');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(sandbox.restart(aborted.signal));
  await sandbox.restart(); await sandbox.restart();
  const after = await sandbox.inspect() as any;
  assert.equal(after.Id, before.Id); assert.equal(after.State.StartedAt, before.State.StartedAt);
  assert.deepEqual(await sandbox.readSqlite({ database: '/tmp/state.sqlite', table: 'counter', columns: ['n'], rows: [] }), [[1]]);
  await assert.rejects(sandbox.restart(), /two backend restarts/);
} finally { await sandbox.close(); }
const bounded = await BackendSandbox.start(root, 'server.mjs', undefined, 6000);
try {
  const before = await bounded.inspect() as any;
  await new Promise(resolve => setTimeout(resolve, 2000));
  await bounded.restart();
  const remaining = Date.parse(before.State.StartedAt) + 6500 - Date.now();
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  const expired = await bounded.inspect() as any;
  assert.equal(expired.State.Running, false, 'restart must not extend the original container lifetime');
  assert.equal(expired.State.ExitCode, 124);
} finally { await bounded.close(); }
fs.writeFileSync('docs/evidence/bot-backend-restart.json', JSON.stringify({ at: new Date().toISOString(), good, bad, sameContainerVerified: true, cancellationPreservesAllowance: true, lifetimeNotExtended: true, visualModelIsFixture: true }, null, 2));
console.log('PASS actual process replacement, same container/data, destructive startup rejected before vision, frozen steps and restart bounds');
