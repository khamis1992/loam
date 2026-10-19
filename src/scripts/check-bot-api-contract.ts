import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { verifyApplication, parseAppContract } from "../agent/appVerification.js";
import { AcceptanceGuard } from "../agent/acceptanceGuard.js";
import { validateApiChecks } from "../agent/apiChecks.js";
import type { OllamaClient } from "../ollama.js";
const cfg = loadConfig(); cfg.workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-api-contract-"));
const request = (body: string) => ({ method: "POST", path: "/api/add", body });
const groups = [
  { requests: [request('{"id":" "}')], statuses: [400] },
  { requests: [request('{broken')], statuses: [400] },
  { requests: [request('{"id":"one"}'), request('{"id":"one"}')], statuses: [201, 200] },
];
const contract = { entry: "index.html", runtime: { type: "node", entry: "server.mjs" }, scenarios: [{ name: "API validation and replay", steps: [{ action: "visible", selector: "h1" }], apiChecks: groups, sqliteChecks: [{ database: "/tmp/api.sqlite", table: "effects", columns: ["id"], rows: [["one"]] }] }] };
const write = () => fs.writeFileSync(path.join(cfg.workspace, "app-verification.json"), JSON.stringify(contract)); write();
fs.writeFileSync(path.join(cfg.workspace, "index.html"), '<!doctype html><meta name="viewport" content="width=device-width"><h1>API check</h1>');
let vision = 0;
const ollama = { chat: async () => { vision++; return { model: "fixture", content: '{"verdict":"pass","reason":"fixture visual approval","issues":[]}', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } }; } } as unknown as OllamaClient;
const reports: Record<string, unknown> = {};
for (const mode of ["good", "blank-accepted", "duplicate-effect"] as const) {
  fs.writeFileSync(path.join(cfg.workspace, "server.mjs"), `import http from 'node:http';import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('/tmp/api.sqlite');db.exec('CREATE TABLE effects(id TEXT)');
http.createServer(async(q,r)=>{if(q.url!=='/api/add'){r.setHeader('content-type','text/html');r.end(fs.readFileSync('/app/index.html'));return}let raw='';for await(const b of q)raw+=b;let body;try{body=JSON.parse(raw)}catch{r.writeHead(400).end();return}
if(typeof body?.id!=='string'||!body.id${mode === "blank-accepted" ? "" : ".trim()"}){r.writeHead(400).end();return}
const old=db.prepare('SELECT id FROM effects WHERE id=?').get(body.id);if(!old||${mode === "duplicate-effect"})db.prepare('INSERT INTO effects VALUES(?)').run(body.id);r.writeHead(old?200:201).end('{}');}).listen(3000,'127.0.0.1');`);
  const result = await verifyApplication({ cfg, ollama, request: "Reject whitespace-only identifiers and malformed JSON, apply duplicate concurrent requests once" });
  reports[mode] = result;
  assert.equal(result.pass, mode === "good", JSON.stringify(result));
  if (mode === "good") assert.ok(result.checks.every(c => c.api?.length === 4 && c.databases?.[0]?.rows.length === 1));
  if (mode === "blank-accepted") assert.ok(result.checks.every(c => c.api?.[0]?.status === 201 && c.error?.includes("API group 0 mismatch")));
  if (mode === "duplicate-effect") assert.ok(result.checks.every(c => c.api?.length === 4 && c.error?.includes("SQLite rows mismatch")));
}
assert.equal(vision, 1, "API or storage failure must stop before visual approval");
const guard = new AcceptanceGuard(); guard.check(cfg.workspace);
groups[0]!.statuses = [201]; write(); assert.throws(() => guard.check(cfg.workspace), /Frozen acceptance/);
groups[0]!.statuses = [400]; groups[0]!.requests[0]!.body = '{"id":"valid"}'; write(); assert.throws(() => guard.check(cfg.workspace), /Frozen acceptance/);
for (const bad of [[], [{ requests: [request("x")], statuses: [500] }], [{ requests: [{ ...request("x"), path: "//external" }], statuses: [400] }], [{ requests: [{ ...request("x"), headers: {} }], statuses: [400] }], [{ requests: [request("x".repeat(16001))], statuses: [400] }], [{ requests: [{ method: "GET", path: "/", body: "x" }], statuses: [200] }]]) assert.throws(() => validateApiChecks(bad));
assert.throws(() => parseAppContract(JSON.stringify({ ...contract, runtime: undefined })), /require an isolated/);
fs.writeFileSync("docs/evidence/bot-api-contract.json", JSON.stringify({ at: new Date().toISOString(), workspace: cfg.workspace, scope: "Actual Docker/browser/SQLite; fixture visual verdict", reports, pass: true }, null, 2));
console.log("PASS direct API acceptance: concurrent requests, malformed/blank input rejection, duplicate storage holdout, frozen conditions and bounded schema");
