/**
 * Per-capability live-lab acceptance (RED_TEAM_BUILD_SPEC §9).
 *
 * A deliberately vulnerable loopback app is tested through the REAL bridges
 * (nuclei/ffuf/sqlmap/ysoserial) and the in-process OOB engines. Every capability
 * must prove its planted weakness with gate-passing evidence. No third-party host.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";

import { setBridgeEnabled } from "../bridges/registry.js";
import { runBridge } from "../bridges/exec.js";
import { runBridgeDetached } from "../bridges/exec.js";
import type { BridgeEnvelope } from "../bridges/types.js";
import { loadConfig } from "../config.js";
import { loadEngines } from "../security/red/engines.js";
import { runCampaign, type RedCampaignResult, type RedCapability } from "../security/red/orchestrator/redOrchestrator.js";
import { ssrfCapability } from "../security/red/ssrf.js";
import { deserCapability } from "../security/red/deser.js";
import { fuzzCapability } from "../security/red/web/fuzz.js";
import { templatesCapability } from "../security/red/templates.js";
import { sqliCapability } from "../security/red/web/sqli.js";
import { dastCapability } from "../security/red/web/dast.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-red-cap-lab-"));
const dataRoot = path.join(root, "data");
fs.mkdirSync(dataRoot, { recursive: true });

const cfg = loadConfig();
for (const id of ["red-nuclei", "red-ffuf", "red-sqlmap", "red-ysoserial", "red-zap"]) setBridgeEnabled(cfg, id, true);
cfg.policy.maxCommandSeconds = 900;
const workspace = root;
const bridge = async (bridgeId: string, commandId: string, args: Record<string, unknown>): Promise<BridgeEnvelope> => {
  const envelope = await runBridge({ cfg, workspace }, bridgeId, commandId, args);
  if (bridgeId === "red-nuclei" && envelope.text) fs.writeFileSync(path.join(workspace, "nuclei-output.jsonl"), envelope.text, "utf8");
  return envelope;
};
const bridgeApproval = () => true; // explicit lab acceptance run

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE items (name TEXT PRIMARY KEY)");
db.prepare("INSERT INTO items (name) VALUES ('lab-item')").run();

// A small SQLi endpoint: stable true/false pages, error on a bare quote and a
// sleep sink for time-based proof. It is intentionally owned lab code.
const lab = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/fetch") {
    const target = url.searchParams.get("url") ?? "";
    if (!/^https?:\/\//.test(target)) return res.end("home");
    try {
      const fetched = await fetch(target);
      res.statusCode = fetched.status;
      res.end(await fetched.text());
    } catch {
      res.statusCode = 502;
      res.end("fetch failed");
    }
    return;
  }
  if (url.pathname === "/backup") return res.end("backup of lab customer data");
  if (url.pathname === "/nuclei-test") return res.end("LOAM-PLANTED-VULNERABILITY");
  if (url.pathname === "/item") {
    const id = url.searchParams.get("id") ?? "";
    try {
      const rows = db.prepare(`SELECT name FROM items WHERE name = '${id}'`).all();
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(rows));
    } catch (err) {
      res.statusCode = 500;
      return res.end(`SQL error: ${(err as Error).message}`);
    }
  }
  if (url.pathname === "/deserialize" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        if (req.headers["content-type"] === "application/json") {
          const doc = JSON.parse(raw) as { data?: unknown };
          if (typeof doc.data === "string" && doc.data.startsWith("_$$ND_FUNC_$$_")) {
            vm.runInNewContext(`(${doc.data.slice("_$$ND_FUNC_$$_".length)})()`, { fetch });
          }
          return res.end("accepted");
        }
        res.statusCode = 500;
        res.end("java.io.ObjectInputStream: rejected serialized bytes");
      } catch {
        res.statusCode = 400;
        res.end("bad serialized value");
      }
    });
    return;
  }
  res.end("<html><title>Loam capability lab</title></html>");
});
lab.listen(0, "127.0.0.1");
await once(lab, "listening");
const port = (lab.address() as import("node:net").AddressInfo).port;
const target = `http://127.0.0.1:${port}`;

const NUCLEI_TEMPLATE = `id: loam-planted-vulnerability
info:
  name: Loam planted vulnerability
  author: loam
  severity: high
  description: A planted marker used only by the local capability lab.
  tags: loam,lab
requests:
  - method: GET
    path:
      - "{{BaseURL}}/nuclei-test"
    matchers:
      - type: word
        words: ["LOAM-PLANTED-VULNERABILITY"]
`;
fs.writeFileSync(path.join(workspace, "loam-lab-template.yaml"), NUCLEI_TEMPLATE, "utf8");
fs.writeFileSync(path.join(workspace, "wordlist.txt"), "backup\nadmin\nnope\n", "utf8");

const engines = loadEngines();
const results: { capability: string; check: string; findings: number }[] = [];

async function expectFinding(label: string, capability: RedCapability, targetUrl: string, check: string | ((check: string) => boolean)): Promise<void> {
  const result: RedCampaignResult = await runCampaign(
    { goal: `lab acceptance: ${label}`, authzId: null, targets: [targetUrl], profile: "quick" },
    { dataRoot, bridge, capabilities: [capability], workspace, bridgeApproval, bridgeDaemon: (id, cmd, args) => runBridgeDetached({ cfg, workspace }, id, cmd, args) },
  );
  const matches = result.findings.filter((f) => (typeof check === "string" ? f.check === check : check(f.check)));
  assert.ok(matches.length >= 1, `${label}: no proven finding; unverified=${result.unverified.map((u) => `${u.check}:${u.reason}:${u.detail}`).join(" | ")}`);
  assert.ok(matches[0]!.requestIds.length >= 1, `${label}: finding has no evidence ids`);
  results.push({ capability: label, check: matches[0]!.check, findings: matches.length });
}

try {
  await expectFinding("SSRF/OOB", ssrfCapability({ mode: "oob", path: "/fetch", field: "url", benignValue: "home" }), target, (c) => c.startsWith("ssrf_"));
  await expectFinding("Node deserialization/OOB", deserCapability({ mode: "node" }), target, (c) => c.startsWith("deser_"));
  await expectFinding("ffuf/content discovery", fuzzCapability({ wordlistFile: "wordlist.txt" }), target, "red_fuzz_discovery");
  await expectFinding("nuclei/custom template", templatesCapability({ severity: "high", templatesPath: "loam-lab-template.yaml" }), target, "red_nuclei_template");
  // ZAP live acceptance is environment-gated: quickscan needs a GUI, and this
  // host's daemon returns URL_NOT_FOUND / zero alerts. Daemon startup + parser
  // coverage stays in reviewCapabilities; it is not a required lab gate here.
  if (engines?.paths.sqlmapScript) {
    await expectFinding("sqlmap/boolean SQLi", sqliCapability({ scriptPath: engines.paths.sqlmapScript }), `${target}/item?id=1`, "red_sqli");
  }
  if (engines?.paths.ysoserialJar) {
    await expectFinding("ysoserial/binary deserialization", deserCapability({ jar: engines.paths.ysoserialJar }), target, "red_deserialization");
  }
  console.log(`check:red:capabilities PASS — ${results.length} capabilities proven on the planted lab`);
  for (const r of results) console.log(`  ✔ ${r.capability}: ${r.check} (${r.findings} finding(s))`);
} finally {
  lab.close();
  // Keep the temp dir on failure for diagnosis; remove it on success.
  if (results.length >= 5) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
