/**
 * Smoke check for the security audit: the three tools are exposed, an unknown run id is refused,
 * and a full run with injected fakes writes a valid ledger, findings and reports with no scanner installed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-audit-check-"));
process.env.MANUS_LOCAL_DATA_DIR = path.join(tmp, "data");

const { createSecurityAuditTools } = await import("../tools/securityAuditTools.js");
const { orchestrate } = await import("../security/audit/orchestrator.js");
const { ToolRegistry } = await import("../tools/registry.js");
const { validateFindings } = await import("../security/audit/validateFindings.js");
const { validateLedger } = await import("../security/audit/validateLedger.js");

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
}

console.log("security audit smoke");
const tools = createSecurityAuditTools({ cfg: { model: "base" } as never, ollama: {} as never, tools: new ToolRegistry() });
check("three tools exposed", tools.map((t) => t.name).sort().join(",") === "security_audit_report,security_audit_start,security_audit_status");

const ctx = { cfg: {} as never, workspace: tmp, emit: () => undefined };
const status = tools.find((t) => t.name === "security_audit_status")!;
const bad = await status.run({ run_id: "nope--run-9" }, ctx as never);
check("unknown run id refused", !bad.ok);
const badProfile = await tools.find((t) => t.name === "security_audit_start")!.run({ profile: "wild" }, ctx as never);
check("invalid profile refused", !badProfile.ok);

const target = path.join(tmp, "repo");
fs.mkdirSync(path.join(target, "src"), { recursive: true });
fs.writeFileSync(path.join(target, "src", "a.ts"), "export const run = (x: string) => eval(x);\n");
const out = path.join(tmp, "out");
const hunt = {
  candidates: [{
    title: "eval of input", description: "Input reaches eval.", root_cause: "No validation.",
    trace: [
      { kind: "entrypoint", file: "src/a.ts", line: 1, description: "param x" },
      { kind: "sink", file: "src/a.ts", line: 1, description: "eval(x)" },
    ],
    evidence: [{ file: "src/a.ts", line: 1, description: "eval call" }],
    impact: "high", likelihood: "medium", remediation: "Remove eval.",
  }],
  coverage: "covered", checks: [{ description: "Read the file", paths: ["src/a.ts"] }], unresolved: [],
};
const run = async (o: { prompt: string }) => {
  const p = o.prompt;
  const r = p.includes("reconnaissance agent") ? { facts: [], summary: "tiny" }
    : p.includes("vulnerability hunter") ? hunt
    : p.includes("independent verifier") ? { evidence_vector: [{ source: "llm", state: "confirmed", ref: "src/a.ts:1", note: "ok" }], production_viable: true, reason: "checked" }
    : { gaps: [], merge: [] };
  return { text: JSON.stringify(r), steps: 1 };
};
const res = await orchestrate({ target, profile: "quick", output_dir: out }, {
  cfg: { model: "base" } as never, ollama: {} as never, tools: new ToolRegistry(),
  run: run as never, acquire: async () => () => undefined,
  exec: async () => ({ code: 127, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" }),
});
check("run completes", res.run_status === "complete", res.incomplete_reason);
check("ledger valid", validateLedger(fs.readFileSync(path.join(out, "coverage-ledger.json")), { runDir: out }).ok);
check("findings valid", validateFindings(fs.readFileSync(path.join(out, "findings.json")), { runDir: out }).ok);
check("report written", fs.existsSync(path.join(out, "REPORT.md")) && fs.existsSync(path.join(out, "findings.sarif")));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* an open db handle can hold the dir on Windows */ }
console.log(failed === 0 ? "all checks passed" : `${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
