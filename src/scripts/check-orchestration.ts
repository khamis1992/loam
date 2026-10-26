/**
 * `npm run check:orchestration`: static and data checks for the Core.
 *  1. licence and dependency rules (no agent-framework runtime packages);
 *  2. cloud-only rule: no Core module calls chatWithFallback except core.ts;
 *  3. no Core file contains Elastic License text or Mastra ee/ paths;
 *  4. secret scan of stored spans and interrupt payloads;
 *  5. one-Core rule for C11 (AC-S6.2): src/orchestration/swarm/ reaches the rest of the Core only
 *     through public.ts, core.ts, config.ts and the tracing name constants (type-only imports aside),
 *     and never declares its own ledger, checkpoint, selection or trace tables;
 *  6. MiroFish non-interference: no Core file imports MiroFish;
 *  7. optional (`--mirofish-base=<ref>`, run inside the Loam repo): the MiroFish files are byte-identical to <ref>.
 * Exit code 1 on any finding. Prints one line per finding.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { database } from "../server/sqliteStore.js";
import { redactSecrets } from "../orchestration/tracing/tracer.js";

const FORBIDDEN_DEPS = /^(@mastra\/|@langchain\/|@langgraph\/|@voltagent\/|crewai|agent-framework|openhands|trae-agent)/;

/** MiroFish files (OBSERVED in this repository); the AC-S6.1 / DoD diff covers exactly these. */
export const MIROFISH_PATHS = [
  "src/tools/mirofish.ts",
  "src/tools/mirofish/",
  "src/server/__tests__/mirofishHttp.test.ts",
  "src/agent/__tests__/mirofishLoop.test.ts",
  "src/tools/__tests__/mirofishIntent.test.ts",
  "skills/mirofish-swarm-analyst/",
];

const SWARM_ALLOWED_CORE_IMPORTS = new Set(["../public.js", "../core.js", "../config.js", "../tracing/genai.js"]);
const CORE_TABLES = /CREATE TABLE[^(]*\b(trace_spans|run_checkpoints|run_interrupts|workflow_runs|workflow_steps|ledger_\w+)\b/i;

function listTs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listTs(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}

export function checkOrchestration(root: string): string[] {
  const out: string[] = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  for (const name of Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })) {
    if (FORBIDDEN_DEPS.test(name)) out.push(`dependency not allowed: ${name}`);
  }
  for (const file of listTs(path.join(root, "src", "orchestration"))) {
    if (file.includes(`${path.sep}__tests__${path.sep}`) || file.includes(`${path.sep}__e2e__${path.sep}`)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (/chatWithFallback\s*\(/.test(text) && !file.endsWith(`${path.sep}core.ts`)) out.push(`cloud-only rule: ${path.relative(root, file)} calls chatWithFallback directly`);
    if (/Elastic License|ELv2|[\\/]ee[\\/]/.test(text)) out.push(`licence: ${path.relative(root, file)} mentions ELv2 or an ee/ path`);
    if (/from\s+["'][^"']*mirofish[^"']*["']/i.test(text)) out.push(`MiroFish non-interference: ${path.relative(root, file)} imports MiroFish`);
    if (file.includes(`${path.sep}orchestration${path.sep}swarm${path.sep}`)) {
      for (const m of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+["'](\.\.\/[^"']+)["']/gms)) {
        const spec = m[2]!;
        if (m[1] || spec.startsWith("../../") || SWARM_ALLOWED_CORE_IMPORTS.has(spec)) continue;
        out.push(`one-Core rule: ${path.relative(root, file)} imports ${spec}; use public.ts or core.ts`);
      }
      if (CORE_TABLES.test(text)) out.push(`one-Core rule: ${path.relative(root, file)} declares a Core table`);
    }
  }
  const d = database();
  const tables = new Set((d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
  const scan = (table: string, cols: string[]) => {
    if (!tables.has(table)) return;
    for (const row of d.prepare(`SELECT ${cols.join(", ")} FROM ${table}`).all() as Array<Record<string, unknown>>) {
      for (const c of cols) {
        const v = row[c];
        if (typeof v === "string" && redactSecrets(v) !== v) out.push(`secret-shaped value stored in ${table}.${c}`);
      }
    }
  };
  scan("trace_spans", ["attributes", "events", "status_message"]);
  scan("run_interrupts", ["payload", "response"]);
  return out;
}

/** Lists MiroFish files that differ from `baseRef` (empty = untouched). Read-only git call. */
export function checkMirofishUntouched(repo: string, baseRef: string): string[] {
  const out = execFileSync("git", ["diff", "--name-only", baseRef, "--", ...MIROFISH_PATHS], { cwd: repo, encoding: "utf8" });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", ...MIROFISH_PATHS], { cwd: repo, encoding: "utf8" });
  return [...out.split("\n"), ...untracked.split("\n")].map((l) => l.trim()).filter(Boolean).map((f) => `MiroFish changed: ${f}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const base = process.argv.find((a) => a.startsWith("--mirofish-base="))?.slice("--mirofish-base=".length);
  const findings = [...checkOrchestration(process.cwd()), ...(base ? checkMirofishUntouched(process.cwd(), base) : [])];
  for (const f of findings) console.log(f);
  console.log(findings.length ? `check:orchestration FAILED (${findings.length})` : "check:orchestration OK");
  process.exit(findings.length ? 1 : 0);
}
