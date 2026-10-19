import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../config.js";
import { verifyApplication, parseAppContract } from "../agent/appVerification.js";
import type { OllamaClient, ChatOptions } from "../ollama.js";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-backend-app-"));
const cfg = loadConfig(); cfg.workspace = root;
const contract = { entry: "index.html", runtime: { type: "node", entry: "server.mjs" }, scenarios: [
  { name: "Server state survives page reload", steps: [{ action: "textExact", selector: "#count", value: "0" }, { action: "click", selector: "#add" }, { action: "textExact", selector: "#count", value: "1" }, { action: "reload" }, { action: "textExact", selector: "#count", value: "1" }] },
  { name: "Independent server state", steps: [{ action: "textExact", selector: "#count", value: "0" }] },
] };
fs.writeFileSync(path.join(root, "app-verification.json"), JSON.stringify(contract));
fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Backend counter</title><h1>Backend counter</h1><button id="add">Add</button><output id="count">Loading</output><script>async function update(method='GET'){const r=await fetch('/api/count',{method});if(!r.ok)throw Error('API failed');count.textContent=(await r.json()).count}add.onclick=()=>update('POST');update()</script>`);
const service = `import http from 'node:http';import fs from 'node:fs';let n=0;http.createServer((q,r)=>{if(q.url==='/api/count'){if(q.method==='POST')n++;setTimeout(()=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({count:n}))},300);return}if(q.url==='/index.html'||q.url==='/'){r.setHeader('content-type','text/html');r.end(fs.readFileSync('/app/index.html'));return}r.statusCode=404;r.end()}).listen(3000,'127.0.0.1')`;
fs.writeFileSync(path.join(root, "server.mjs"), service);
let visualCalls = 0;
const model = { chat: async (o: ChatOptions) => { visualCalls++; assert.equal(o.messages.filter(m => m.images?.length).length, 4); return { content: '{"verdict":"pass","reason":"visible counter","issues":[]}', toolCalls: [], model: "visual-fixture", usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } }; } } as unknown as OllamaClient;
const good = await verifyApplication({ cfg, ollama: model, request: "Server-backed counter with persistence across page reload; independent test scenarios" });
assert.equal(good.pass, true, good.reason);
assert.equal(good.checks.length, 4);
assert.equal(visualCalls, 1);
console.log("PASS browser → isolated backend API, async assertions, reload persistence and clean state per scenario/viewport");
fs.writeFileSync(path.join(root, "server.mjs"), service.replace("if(q.method==='POST')n++", "if(q.method==='POST')n+=2"));
const bad = await verifyApplication({ cfg, ollama: model, request: "Increment by one" });
assert.equal(bad.pass, false);
assert.ok(bad.checks.some(c => !c.pass));
assert.equal(visualCalls, 1, "bad API cannot be certified by visual PASS");
assert.throws(() => parseAppContract(JSON.stringify({ ...contract, runtime: { type: "shell", entry: "x" } })));
const containers = await promisify(execFile)("docker", ["ps", "-a", "--filter", "label=loam.verification=backend", "--format", "{{.Names}}"]);
assert.equal(containers.stdout.trim(), "", "no verification runtime left after success/failure");
fs.mkdirSync("docs/evidence", { recursive: true });
fs.writeFileSync("docs/evidence/bot-backend-app.json", JSON.stringify({ at: new Date().toISOString(), workspace: root, good, bad, cleanup: true, visualModelIsFixture: true }, null, 2));
console.log("PASS wrong backend result rejected before visual review; unsupported runtime rejected; cleanup verified");
