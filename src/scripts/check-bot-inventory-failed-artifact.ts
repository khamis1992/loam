/** Diagnose the frozen output of a failed generation run without rewriting its outcome. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadConfig } from "../config.js";
import { OllamaClient } from "../ollama.js";
import { verifyApplication } from "../agent/appVerification.js";
import { probeInventoryDatabase } from "./inventory-database-probe.js";

const original = JSON.parse(fs.readFileSync("docs/evidence/bot-installed-inventory-corrected-live.json", "utf8"));
assert.equal(original.task.status, "error");
const source = original.task.workspace as string;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-failed-inventory-artifact-"));
const names = ["index.html", "server.mjs", "app-verification.json"];
const hash = (root: string, name: string) => createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex");
const sourceHashes = Object.fromEntries(names.map(name => [name, hash(source, name)]));
for (const name of names) fs.copyFileSync(path.join(source, name), path.join(workspace, name));
const evidence: Record<string, unknown> = { at: new Date().toISOString(), source, workspace, sourceHashes, originalTaskId: original.taskId, originalStatus: original.task.status, scope: "Independent diagnosis of a failed run's unchanged generated files AND unchanged acceptance contract; not autonomous generation success", pass: false };
const cfg = loadConfig(); cfg.workspace = workspace; cfg.vision.model = "glm-5.3-flash:cloud";
try {
  const declared = String(original.request).split("احفظ app-verification.json بهذا العقد بالضبط: ")[1]?.split(".\nاستخدم أدوات الملفات فقط")[0];
  assert.ok(declared, "original user contract must be available");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, "app-verification.json"), "utf8")), JSON.parse(declared), "generated acceptance contract must equal the user's original contract");
  const report = await verifyApplication({ cfg, ollama: new OllamaClient(cfg.ollamaUrl), request: original.request });
  evidence.report = report;
  // Run the independent data probe even if visual or browser acceptance failed.
  try { evidence.database = await probeInventoryDatabase(workspace); }
  catch (error) { evidence.database = { pass: false, error: String(error) }; }
  for (const name of names) {
    assert.equal(hash(workspace, name), sourceHashes[name], "copied artifact unchanged");
    assert.equal(hash(source, name), sourceHashes[name], "original artifact unchanged");
  }
  assert.ok(report.pass && report.checks.length === 12 && report.checks.every(c => c.pass), JSON.stringify(report));
  assert.equal((evidence.database as { pass: boolean }).pass, true);
  evidence.pass = true;
  console.log("PASS independent unchanged-artifact browser/vision/database diagnosis; original task remains failed");
} catch (error) { evidence.error = String(error); process.exitCode = 1; console.error(String(error)); }
finally { fs.writeFileSync("docs/evidence/bot-inventory-failed-artifact.json", JSON.stringify(evidence, null, 2)); }
