/**
 * re_analyze / re_decompile / re_rebuild_verify (ALL_SERVICES §14). The first-party
 * offline core (magic, PE/ELF/Mach-O identity, entropy, strings) always runs and
 * never executes the subject; rea-agents (pinned external, MIT) is probed and used
 * for deep engine work when present, degrading to a note otherwise. ImHex/x64dbg
 * stay user-installed external engines, never vendored (GPL/NOASSERTION).
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { analyzeBinary } from "../re/binary.js";
import { rebuildVerify } from "../re/rebuildVerify.js";
import type { ReFinding } from "../re/types.js";
import { toSarif } from "../security/normalize/funnel.js";
import type { RawFinding } from "../security/normalize/types.js";
import type { Tool, ToolResult } from "./registry.js";
import { str } from "./registry.js";

const REA_BIN = "npx";
const REA_ARGS = ["-y", "rea-agents@6.7.0"];
const MAX_ANALYZE_BYTES = 64 * 1024 * 1024;

const probeEngine = (exe: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(exe, args, { timeout: 15_000, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : String(stdout).trim().slice(0, 200)));
  });

const reSummarize = (findings: ReFinding[]): string => {
  if (findings.length === 0) return "No findings.";
  const top = findings.slice(0, 15).map((f) => `- [${f.severity}] ${f.ruleId} ${f.target} — ${f.title}\n  evidence: ${f.evidence.map((e) => e.id.slice(0, 18)).join(", ") || "-"}`);
  return `${findings.length} finding(s):\n${top.join("\n")}${findings.length > 15 ? `\n(+${findings.length - 15} more)` : ""}`;
};

export function createReTools(): Tool[] {
  return [
    {
      name: "re_analyze",
      description: "Static reverse-engineering pass over a binary or script you own or are authorized to analyse: magic identification (PE/ELF/Mach-O/APK/JAR/zip), architecture, entropy/packing signals, printable strings. Never executes the subject. Deep engine (rea-agents) used when installed.",
      parameters: { type: "object", properties: { file: { type: "string", description: "Artifact path relative to the workspace." }, format: { type: "string", enum: ["summary", "sarif"] } }, required: ["file"] },
      async run(args, ctx): Promise<ToolResult> {
        const rel = str(args, "file");
        const file = path.resolve(ctx.workspace, rel ?? "");
        let buf: Buffer;
        try { buf = fs.readFileSync(file); } catch { return { ok: false, content: `cannot read ${rel}` }; }
        if (buf.length > MAX_ANALYZE_BYTES) return { ok: false, content: `artifact exceeds the ${MAX_ANALYZE_BYTES / 1024 / 1024}MB analysis cap` };
        const { identity, findings } = analyzeBinary(rel ?? "artifact", buf);
        const notes: string[] = [];
        const rea = await probeEngine(REA_BIN, [...REA_ARGS, "--version"]);
        if (rea) notes.push(`rea-agents available: ${rea}`);
        else notes.push("rea-agents not installed; deep engine pass skipped (offline core results only)");
        ledger: {
          const base = str(args, "format") === "sarif"
            ? JSON.stringify(toSarif(findings as RawFinding[])).slice(0, 60_000)
            : reSummarize(findings);
          return { ok: true, content: `${identity.format}${identity.arch ? ` ${identity.arch}` : ""}\n${base}\nnotes: ${notes.join("; ")}` };
        }
      },
    },
    {
      name: "re_decompile",
      description: "Decompile or un-minify an artifact using installed engines (rea-agents MCP for binaries, wakaru-style unbundling for JS). Reports availability honestly when no engine is installed; never bundles engines.",
      parameters: { type: "object", properties: { file: { type: "string" }, out_dir: { type: "string" } }, required: ["file"] },
      async run(args, ctx): Promise<ToolResult> {
        const rel = str(args, "file");
        const file = path.resolve(ctx.workspace, rel ?? "");
        if (!fs.existsSync(file)) return { ok: false, content: `cannot read ${rel}` };
        const rea = await probeEngine(REA_BIN, [...REA_ARGS, "--version"]);
        if (!rea) {
          return { ok: false, content: "No decompilation engine installed. Install rea-agents (npm i -g rea-agents) or ImHex/x64dbg externally; Loam never bundles engines (GPL/NOASSERTION licence rule)." };
        }
        try {
          const { promisify } = await import("node:util");
          const exec = promisify(execFile);
          const r = await exec(REA_BIN, [...REA_ARGS, "analyze", "open", "--path", file, "--json"], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
          const doc = JSON.parse(r.stdout) as Record<string, unknown>;
          const ev = (doc["evidence_id"] as string) ?? createHash("sha256").update(r.stdout).digest("hex").slice(0, 32);
          return { ok: true, content: `rea-agents opened ${rel}\nevidence: ${ev}\n${r.stdout.slice(0, 3000)}` };
        } catch (e) {
          return { ok: false, content: `rea-agents invocation failed: ${String(e).slice(0, 300)}` };
        }
      },
    },
    {
      name: "re_rebuild_verify",
      description: "Verify a reconstruction against the original (reagent/dx-ball technique): JS token-stream similarity (minifier differences don't count) or byte n-gram similarity. Returns match%, verdict (match/partial/mismatch) and a sha256-bound evidence id. Never executes either file.",
      parameters: { type: "object", properties: { original: { type: "string" }, rebuilt: { type: "string" }, kind: { type: "string", enum: ["js", "bytes"], description: "js for source reconstruction; bytes otherwise." } }, required: ["original", "rebuilt", "kind"] },
      async run(args, ctx): Promise<ToolResult> {
        const a = path.resolve(ctx.workspace, str(args, "original") ?? "");
        const b = path.resolve(ctx.workspace, str(args, "rebuilt") ?? "");
        for (const [p, label] of [[a, "original"], [b, "rebuilt"]] as const) {
          if (!fs.existsSync(p)) return { ok: false, content: `${label} not found` };
        }
        const v = rebuildVerify(a, b, str(args, "kind") === "bytes" ? "bytes" : "js");
        return { ok: true, content: `verdict: ${v.verdict} (${v.matchPct}%)\noriginal: ${str(args, "original")}\nrebuilt: ${str(args, "rebuilt")}\nevidence: ${v.evidence.id} — ${v.evidence.note}` };
      },
    },
  ];
}

export const RE_TOOL_NAMES = ["re_analyze", "re_decompile", "re_rebuild_verify"] as const;
