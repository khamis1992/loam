/** check:security-asar — per-release ASAR surface self-audit
 *  (REA_INTO_LOAM_INTEGRATION §10, OD-4; joins verify:security automatically).
 *
 *  Analyzes the packaged app's asar with the pinned REA server, projects the stable
 *  surface (IPC channels, contextBridge keys, preload entrypoints, endpoints), and
 *  diffs it against qa/asar-baseline.json. New surface outside the reviewed allowlist
 *  (qa/asar-baseline-allowlist.json) WARNs by default and FAILS once
 *  LOAM_ASAR_AUDIT=fail (flip after the first release, OD-4). Best-effort static (U4):
 *  removals are reported, never fatal. Subject asar is analyzed, never executed. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolRegistry } from "../tools/registry.js";
import { registerMcpTools } from "../tools/mcp.js";
import { REA_VERSION_PIN } from "../tools/reaAllowlist.js";
import { ReaAuditLog, reaAuditPath } from "../tools/reaAudit.js";
import type { ReaEvidenceRecord } from "../security/reaEvidence.js";
import { diffAsarSurface, extractAsarSurface, hasSurfaceAdditions, unexplainedAdditions, type AsarSurface } from "../security/reaAsarSurface.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const target = process.env.LOAM_ASAR_TARGET ?? path.join(ROOT_DIR, "release", "win-unpacked", "resources", "app.asar");
const baselineFile = path.join(ROOT_DIR, "qa", "asar-baseline.json");
const allowlistFile = path.join(ROOT_DIR, "qa", "asar-baseline-allowlist.json");
const mode = process.env.LOAM_ASAR_AUDIT === "fail" ? "fail" : "warn";
const dataDir = process.env.MANUS_LOCAL_DATA_DIR || process.env.LOAM_DATA_DIR || path.join(ROOT_DIR, "data");
const serverEntry = path.join(dataDir, "bin", "rea-agents", REA_VERSION_PIN, "node_modules", "rea-agents", "scripts", "rea.mjs");
const audit = new ReaAuditLog(reaAuditPath(dataDir));

const readAllowlist = () => {
  try { return JSON.parse(fs.readFileSync(allowlistFile, "utf8")) as Record<string, string[]>; } catch { return {}; }
};

async function main(): Promise<number> {
  if (!fs.existsSync(target)) {
    console.log(`SKIP: no packaged asar at ${target} (set LOAM_ASAR_TARGET or run npm run dist first; the release lane re-runs this gate)`);
    audit.append({ name: "rea.asar.audit", outcome: "skipped", target, detail: "no target" });
    return 0;
  }
  if (!fs.existsSync(serverEntry)) {
    if (mode === "fail") {
      console.error(`FAIL: LOAM_ASAR_AUDIT=fail demands the pinned server — run node scripts/install-rea-agents.mjs`);
      return 1;
    }
    console.log(`SKIP: pinned rea-agents@${REA_VERSION_PIN} not installed (${serverEntry})`);
    audit.append({ name: "rea.asar.audit", outcome: "skipped", target, detail: "server not installed" });
    return 0;
  }

  const registry = new ToolRegistry();
  const toolset = await registerMcpTools(registry, {
    rea: { command: "node", args: [serverEntry, "mcp"], env: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" } },
  }, ROOT_DIR);
  try {
    if (!toolset.servers.includes("rea")) {
      if (mode === "fail") { console.error("FAIL: rea MCP server failed to start"); return 1; }
      console.log("SKIP: rea MCP server failed to start (see warnings above)");
      audit.append({ name: "rea.mcp.connect", outcome: "failed" });
      return 0;
    }
    audit.append({ name: "rea.mcp.connect", outcome: "completed", tool: "server" });

    const started = Date.now();
    const analyze = await toolset.callTool("rea", "analyze_javascript_application", { input_path: target, detail: "summary" }, 120_000);
    if (!analyze.ok) {
      audit.append({ name: "rea.asar.audit", outcome: "failed", target, durationMs: Date.now() - started, detail: analyze.content.slice(0, 200) });
      if (mode === "fail") { console.error(`FAIL: analysis failed: ${analyze.content.slice(0, 300)}`); return 1; }
      console.log(`WARN: analysis failed (${analyze.content.slice(0, 200)}); gate stays green in warn mode`);
      return 0;
    }

    const bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rea-asar-")), "bundle.json");
    const exported = await toolset.callTool("rea", "export_evidence_bundle", { path: bundlePath, overwrite: true }, 30_000);
    if (!exported.ok) throw new Error(`export failed: ${exported.content.slice(0, 200)}`);
    const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8")) as { records?: ReaEvidenceRecord[] };
    const record = (bundle.records ?? []).find((r) => r.operation === "analyze_javascript_application");
    if (!record) throw new Error("analyze record missing from exported bundle");
    const surface = extractAsarSurface(record);
    audit.append({ name: "rea.asar.audit", outcome: "completed", target, contentDigest: surface.contentDigest, durationMs: Date.now() - started, detail: `mode=${mode}` });

    if (!fs.existsSync(baselineFile)) {
      const { version } = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8")) as { version: string };
      fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
      fs.writeFileSync(baselineFile, JSON.stringify({ loamVersion: version, generatedAt: new Date().toISOString(), surface }, null, 2) + "\n");
      console.log(`PASS: BASELINE CREATED at ${baselineFile} (digest ${surface.contentDigest.slice(0, 18)}…, ${surface.ipcChannels.length} IPC channels). Next diffs run against it.`);
      return 0;
    }

    const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8")) as { surface: AsarSurface };
    const delta = unexplainedAdditions(diffAsarSurface(baseline.surface, surface), readAllowlist());
    const summary = `ipc+${delta.addedIpcChannels.join(",") || "-"} bridge+${delta.addedContextBridgeKeys.join(",") || "-"} preload+${delta.addedPreloadEntryPoints.join(",") || "-"} endpoint+${delta.addedHardcodedEndpoints.join(",") || "-"} (removed ipc: ${delta.removedIpcChannels.join(",") || "-"})`;
    if (!hasSurfaceAdditions(delta)) {
      console.log(`PASS: asar surface unchanged vs baseline (${surface.ipcChannels.length} IPC channels, ${surface.contextBridgeKeys.length} bridge keys, digest ${surface.contentDigest.slice(0, 18)}…)`);
      return 0;
    }
    if (mode === "fail") {
      console.error(`FAIL: new asar surface outside the reviewed allowlist — ${summary}`);
      console.error(`     If intended: add the entries to qa/asar-baseline-allowlist.json and refresh the baseline in the same PR.`);
      return 1;
    }
    console.log(`WARN: new asar surface detected — ${summary} (warn mode; LOAM_ASAR_AUDIT=fail blocks this)`);
    return 0;
  } finally {
    await toolset.close();
    audit.append({ name: "rea.mcp.disconnect", outcome: "completed" });
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
