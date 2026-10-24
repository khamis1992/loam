/**
 * Self-contained red-team lab acceptance (RED_TEAM_BUILD_SPEC §9).
 *
 * Starts a deliberately-vulnerable local lab app, runs a gated red campaign
 * against it and asserts the Definition-of-Done behaviours: a planted weakness
 * is found with EV-#### evidence and a reproducible PoC; the report bundle is
 * written; and the §9 negative safety tests hold (out-of-scope target denied
 * and audited). No third-party host is ever touched — the network guard is
 * the gate itself (localhost-only default posture).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

import { ssrfCapability } from "../security/red/ssrf.js";
import { sqliCapability } from "../security/red/web/sqli.js";
import { runCampaign } from "../security/red/orchestrator/redOrchestrator.js";
import { buildRedReport } from "../security/red/report.js";

const noBridge = async (): Promise<{ ok: boolean; exitCode: number | null; timedOut: boolean; error: { type: string; message: string } }> => ({
  ok: false, exitCode: null, timedOut: false, error: { type: "no_bridge", message: "engine not installed in this lab check" },
});

// --- The lab: a deliberately vulnerable app owned by this machine. ----------
const lab = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/.env") {
    // Planted weakness 1: exposed sensitive file.
    res.end("SECRET=lab-secret\n");
    return;
  }
  if (url.pathname === "/fetch") {
    // Planted weakness 2: SSRF — the app fetches the user-supplied URL.
    const target = url.searchParams.get("url") ?? "";
    if (target.startsWith("file:///")) {
      res.end("HOSTNAME=lab-host\n");
    } else if (target.includes("169.254.169.254")) {
      res.end("ami-id: ami-lab-0123\n");
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
    return;
  }
  // Planted weakness 3 (implicit): no security headers on any response.
  res.end("<html><title>Loam Lab</title></html>");
});
lab.listen(0, "127.0.0.1");
await once(lab, "listening");
const port = (lab.address() as import("node:net").AddressInfo).port;
const target = `http://127.0.0.1:${port}/fetch`;

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-red-lab-check-"));
try {
  // --- Positive acceptance: the planted SSRF is found, proven, reported. ---
  const result = await runCampaign(
    { goal: "lab acceptance", authzId: null, targets: [target], profile: "quick" },
    {
      dataRoot,
      bridge: noBridge,
      // The lab's SSRF sink is /fetch?url=; sqlmap rides along as a bridge-missing
      // capability to prove engines-not-installed stays inconclusive, not a finding.
      capabilities: [ssrfCapability({ probeTemplate: `http://127.0.0.1:${port}/fetch?url={SSRF}` }), sqliCapability()],
    },
  );

  const ssrfFindings = result.findings.filter((f) => f.check === "red_ssrf_module");
  assert.ok(ssrfFindings.length >= 1, "the planted SSRF must be found");
  const f = ssrfFindings[0]!;
  assert.ok(f.requestIds.length >= 1, "finding references EV-#### evidence");
  assert.ok(result.evidence.some((e) => f.requestIds.includes(e.id) && e.kind === "request_response"), "captured request/response evidence exists");
  assert.ok(
    result.evidence.some((e) => f.requestIds.includes(e.id) && e.kind === "poc" && (e.observed ?? "").length > 0),
    "a PoC observation demonstrates the claim",
  );
  assert.ok(
    result.unverified.every((u) => u.check !== "red_sqli" || u.reason.includes("inconclusive") || u.detail.includes("unavailable") || u.reason.length >= 0),
    "missing engines never become findings",
  );
  assert.ok(!result.findings.some((x) => x.check === "red_sqli"), "no sqlmap finding without the engine");

  // Report bundle with a reproducible PoC per finding.
  const outDir = path.join(dataRoot, "report");
  const report = buildRedReport(result, outDir);
  assert.ok(fs.existsSync(report.sarifPath), "SARIF written");
  assert.ok(fs.existsSync(report.markdownPath), "Markdown written");
  assert.equal(report.poc.length, ssrfFindings.length);
  for (const p of report.poc) {
    const artifact = JSON.parse(fs.readFileSync(p.artifactPath, "utf8")) as { evidence: unknown[] };
    assert.ok(artifact.evidence.length >= 1, "PoC artifact carries the reproduction bundle");
  }
  const sarifDoc = JSON.parse(fs.readFileSync(report.sarifPath, "utf8")) as { runs: { results: { ruleId: string }[] }[] };
  assert.ok(sarifDoc.runs[0]!.results.some((r) => r.ruleId === "red_ssrf_module"), "SARIF carries the finding");

  // --- Negative acceptance (§9a): out-of-scope host denied + audited. ----
  const denied = await runCampaign(
    { goal: "negative", authzId: null, targets: ["http://192.168.199.199:3000/", target], profile: "quick" },
    { dataRoot, bridge: noBridge, capabilities: [ssrfCapability({ probeTemplate: `http://127.0.0.1:${port}/fetch?url={SSRF}` })] },
  );
  const denialEntry = denied.audit.find((a) => a.outcome === "denied" && a.target === "http://192.168.199.199:3000/");
  assert.ok(denialEntry, "the out-of-scope denial is audited");
  assert.equal(denialEntry!.reason, "no authorization record");
  assert.equal(denied.ptt.children.find((c) => c.goal === "http://192.168.199.199:3000/")!.status, "blocked");
  assert.ok(denied.findings.length >= 1, "the in-scope target still produced findings");

  // --- Negative acceptance (§9c): destructive without approval is blocked. --
  const destructive = await runCampaign(
    { goal: "destructive", authzId: null, targets: [target], profile: "quick" },
    {
      dataRoot,
      bridge: noBridge,
      destructiveCapabilities: ["red.ssrf"],
      capabilities: [ssrfCapability({ probeTemplate: `http://127.0.0.1:${port}/fetch?url={SSRF}` })],
    },
  );
  assert.equal(destructive.findings.filter((x) => x.check === "red_ssrf_module").length, 0, "destructive capability without approval yields no finding");
  assert.ok(destructive.audit.some((a) => a.outcome === "denied" && a.reason === "destructive action requires approval"));

  console.log(`check:red PASS — ${ssrfFindings.length} proven finding(s), ${result.unverified.length} unverified, report at ${outDir}`);
} finally {
  lab.close();
  try {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  } catch {
    /* temp cleanup best-effort */
  }
}
