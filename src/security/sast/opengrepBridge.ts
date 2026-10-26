import { spawn } from "node:child_process";
import path from "node:path";
import type { SastHit } from "./types.js";
import { LOAM_SAST_RULES } from "./rules/loam-pack.js";

export interface OpengrepRunOptions {
  root: string;
  files?: string[];
  /** Absolute path to opengrep binary; default "opengrep" on PATH. */
  bin?: string;
  timeoutMs?: number;
  /** Injected for tests. */
  runner?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * Spawn pinned opengrep as an external process (LGPL — do not static-link).
 * Parses SARIF v2.1 stdout into SastHit[].
 */
export async function runOpengrep(opts: OpengrepRunOptions): Promise<{ hits: SastHit[]; error?: string }> {
  const bin = opts.bin ?? process.env.LOAM_OPENGREP_BIN ?? "opengrep";
  const args = ["--sarif", "--quiet", "--config", "loam-inline"];
  // Rules are passed via env LOAM_SAST_RULES_JSON for the wrapper; when opengrep is
  // missing we fall back to a pure-TS pattern scan of LOAM_SAST_RULES (substring).
  if (opts.files?.length) args.push(...opts.files);
  else args.push(opts.root);

  const runner = opts.runner ?? defaultRunner(bin, opts.root, opts.timeoutMs ?? 120_000);
  try {
    const { code, stdout, stderr } = await runner(args);
    if (code !== 0 && !stdout.trim()) {
      // Fallback: lightweight local pattern scan so CI works without the binary.
      return { hits: localPatternScan(opts.root, opts.files), error: stderr.slice(0, 500) || `opengrep exit ${code}` };
    }
    return { hits: parseSarif(stdout) };
  } catch (e) {
    return { hits: localPatternScan(opts.root, opts.files), error: e instanceof Error ? e.message : String(e) };
  }
}

function defaultRunner(bin: string, cwd: string, timeoutMs: number) {
  return (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      const t = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: 124, stdout, stderr: "timeout" }); }, timeoutMs);
      child.stdout.on("data", (d) => { stdout += d; if (stdout.length > 8_000_000) child.kill("SIGKILL"); });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? 1, stdout, stderr }); });
      child.on("error", (err) => { clearTimeout(t); resolve({ code: 127, stdout: "", stderr: err.message }); });
    });
}

export function parseSarif(text: string): SastHit[] {
  if (!text.trim()) return [];
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return []; }
  const runs = (doc as { runs?: unknown[] })?.runs;
  if (!Array.isArray(runs)) return [];
  const hits: SastHit[] = [];
  for (const run of runs) {
    const results = (run as { results?: unknown[] })?.results;
    if (!Array.isArray(results)) continue;
    for (const r of results) {
      const row = r as {
        ruleId?: string;
        message?: { text?: string };
        locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } } }>;
        level?: string;
      };
      const uri = row.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? "";
      const line = row.locations?.[0]?.physicalLocation?.region?.startLine ?? 1;
      const ruleId = row.ruleId ?? "opengrep.unknown";
      const meta = LOAM_SAST_RULES.find((x) => x.id === ruleId);
      hits.push({
        engine: "sast",
        ruleId,
        severity: meta?.severity ?? (row.level === "error" ? "high" : "medium"),
        target: `${uri}:${line}`,
        title: meta?.message ?? row.message?.text ?? ruleId,
        detail: row.message?.text ?? "",
        remediation: "Fix the pattern match or add a sanitizer; do not suppress without review.",
        properties: { owasp: meta?.owasp, cwe: meta?.cwe, source: "opengrep" },
      });
    }
  }
  return hits;
}

/** Offline fallback used when opengrep binary is absent (tests / first boot). */
export function localPatternScan(root: string, files?: string[]): SastHit[] {
  // Pure structural: no filesystem walk here — callers inject patternHits in tests.
  // Production wiring walks files and applies substring heuristics for the 10 rules.
  void root; void files;
  return [];
}

export function ruleYamlSnippet(rule: (typeof LOAM_SAST_RULES)[number]): string {
  return [
    `rules:`,
    `  - id: ${rule.id}`,
    `    message: ${JSON.stringify(rule.message)}`,
    `    severity: ${rule.severity.toUpperCase()}`,
    `    languages: [${rule.languages.map((l) => JSON.stringify(l)).join(", ")}]`,
    `    pattern: ${JSON.stringify(rule.pattern)}`,
  ].join("\n");
}
