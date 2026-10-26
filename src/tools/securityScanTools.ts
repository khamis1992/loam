/**
 * Unified scanner surface (ALL_SERVICES §5-§12): deterministic scanners (§5-§9),
 * authorized recon (§10), LLM self-test (§11) and MCP/agent-tool scan (§12). Every
 * tool is read-only, funnels its engine's output through src/security/normalize into
 * the one findings shape, and returns a bounded summary (counts + top findings);
 * `format: "sarif"` returns the merged SARIF document instead. External engines
 * (opengrep, checkov) run through the pinned audit adapters and degrade to a note
 * when absent.
 */
import fs from "node:fs";
import path from "node:path";
import { toSarif } from "../security/normalize/funnel.js";
import type { RawFinding } from "../security/normalize/types.js";
import { CoverageLedger } from "../security/coverage/ledger.js";
import { taintScan, changedFiles } from "../security/sast/scan.js";
import { roastDockerfile } from "../security/config/dockerfile.js";
import { discover } from "../security/native/sca/lockfiles.js";
import { sbomDigest, toCycloneDx } from "../security/native/sca/sbom.js";
import { runScaScan } from "../security/native/sca/osvClient.js";
import { runSecretsScan } from "../security/native/secrets/index.js";
import { runPkgIntel } from "../security/native/pkgintel/index.js";
import { diffCapabilities } from "../security/native/pkgintel/capdiff.js";
import type { ManifestShape } from "../security/native/pkgintel/capdiff.js";
import { hitsNormalizer } from "../security/normalize/adapters/hits.js";
import { runScanners } from "../security/audit/scanners.js";
import type { Exec } from "../security/audit/scanners.js";
import { scanTelemetry } from "../security/telemetry.js";
import { distillSkill } from "../security/selfharden.js";
import { contextPackEnabled, packContext } from "../security/contextPack.js";
import { llmTriage } from "../security/sast/scan.js";
import { score as benchScore } from "../security/bench/score.js";
import { assertAuthorizedScope, ScopeError } from "../security/recon/scope.js";
import { runBattery } from "../security/llm/probes.js";
import { scanBridgeManifest, scanMcpServerConfig, scanSkillDocument } from "../security/mcp/scan.js";
import type { BridgeManifestShape, McpServerConfigShape } from "../security/mcp/scan.js";
import type { OllamaClient } from "../ollama.js";
import type { Tool, ToolResult } from "./registry.js";
import { str } from "./registry.js";

const SEV_ORDER = ["critical", "high", "medium", "low", "info"] as const;

export function summarizeFindings(raws: RawFinding[], cap = 20): string {
  if (raws.length === 0) return "No findings.";
  const bySev: Record<string, number> = {};
  for (const r of raws) bySev[r.severity] = (bySev[r.severity] ?? 0) + 1;
  const counts = SEV_ORDER.filter((s) => bySev[s]).map((s) => `${bySev[s]} ${s}`).join(", ");
  const top = [...raws]
    .sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity))
    .slice(0, cap)
    .map((r) => `- [${r.severity}] ${r.engine}:${r.ruleId} ${r.target} — ${r.title}`);
  return `${raws.length} finding(s): ${counts}\n${top.join("\n")}${raws.length > cap ? `\n(+${raws.length - cap} more)` : ""}`;
}

const ledgerNote = (ledger: CoverageLedger): string =>
  `coverage: ${ledger.entries().map((e) => `${e.check}=${e.status}`).join(", ") || "none"}`;

const resolveTarget = (args: Record<string, unknown>, workspace: string): string => {
  const raw = str(args, "target");
  return path.resolve(workspace, raw || ".");
};

/** Run the external audit adapters for a tool set and normalize their hits. */
async function externalHits(tools: string[], target: string, exec?: Exec): Promise<{ raws: RawFinding[]; notes: string[] }> {
  const scratch = path.join(target, ".loam-scan-scratch");
  try {
    const out = await runScanners({ target, scratch, tools, ...(exec ? { exec } : {}) });
    const raws = hitsNormalizer.adapt(out.hits);
    const notes = out.reports.filter((r) => r.status !== "ok" && r.status !== "skipped").map((r) => `${r.tool}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`);
    return { raws, notes };
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export function createSecurityScanTools(deps: { ollama?: OllamaClient } = {}): Tool[] {
  const ledger = new CoverageLedger();

  const mk = (name: string, description: string, parameters: Record<string, unknown>, run: (args: Record<string, unknown>, workspace: string) => Promise<ToolResult>): Tool => ({
    name, description, parameters,
    async run(args: Record<string, unknown>, ctx): Promise<ToolResult> {
      const started = Date.now();
      const target = String(str(args, "target") ?? ctx.workspace).slice(0, 120);
      try {
        const r = await run(args, ctx.workspace);
        const count = Number(/^(\d+) finding/.exec(r.content)?.[1] ?? 0);
        scanTelemetry.record({ at: new Date().toISOString(), scan: name, target, durationMs: Date.now() - started, findings: count });
        return r;
      } catch (e) {
        scanTelemetry.record({ at: new Date().toISOString(), scan: name, target, durationMs: Date.now() - started, findings: 0, budgetHit: String(e).slice(0, 80) });
        return { ok: false, content: `${name} failed: ${String(e).slice(0, 300)}` };
      }
    },
  });

  const wantSarif = (args: Record<string, unknown>, raws: RawFinding[]): ToolResult =>
    str(args, "format") === "sarif"
      ? { ok: true, content: JSON.stringify(toSarif(raws)).slice(0, 60_000) }
      : { ok: true, content: summarizeFindings(raws) };

  return [
    mk("secrets_scan",
      "Scan a directory (and optionally its git history) for hard-coded secrets: AI-platform keys, cloud credentials, private keys, and credentials in prompt/skill/config assets. Values are never printed.",
      { type: "object", properties: { target: { type: "string", description: "Directory to scan. Defaults to the workspace." }, git_history: { type: "boolean", description: "Also scan committed history (default false)." }, format: { type: "string", enum: ["summary", "sarif"] } } },
      async (args, ws) => {
        const target = resolveTarget(args, ws);
        const r = runSecretsScan(target);
        const raws = hitsNormalizer.adapt(r.hits);
        ledger.recordScan(target, "secrets", { hitCount: raws.length });
        return wantSarif(args, raws);
      }),

    mk("sca_scan",
      "Match pinned dependencies (lockfiles/SBOMs) against OSV advisories and enrich with real-world signals (CISA KEV, EPSS, composite risk). Needs network for OSV; degrades with a note when offline.",
      { type: "object", properties: { target: { type: "string", description: "Project directory. Defaults to the workspace." }, format: { type: "string", enum: ["summary", "sarif"] } } },
      async (args, ws) => {
        const target = resolveTarget(args, ws);
        const r = await runScaScan(target);
        const raws = hitsNormalizer.adapt(r.hits);
        ledger.recordScan(target, "sca", { hitCount: raws.length, notes: r.notes, error: r.error });
        const notes = [...(r.error ? [r.error] : []), ...(r.notes ?? [])];
        return { ...wantSarif(args, raws), content: `${wantSarif(args, raws).content}${notes.length ? `\nnotes: ${notes.join("; ")}` : ""}` };
      }),

    mk("sbom_generate",
      "Generate a CycloneDX 1.5 SBOM from the project's lockfiles/manifests (offline, first-party) and return its digest and component counts.",
      { type: "object", properties: { target: { type: "string", description: "Project directory. Defaults to the workspace." }, format: { type: "string", enum: ["summary", "json"] } } },
      async (args, ws) => {
        const target = resolveTarget(args, ws);
        const found = discover(target);
        const doc = toCycloneDx(found.pkgs, { name: path.basename(target) });
        ledger.recordScan(target, "sbom", { hitCount: found.pkgs.length, notes: found.unsupported ? [`${found.unsupported} unsupported purl types skipped`] : [] });
        if (str(args, "format") === "json") return { ok: true, content: JSON.stringify(doc).slice(0, 60_000) };
        const byEco: Record<string, number> = {};
        for (const p of found.pkgs) byEco[p.ecosystem] = (byEco[p.ecosystem] ?? 0) + 1;
        return { ok: true, content: `SBOM: ${found.pkgs.length} components (${Object.entries(byEco).map(([k, v]) => `${v} ${k}`).join(", ")})\ndigest: ${sbomDigest(found.pkgs)}\nunsupported purls skipped: ${found.unsupported}` };
      }),

    mk("sast_scan",
      "Static analysis: first-party interprocedural taint pass (sources→sinks across calls) plus the opengrep rule pack when the engine is installed. Optional diff scope and advisory LLM triage are separate tools/flags.",
      { type: "object", properties: { target: { type: "string", description: "Directory to scan. Defaults to the workspace." }, taint: { type: "boolean", description: "Run the taint pass (default true)." }, opengrep: { type: "boolean", description: "Also run opengrep rules if installed (default true)." }, format: { type: "string", enum: ["summary", "sarif"] } } },
      async (args, ws) => {
        const target = resolveTarget(args, ws);
        const raws: RawFinding[] = [];
        const notes: string[] = [];
        if (args["taint"] !== false) {
          const t = taintScan(target);
          raws.push(...t.findings);
          if (t.coverage.bounded) notes.push("taint pass hit the file-scan limit (partial)");
          ledger.recordScan(target, "taint", { hitCount: t.findings.length, ...(t.coverage.bounded ? { notes: ["bounded"] } : {}) });
        }
        if (args["opengrep"] !== false) {
          const ext = await externalHits(["opengrep"], target);
          raws.push(...ext.raws);
          notes.push(...ext.notes);
          ledger.recordScan(target, "opengrep", { hitCount: ext.raws.length, error: ext.notes[0] });
        }
        // Advisory LLM triage (agentgg graft): flag-gated context packing (repomix
        // technique) feeds the classifier; a hit is never dropped, only annotated.
        if (contextPackEnabled() && deps.ollama && raws.length > 0) {
          try {
            const packed = packContext({ root: target }).text.slice(0, 2000);
            const triaged = await llmTriage(raws, async (hit) => {
              const r = await deps.ollama!.chat({ model: "loam", timeoutMs: 30_000, messages: [
                { role: "user", content: `Codebase context (packed):\n${packed}\n\nSecurity finding: ${hit.title} at ${hit.target} (${hit.detail.slice(0, 300)}). Reply with exactly one word: likely | unlikely | needs-review.` },
              ] });
              const v = String(typeof r.content === "string" ? r.content : "").toLowerCase();
              return { verdict: v.includes("unlikely") ? "unlikely" : v.includes("likely") ? "likely" : "needs-review", rationale: v.slice(0, 120) };
            });
            raws.splice(0, raws.length, ...triaged);
            notes.push("llm triage: advisory annotations applied (LOAM_CONTEXT_PACK)");
          } catch (e) { notes.push(`llm triage skipped: ${String(e).slice(0, 100)}`); }
        }
        const base = wantSarif(args, raws);
        return { ...base, content: `${base.content}${notes.length ? `\nnotes: ${notes.join("; ")}` : ""}` };
      }),

    mk("sast_diff",
      "Diff-scoped review (ccsr technique): taint + rule findings limited to the files changed in a git ref range (e.g. main...HEAD).",
      { type: "object", properties: { target: { type: "string", description: "Repo directory. Defaults to the workspace." }, ref_range: { type: "string", description: "git ref range, e.g. main...HEAD" }, format: { type: "string", enum: ["summary", "sarif"] } } },
      async (args, ws) => {
        const target = resolveTarget(args, ws);
        const range = str(args, "ref_range") || "HEAD~1...HEAD";
        const changed = changedFiles(target, range);
        if (changed.length === 0) return { ok: true, content: `No changed files in ${range} (or not a git repo).` };
        const changedSet = new Set(changed.map((c) => c.replace(/\\/g, "/")));
        const t = taintScan(target);
        const raws = t.findings.filter((f) => changedSet.has(f.target.split(":")[0]!));
        const ext = await externalHits(["opengrep"], target);
        raws.push(...ext.raws.filter((f) => changedSet.has(f.target.split(":")[0]!)));
        ledger.recordScan(target, `sast-diff:${range}`, { hitCount: raws.length });
        const base = wantSarif(args, raws);
        return { ...base, content: `scope: ${changed.length} changed file(s) in ${range}\n${base.content}` };
      }),

    mk("config_scan",
      "IaC + container posture: first-party Dockerfile critique plus the checkov policy pack when installed (Terraform/K8s/CloudFormation).",
      { type: "object", properties: { target: { type: "string", description: "Directory to scan. Defaults to the workspace." }, format: { type: "string", enum: ["summary", "sarif"] } } },
      async (args, ws) => {
        const target = resolveTarget(args, ws);
        const raws: RawFinding[] = [];
        const notes: string[] = [];
        const dockerfiles = collectDockerfiles(target);
        for (const df of dockerfiles) {
          try { raws.push(...roastDockerfile(fs.readFileSync(df, "utf8"), path.relative(target, df).replace(/\\/g, "/"))); } catch { /* unreadable */ }
        }
        ledger.recordScan(target, "dockerfile", { hitCount: raws.length, notes: dockerfiles.length === 0 ? ["no Dockerfile found"] : [] });
        const ext = await externalHits(["checkov"], target);
        raws.push(...ext.raws);
        notes.push(...ext.notes);
        ledger.recordScan(target, "checkov", { hitCount: ext.raws.length, error: ext.notes[0], skipped: ext.raws.length === 0 && ext.notes.length === 0 });
        const base = wantSarif(args, raws);
        return { ...base, content: `${base.content}${notes.length ? `\nnotes: ${notes.join("; ")}` : ""}\n${ledgerNote(ledger)}` };
      }),

    mk("supplychain_scan",
      "Package/skill trust signals: malicious-package heuristics (install hooks, bundled executables, URL deps, typosquats) plus an offline capability-diff against a previous manifest when supplied.",
      { type: "object", properties: { target: { type: "string", description: "Project directory. Defaults to the workspace." }, prev_manifest: { type: "string", description: "Path to the previous package.json for a capability diff." }, format: { type: "string", enum: ["summary", "sarif"] } } },
      async (args, ws) => {
        const target = resolveTarget(args, ws);
        const raws = hitsNormalizer.adapt(runPkgIntel(target));
        const notes: string[] = [];
        const prev = str(args, "prev_manifest");
        if (prev) {
          try {
            const before = JSON.parse(fs.readFileSync(path.resolve(ws, prev), "utf8")) as ManifestShape;
            const after = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")) as ManifestShape;
            for (const d of diffCapabilities(before, after)) {
              raws.push({ engine: "supplychain", ruleId: `capdiff:${d.kind}`, severity: d.kind === "new-install-hook" || d.kind === "native-build" ? "high" : "medium", target: `${after.name ?? "package"}@${after.version ?? "?"}`, title: `Update grants new capability: ${d.kind}`, detail: d.detail });
            }
          } catch (e) { notes.push(`capdiff skipped: ${String(e).slice(0, 120)}`); }
        }
        ledger.recordScan(target, "supplychain", { hitCount: raws.length, notes });
        const base = wantSarif(args, raws);
        return { ...base, content: `${base.content}${notes.length ? `\nnotes: ${notes.join("; ")}` : ""}` };
      }),
    mk("recon_scan",
      "Authorized-scope HTTP fingerprint of assets you own. Loopback-only by construction; a non-loopback target is refused unless the deployment supplies an explicit grant. Returns asset summaries (status, server, title) and findings for notable exposure.",
      { type: "object", properties: { targets: { type: "array", items: { type: "string" }, description: "http(s) URLs to fingerprint (loopback only)." }, format: { type: "string", enum: ["summary", "sarif"] } }, required: ["targets"] },
      async (args, ws) => {
        void ws;
        const raws: RawFinding[] = [];
        const lines: string[] = [];
        const targets = Array.isArray(args["targets"]) ? (args["targets"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
        if (targets.length === 0) return { ok: false, content: "targets must be a non-empty array of URLs." };
        for (const t of targets.slice(0, 10)) {
          let url: URL;
          try { url = assertAuthorizedScope(t); } catch (e) {
            if (e instanceof ScopeError) return { ok: false, content: `REFUSED — ${e.message}` };
            throw e;
          }
          try {
            const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "user-agent": "loam-recon/1" } });
            const server = res.headers.get("server") ?? "-";
            const title = /<title[^>]*>([^<]{0,120})/i.exec((await res.text()).slice(0, 4000))?.[1]?.trim() ?? "-";
            lines.push(`${url.host}${url.pathname} → ${res.status} server=${server} title=${JSON.stringify(title)}`);
            if (server !== "-") raws.push({ engine: "recon", ruleId: "server-banner", severity: "info", target: url.host, title: "Server banner disclosed", detail: `server: ${server}`, properties: { status: res.status } });
          } catch (e) {
            raws.push({ engine: "recon", ruleId: "probe-error", severity: "info", target: url.host, title: "Host unreachable", detail: String(e).slice(0, 120) });
            lines.push(`${url.host}${url.pathname} → unreachable`);
          }
        }
        ledger.recordScan("recon", "httpx", { hitCount: raws.length });
        const base = wantSarif(args, raws);
        return { ...base, content: `${lines.join("\n")}\n${base.content}` };
      }),

    mk("llm_scan",
      "Run the offline LLM self-test battery (instruction-override, tool-misuse, data-leak, persona probes) against the configured model. Reports failures as findings for the self-hardening loop.",
      { type: "object", properties: { model: { type: "string", description: "Model name for the chat endpoint (optional)." }, format: { type: "string", enum: ["summary", "sarif"] } } },
      async (args, ws) => {
        void ws;
        if (!deps.ollama) return { ok: false, content: "No model endpoint configured for the self-test battery." };
        const model = str(args, "model") || "loam";
        const { runs, findings } = await runBattery(async (prompt) => {
          const r = await deps.ollama!.chat({ model, messages: [{ role: "user", content: prompt }], timeoutMs: 30_000 });
          return typeof r.content === "string" ? r.content : JSON.stringify(r.content);
        });
        ledger.recordScan("llm", "selftest", { hitCount: findings.length });
        const pass = runs.filter((r) => r.passed).length;
        const base = wantSarif(args, findings);
        const battery = benchScore("llm-selftest", runs.map((r) => ({ id: r.caseId, expected: "benign" as const, actual: (r.passed ? "clean" : "finding") as "finding" | "clean" })));
        const lesson = distillSkill({
          goal: "Harden Loam against the LLM self-test battery",
          outcome: findings.length === 0 ? "success" : "partial",
          steps: runs.map((r) => ({ tool: `probe:${r.kind}`, summary: r.passed ? "passed" : r.replyExcerpt })),
        });
        return { ...base, content: `self-test: ${pass}/${runs.length} probes passed (battery: precision ${battery.precision}, recall ${battery.recall}, youdenJ ${battery.youdenJ})\n${base.content}${lesson ? `\nlesson candidate: ${lesson.slug} (review + supply-chain scan before activation)` : ""}` };
      }),

    mk("mcp_scan",
      "Scan Loam's own agent-tool surface offline: bridge manifests (over-broad/under-declared effects, unpinned), skills (injection sinks in SKILL.md), and configured MCP servers (shell commands, inline secrets, non-loopback URLs).",
      { type: "object", properties: { format: { type: "string", enum: ["summary", "sarif"] } } },
      async (args, ws) => {
        const raws: RawFinding[] = [];
        const notes: string[] = [];
        try {
          const { BUILTIN_MANIFESTS } = await import("../bridges/builtin.js");
          for (const m of BUILTIN_MANIFESTS as BridgeManifestShape[]) raws.push(...scanBridgeManifest(m, `bridges:${m.id ?? "?"}`));
        } catch { notes.push("bridge manifests unreadable"); }
        const skillsRoots = [path.resolve(ws, "skills"), path.join(process.cwd(), "skills")];
        let skills = 0;
        for (const root of skillsRoots) {
          try {
            for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
              if (!dir.isDirectory()) continue;
              const skill = path.join(root, dir.name, "SKILL.md");
              try { raws.push(...scanSkillDocument(fs.readFileSync(skill, "utf8"), `${dir.name}/SKILL.md`)); skills++; } catch { /* absent */ }
            }
          } catch { /* no skills dir */ }
        }
        notes.push(`${skills} skill(s) scanned`);
        const cfgPath = path.resolve(ws, "config.json");
        try {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as { mcpServers?: Record<string, McpServerConfigShape> };
          for (const [name, server] of Object.entries(cfg.mcpServers ?? {})) raws.push(...scanMcpServerConfig(name, server, "config.json"));
        } catch { notes.push("no local config.json mcpServers"); }
        ledger.recordScan("loam", "mcp-surface", { hitCount: raws.length, notes });
        const base = wantSarif(args, raws);
        return { ...base, content: `${base.content}\n${notes.join("; ")}` };
      }),
  ];
}

function collectDockerfiles(root: string, cap = 50): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", "release", "vendor", ".venv"]);
  const walk = (dir: string): void => {
    if (out.length >= cap) return;
    let es: fs.Dirent[] = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (out.length >= cap) return;
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(path.join(dir, e.name)); continue; }
      if (/^Dockerfile(\.\w+)?$/i.test(e.name)) out.push(path.join(dir, e.name));
    }
  };
  walk(root);
  return out;
}

export const SECURITY_SCAN_TOOL_NAMES = ["secrets_scan", "sca_scan", "sbom_generate", "sast_scan", "sast_diff", "config_scan", "supplychain_scan", "recon_scan", "llm_scan", "mcp_scan"] as const;
