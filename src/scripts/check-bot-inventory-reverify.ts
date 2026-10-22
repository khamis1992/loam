/** Isolate the verifier fix using unchanged generated application files.
 * This is engineering-assisted re-verification, not a clean generation run. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadConfig } from "../config.js";
import { OllamaClient } from "../ollama.js";
import { verifyApplication } from "../agent/appVerification.js";
const source = path.resolve("output/verification/bot-inventory-initial-409");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-inventory-reverify-"));
const sourceHashes: Record<string, string> = {};
for (const name of ["index.html", "server.mjs", "app-verification.json"]) {
  const bytes = fs.readFileSync(path.join(source, name));
  sourceHashes[name] = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(path.join(workspace, name), bytes);
}
const manifest = path.join(workspace, "app-verification.json");
const contract = JSON.parse(fs.readFileSync(manifest, "utf8"));
for (const scenario of contract.scenarios) {
  if (scenario.name === "Overdraw rejected without changing stock") scenario.expectedResponses = [{ method: "POST", path: "/api/withdraw", status: 409, count: 1 }];
  if (scenario.name === "Duplicate SKU rejected") scenario.expectedResponses = [{ method: "POST", path: "/api/stock", status: 409, count: 1 }];
}
fs.writeFileSync(manifest, JSON.stringify(contract));
const cfg = loadConfig(); cfg.workspace = workspace; cfg.vision.model = "glm-5.3-flash:cloud";
const evidence = JSON.parse(fs.readFileSync("docs/evidence/bot-installed-inventory-live.json", "utf8"));
const report = await verifyApplication({ cfg, ollama: new OllamaClient(cfg.ollamaUrl), request: evidence.request });
for (const name of ["index.html", "server.mjs"]) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(workspace, name))).digest("hex"), sourceHashes[name]);
fs.writeFileSync("docs/evidence/bot-inventory-reverification.json", JSON.stringify({ at: new Date().toISOString(), workspace, source, sourceHashes, scope: "unchanged generated app; only acceptance declarations for the two originally required HTTP 409 responses added in copied test workspace", report }, null, 2));
assert.equal(report.pass, true, JSON.stringify(report));
assert.equal(report.checks.length, 12);
assert.ok(report.checks.every(c => c.pass));
console.log("PASS unchanged generated inventory: 12 actual browser/backend checks and live vision after correcting expected-response semantics");
