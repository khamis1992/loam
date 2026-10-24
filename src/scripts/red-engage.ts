/**
 * Red-team engagement runner (RED_TEAM_BUILD_SPEC §6.13, §9 record-keeping).
 *
 * Runs a REAL gated campaign with the installed engines (nuclei/ffuf/sqlmap/
 * ysoserial + in-process SSRF) against an authorized target, writes the report
 * bundle and a durable engagement record under docs/red-team-engagements/, and
 * diffs against the previous engagement (retest semantics via compareFindings).
 *
 * Usage:
 *   npm run red:engage -- --target http://127.0.0.1:3000 [--target ...]
 *   options: --plan auto (model-driven planning), --authz AUTHZ-0001,
 *            --nuclei-tags cve, --severity low, --auth bearer:<tok>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { setBridgeEnabled } from "../bridges/registry.js";
import type { BridgeEnvelope } from "../bridges/types.js";
import { loadConfig } from "../config.js";
import { defaultRedCapabilities } from "../security/red/capabilities.js";
import { defaultDataRoot } from "../security/red/gate.js";
import { runCampaign } from "../security/red/orchestrator/redOrchestrator.js";
import { llmPlanner } from "../security/red/orchestrator/planner.js";
import { buildRedReport, retestRed } from "../security/red/report.js";
import { fuzzWordlistLines } from "../security/red/web/fuzz.js";
import { OllamaClient } from "../ollama.js";

const arg = (name: string, fallback?: string): string | undefined => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return fallback;
};

const targets = process.argv
  .slice(2)
  .reduce<string[]>((acc, cur, i, all) => (cur === "--target" && all[i + 1] ? [...acc, all[i + 1]!] : acc), []);
if (!targets.length) targets.push("http://127.0.0.1:3000");

const OUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", "docs", "red-team-engagements");
const WORKSPACE = path.join(os.tmpdir(), `loam-red-engage-${Date.now()}`);

interface EngagementRecord {
  id: string;
  at: string;
  targets: string[];
  planner: "rule" | "llm";
  engines: { id: string; status: string }[];
  findings: { check: string; severity: string; title: string; target: string; fingerprint: string }[];
  unverifiedCount: number;
  stats: { requestsSent: number; targetsProcessed: number; killed: boolean; aborted: string | null };
  retest?: { baselineId: string; new: string[]; persistent: string[]; notObserved: string[]; unverified: string[] };
  reportDir: string;
}

async function main(): Promise<void> {
  const plan = arg("plan", "off") === "auto" ? "llm" : "rule";
  const authzId = arg("authz") ?? null;
  const nucleiTags = arg("nuclei-tags");
  const severity = arg("severity", "low");
  const authRaw = arg("auth");
  const auth = authRaw?.startsWith("bearer:")
    ? { bearer: authRaw.slice("bearer:".length) }
    : authRaw?.startsWith("cookie:")
      ? { cookie: authRaw.slice("cookie:".length) }
      : undefined;

  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.mkdirSync(OUT_ROOT, { recursive: true });

  const cfg = loadConfig();
  // Session-scoped enablement of the red bridges (engagement only; the
  // durable config keeps them off until the user enables them in Settings).
  for (const id of ["red-nuclei", "red-ffuf", "red-sqlmap", "red-ysoserial", "red-zap", "red-caldera", "red-freeway"]) {
    setBridgeEnabled(cfg, id, true);
  }

  // ffuf needs a wordlist file inside the workspace.
  const wordlistFile = "red-ffuf-wordlist.txt";
  fs.writeFileSync(path.join(WORKSPACE, wordlistFile), fuzzWordlistLines().join("\n") + "\n", "utf8");

  const capabilities = await defaultRedCapabilities(cfg, { fuzzWordlistFile: wordlistFile, nucleiSeverity: severity, ...(nucleiTags ? { nucleiTags } : {}) });

  const engines = capabilities.map((c) => ({ id: c.id, status: "ready" }));

  const bridge = (bridgeId: string, commandId: string, args: Record<string, unknown>) =>
    import("../bridges/exec.js").then(({ runBridge }) =>
      runBridge({ cfg, workspace: WORKSPACE, signal: undefined, taskId: undefined }, bridgeId, commandId, args),
    ) as Promise<BridgeEnvelope>;

  // Model-driven planning is opt-in (--plan auto) and requires the local model.
  const planner =
    plan === "llm"
      ? llmPlanner(async (prompt) => {
          const client = new OllamaClient(cfg.ollamaUrl, cfg.cloudModel);
          const r = await client.chat({ model: "loam", messages: [{ role: "user", content: prompt }], temperature: 0.2, timeoutMs: 120_000 });
          return r.content;
        })
      : undefined;

  const result = await runCampaign(
    { goal: `Engagement ${new Date().toISOString()} on ${targets.join(", ")}`, authzId, targets, auth },
    { dataRoot: defaultDataRoot(), bridge, capabilities, ...(planner ? { planner } : {}) },
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const id = `ENG-${stamp}`;
  const outDir = path.join(OUT_ROOT, id);
  const report = buildRedReport(result, outDir);

  // Retest against the previous engagement record (spec §6.13 retest semantics).
  const previousPath = path.join(OUT_ROOT, "latest.json");
  let retest: EngagementRecord["retest"];
  if (fs.existsSync(previousPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(previousPath, "utf8")) as {
        id: string;
        coverage: string[];
        findings: Array<{ fingerprint: string; check: string; target: string; severity: string; title: string }>;
      };
      const baseline = {
        findings: prev.findings.map((f) => ({
          id: f.fingerprint,
          fingerprint: f.fingerprint,
          check: f.check,
          target: f.target,
          severity: f.severity as "critical" | "high" | "medium" | "low" | "info",
          title: f.title,
          verdict: "finding" as const,
          detail: "",
          requestIds: [],
          confidence: "observed" as const,
          workflow: { state: "open" as const, owner: "", note: "" },
        })),
        coverage: prev.coverage ?? [],
      };
      const diff = retestRed(prev.id, baseline, result);
      retest = { baselineId: prev.id, new: diff.new, persistent: diff.persistent, notObserved: diff.notObserved, unverified: diff.unverified };
    } catch {
      retest = undefined; // a torn baseline never blocks the record
    }
  }

  const record: EngagementRecord = {
    id,
    at: new Date().toISOString(),
    targets,
    planner: plan,
    engines,
    findings: result.findings.map((f) => ({ check: f.check, severity: f.severity, title: f.title, target: f.target, fingerprint: f.fingerprint })),
    unverifiedCount: result.unverified.length,
    stats: { requestsSent: result.stats.requestsSent, targetsProcessed: result.stats.targetsProcessed, killed: result.stats.killed, aborted: result.stats.aborted },
    ...(retest ? { retest } : {}),
    reportDir: path.relative(OUT_ROOT, outDir).replace(/\\/g, "/"),
  };
  fs.writeFileSync(path.join(outDir, "engagement.json"), JSON.stringify(record, null, 2), "utf8");
  fs.writeFileSync(previousPath, JSON.stringify({ id, findings: record.findings.map((f) => ({ fingerprint: f.fingerprint, verdict: "finding" })), coverage: result.coverage }, null, 2), "utf8");

  console.log(`\n=== red engagement ${id} ===`);
  console.log(`targets: ${targets.join(", ")}`);
  console.log(`capabilities: ${engines.map((e) => e.id).join(", ") || "(none — engines not installed)"}`);
  console.log(`findings: ${result.findings.length} proven, ${result.unverified.length} unverified, ${result.stats.requestsSent} gated request(s)`);
  for (const f of result.findings) console.log(`  * [${f.severity}] ${f.title} (${f.check}) @ ${f.target}`);
  if (retest) console.log(`retest vs ${retest.baselineId}: ${retest.new.length} new, ${retest.persistent.length} persistent, ${retest.notObserved.length} not observed`);
  console.log(`report: ${outDir}`);
  if (!result.findings.length && !engines.length) {
    console.log("\nnote: no engines were available — run `npm run red:engines` to install nuclei/ffuf/sqlmap/ysoserial.");
  }
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
}

main().catch((err: unknown) => {
  console.error(`red engage FAILED: ${(err as Error).message}`);
  process.exit(1);
});
