/**
 * check:selfharden — runs the Cap A self-audit against the live tree:
 * package.json engines/deps, protected paths in the bridges policy, the
 * untrusted-name registry, the ASAR audit mode and the icon ban. Exit 1 on
 * any failed check; warnings report but do not fail.
 */
import fs from "node:fs";
import path from "node:path";
import { runSelfAudit } from "../security/selfAudit.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function fileURLToPath(u: string): string {
  return new URL(u).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

// Protected paths: names registered by the bridges/policy layers.
const protectedPaths: string[] = [];
for (const candidate of [
  path.join(ROOT, "src", "policy", "paths.ts"),
  path.join(ROOT, "src", "bridges", "envelope.ts"),
  path.join(ROOT, "src", "tools", "integrations.ts"),
]) {
  if (!fs.existsSync(candidate)) continue;
  const text = fs.readFileSync(candidate, "utf8");
  for (const m of text.matchAll(/integration-grants/g)) protectedPaths.push(`integration-grants@${path.relative(ROOT, candidate)}`);
}

// Untrusted names: count the entries in the riskTier list.
let untrustedCount = 0;
const riskTierPath = path.join(ROOT, "src", "policy", "riskTier.ts");
if (fs.existsSync(riskTierPath)) {
  const text = fs.readFileSync(riskTierPath, "utf8");
  const m = text.match(/UNTRUSTED_TOOL_NAMES = new Set<string>\(\[([\s\S]*?)\]\)/);
  if (m) untrustedCount = (m[1]!.match(/"/g) ?? []).length / 2;
}

// Sparkles ban: any occurrence in the UI trees fails.
let sparkles = false;
for (const dir of [path.join(ROOT, "ui"), path.join(ROOT, "packages", "web", "src")]) {
  if (!fs.existsSync(dir)) continue;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|ts|tsx|html|css)$/.test(e.name) && /Sparkles/i.test(fs.readFileSync(p, "utf8"))) sparkles = true;
    }
  };
  walk(dir);
}

const report = runSelfAudit({
  packageJson: pkg,
  protectedPathsRegistered: protectedPaths,
  untrustedToolNames: new Array(Math.max(0, untrustedCount)).fill("x"),
  asarAuditMode: (process.env.LOAM_ASAR_AUDIT as "warn" | "fail" | undefined) ?? "warn",
  sparklesInUi: sparkles,
});

for (const c of report.checks) {
  console.log(`${c.ok ? "PASS" : c.severity === "fail" ? "FAIL" : "WARN"}  ${c.id} — ${c.detail}`);
}
if (!report.ok) {
  console.error(`self-audit FAILED: ${report.failed.join(", ")}`);
  process.exit(1);
}
console.log(`self-audit OK (warnings: ${report.warned.length ? report.warned.join(",") : "none"})`);
