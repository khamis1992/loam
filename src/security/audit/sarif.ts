/** SARIF v2.1.0 -> ReconHit (§7.3). Scanner output is untrusted input: every field is coerced and bounded. */
import { checkRepoPath } from "./repoPath.js";
import type { ReconHit, ScannerTool, Score } from "./types.js";

const TOOL_NAMES: [RegExp, ScannerTool][] = [
  [/gitleaks/i, "gitleaks"], [/osv/i, "osv"], [/guarddog/i, "guarddog"], [/trivy/i, "trivy"],
  [/opengrep|semgrep/i, "opengrep"], [/nuclei/i, "nuclei"], [/zap/i, "zap"], [/jazzer/i, "jazzer"],
];
const DETERMINISTIC: ReadonlySet<ScannerTool> = new Set<ScannerTool>(["gitleaks", "osv", "guarddog", "trivy"]);

/** Fixed CWE/tag -> class table. First match wins; anything else is "other". */
const CLASS_TABLE: [RegExp, string][] = [
  [/secret|credential|api[-_ ]?key|token|cwe-798|cwe-259|cwe-321/i, "secret"],
  [/malicious|typosquat|supply[-_ ]?chain|backdoor/i, "malicious-package"],
  [/vulnerab|cve-|ghsa-|osv|known[-_ ]?bad/i, "known-vulnerability"],
  [/sql[-_ ]?inject|cwe-89\b/i, "sql-injection"],
  [/command[-_ ]?inject|cwe-78\b|cwe-77\b/i, "command-injection"],
  [/xss|cross[-_ ]?site[-_ ]?script|cwe-79\b/i, "xss"],
  [/path[-_ ]?traversal|cwe-22\b|cwe-23\b/i, "path-traversal"],
  [/ssrf|cwe-918\b/i, "ssrf"],
  [/deserializ|cwe-502\b/i, "deserialization"],
  [/xxe|cwe-611\b/i, "xxe"],
  [/crypto|weak[-_ ]?hash|cwe-327\b|cwe-328\b/i, "crypto"],
  [/auth|access[-_ ]?control|cwe-284\b|cwe-285\b|cwe-862\b|cwe-863\b/i, "access-control"],
  [/redirect|cwe-601\b/i, "open-redirect"],
];

export function normalizeToolName(name: string): ScannerTool | null {
  for (const [re, t] of TOOL_NAMES) if (re.test(name)) return t;
  return null;
}

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function levelToSeverity(level: string): Score {
  switch (level) {
    case "error": return "high";
    case "warning": return "medium";
    case "note": return "low";
    default: return "informational";
  }
}

function refine(base: Score, raw: unknown): Score {
  const n = typeof raw === "number" ? raw : Number.parseFloat(str(raw));
  if (!Number.isFinite(n)) return base;
  if (n >= 9) return "critical";
  if (n >= 7) return "high";
  if (n >= 4) return "medium";
  return "low";
}

/** Repo-relative path from a SARIF artifact uri. Null for absolute, UNC or otherwise unsafe paths. */
export function repoRelative(uri: string): string | null {
  let u = uri.trim();
  if (u.startsWith("file://")) return null;
  if (u.startsWith("./")) u = u.slice(2);
  return checkRepoPath(u) === null ? u : null;
}

function classify(rule: Record<string, unknown> | null, ruleId: string, message: string): string {
  const tags = asArr(asObj(rule?.properties)?.tags).map(str).join(" ");
  const hay = `${ruleId} ${tags} ${str(asObj(rule?.shortDescription)?.text)} ${message}`;
  for (const [re, cls] of CLASS_TABLE) if (re.test(hay)) return cls;
  return "other";
}

export interface SarifParse {
  hits: ReconHit[];
  /** Results dropped (unsafe path, unknown shape). Counted, never fatal. */
  dropped: number;
}

export function sarifToHits(sarif: unknown, fallbackTool?: ScannerTool, maxHits = 5000): SarifParse {
  const hits: ReconHit[] = [];
  let dropped = 0;
  const root = asObj(sarif);
  for (const runRaw of asArr(root?.runs)) {
    const run = asObj(runRaw);
    const driver = asObj(asObj(asObj(run?.tool)?.driver));
    const tool = normalizeToolName(str(driver?.name)) ?? fallbackTool;
    if (!tool) {
      dropped += asArr(run?.results).length;
      continue;
    }
    const rules = new Map<string, Record<string, unknown>>();
    asArr(driver?.rules).forEach((r, i) => {
      const o = asObj(r);
      if (o) rules.set(str(o.id) || String(i), o);
    });
    for (const resRaw of asArr(run?.results)) {
      if (hits.length >= maxHits) {
        dropped++;
        continue;
      }
      const res = asObj(resRaw);
      if (!res) {
        dropped++;
        continue;
      }
      const ruleId = str(res.ruleId);
      const rule = rules.get(ruleId) ?? null;
      const loc = asObj(asObj(asArr(res.locations)[0])?.physicalLocation);
      const file = repoRelative(str(asObj(loc?.artifactLocation)?.uri));
      if (!ruleId || file === null) {
        dropped++;
        continue;
      }
      const lineRaw = asObj(loc?.region)?.startLine;
      const line = typeof lineRaw === "number" && Number.isInteger(lineRaw) && lineRaw >= 1 ? lineRaw : 1;
      const message = (str(asObj(res.message)?.text).split(/\r?\n/)[0] ?? "").trim().slice(0, 500);
      const level = str(res.level) || str(asObj(rule?.defaultConfiguration)?.level) || "warning";
      const secSev = asObj(rule?.properties)?.["security-severity"] ?? asObj(res.properties)?.["security-severity"];
      hits.push({
        tool, ruleId, message, file, line,
        cls: classify(rule, ruleId, message),
        severity: refine(levelToSeverity(level), secSev),
        deterministic: DETERMINISTIC.has(tool),
        raw: res,
      });
    }
  }
  return { hits, dropped };
}

/** Dedupe by (tool, ruleId, file, line). First occurrence wins. */
export function dedupeHits(hits: ReconHit[]): ReconHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = `${h.tool}\u0000${h.ruleId}\u0000${h.file}\u0000${h.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
