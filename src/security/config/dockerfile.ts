/**
 * First-party Dockerfile posture check (dockerfile-roast technique, ALL_SERVICES §8):
 * TS-native critique, no engine needed. Deterministic line-based rules; output is
 * RawFinding[] through the normalize funnel. checkov (external, pinned adapter in the
 * audit scanner set) covers full IaC breadth; this is the in-app quick path.
 */
import type { RawFinding } from "../normalize/types.js";

type Severity = RawFinding["severity"];

interface LineRule { kind: "line"; id: string; severity: Severity; title: string; detail: string; remediation: string; match: RegExp;
  /** Extra predicate over the match (e.g. image tag inspection); defaults to true. */
  when?: (m: RegExpExecArray) => boolean }
/** Fires once on the first FROM when a required directive is absent from the file. */
interface AbsenceRule { kind: "absence"; id: string; severity: Severity; title: string; detail: string; remediation: string; required: RegExp }
type Rule = LineRule | AbsenceRule;

const RULES: Rule[] = [
  { kind: "absence", id: "DF-ROOT-USER", severity: "high", title: "Container runs as root",
    detail: "No USER directive anywhere; the process runs as root.", remediation: "Add `USER <non-root>` after the runtime setup.",
    required: /^USER\s+\S+/i },
  { kind: "line", id: "DF-LATEST-TAG", severity: "medium", title: "Base image not pinned",
    detail: "`FROM` uses `:latest` or no tag, so builds float with upstream.", remediation: "Pin a digest or an exact version tag.",
    match: /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+\S+)?\s*$/i,
    when: (m) => m[1]!.endsWith(":latest") || (!m[1]!.includes(":") && !m[1]!.startsWith("sha256:")) },
  { kind: "line", id: "DF-ADD-URL", severity: "medium", title: "ADD used instead of COPY",
    detail: "ADD with a URL/archive has extraction side effects.", remediation: "Use COPY for local files; fetch remote artifacts explicitly.",
    match: /^ADD\s+\S+/i },
  { kind: "line", id: "DF-SECRET-ENV", severity: "critical", title: "Possible secret in ENV",
    detail: "ENV assignment whose key looks like a credential.", remediation: "Mount secrets at runtime; never bake them into images.",
    match: /^ENV\s+\S*(?:key|token|secret|passwd|password|credential)\S*\s*=/i },
  { kind: "line", id: "DF-CURL-PIPE-SHELL", severity: "high", title: "curl/wget piped into shell",
    detail: "Remote script executed without pinning or checksum.", remediation: "Download, verify a checksum, then run a pinned file.",
    match: /(?:curl|wget)[^\n|;]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh/ },
  { kind: "line", id: "DF-APT-UPGRADE", severity: "low", title: "apt-get upgrade bloats the layer",
    detail: "A full upgrade in build breaks reproducibility.", remediation: "Pin package versions with `apt-get install <pkg>=<ver>`.",
    match: /^RUN\s+.*apt-get\s+(?:dist-)?upgrade/i },
  { kind: "line", id: "DF-SUDO", severity: "medium", title: "sudo in build steps",
    detail: "sudo is unnecessary in containers and hides privilege changes.", remediation: "Use USER directives instead.",
    match: /^RUN\s+.*\bsudo\b/ },
  { kind: "absence", id: "DF-NO-HEALTHCHECK", severity: "low", title: "No HEALTHCHECK",
    detail: "Orchestrators cannot detect a wedged process.", remediation: "Add a HEALTHCHECK probing the real serving endpoint.",
    required: /^HEALTHCHECK\s/i },
];

export function roastDockerfile(text: string, file = "Dockerfile"): RawFinding[] {
  const lines = text.split(/\r?\n/);
  const out: RawFinding[] = [];
  const push = (r: Rule, lineNo: number, evidence: string): void => {
    out.push({
      engine: "config", ruleId: r.id, severity: r.severity, target: `${file}:${lineNo}`,
      title: r.title, detail: r.detail, remediation: r.remediation,
      properties: { line: evidence.slice(0, 160).trim() },
    });
  };
  for (const rule of RULES) {
    if (rule.kind === "absence") {
      if (!lines.some((l) => rule.required.test(l))) {
        const from = lines.findIndex((l) => /^FROM\s/i.test(l));
        push(rule, from >= 0 ? from + 1 : 1, from >= 0 ? lines[from]! : "(no FROM)");
      }
      continue;
    }
    lines.forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      const m = rule.match.exec(line);
      if (m && (rule.when ? rule.when(m) : true)) push(rule, i + 1, line);
    });
  }
  return out;
}

/** Cap A4 (MISSING §4) alias: the funnel calls this name. */
export function scanDockerfile(text: string, file = "Dockerfile"): RawFinding[] {
  return roastDockerfile(text, file);
}
