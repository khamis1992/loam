import fs from "node:fs";
import path from "node:path";

/** Roadmap §17 — code, credential and dependency analysis for delivered workspaces.
 * Pure engine-side helpers: the QA gate feeds file contents in and gets a report out,
 * with no imports from the swarm service. Every secret preview is masked so a report
 * can be attached to a task without re-leaking the credential it found. */

export interface SecretFinding { path: string; line: number; kind: string; preview: string }
export interface DependencyReport { dependencies: number; licenses: Record<string, number>; risky: string[] }
export interface InjectionFinding { path: string; line: number; pattern: string; excerpt: string }
export interface AdvisoryFinding { path: string; line: number; kind: string; detail: string }
export interface WorkspaceSecurityReport { secrets: SecretFinding[]; dependencies: DependencyReport | null; risk: "clean" | "findings"; injections: InjectionFinding[]; advisories: AdvisoryFinding[] }

/** First 6 chars, ellipsis, last 2 chars — never the full secret. Short secrets are
 * truncated harder so the preview can never reconstruct the credential. */
function maskSecret(secret: string): string {
  if (secret.length <= 8) return `${secret.slice(0, 2)}…`;
  return `${secret.slice(0, 6)}…${secret.slice(-2)}`;
}

interface SecretRule { kind: string; pattern: RegExp; secretGroup?: number }

/** Line-based credential detection. Quantifiers are greedy so the mask covers the
 * whole credential, not just the pattern minimum. */
const SECRET_RULES: SecretRule[] = [
  { kind: "aws-access-key", pattern: /AKIA[0-9A-Z]{16,}/g },
  { kind: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "openai-key", pattern: /sk-[A-Za-z0-9]{20,}/g },
  { kind: "google-api-key", pattern: /AIza[0-9A-Za-z_-]{30,}/g },
  { kind: "private-key-block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { kind: "jwt", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./g },
  { kind: "assigned-password", pattern: /((?:password|passwd|pwd)\s*[:=]\s*["'])([^"'\s]{8,})["']/gi, secretGroup: 2 },
];

const MAX_SECRET_LINE = 2000;

export function scanSecrets(files: Array<{ path: string; content: string }>): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (line.length > MAX_SECRET_LINE) continue; // minified noise: no honest line signal
      for (const rule of SECRET_RULES) {
        for (const match of line.matchAll(rule.pattern)) {
          const secret = rule.secretGroup === undefined ? match[0] : match[rule.secretGroup];
          if (!secret) continue;
          findings.push({ path: file.path, line: index + 1, kind: rule.kind, preview: maskSecret(secret) });
        }
      }
    }
  }
  findings.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  return findings;
}

/** Dependency entries are usually plain version strings, but object form with an
 * embedded license (as produced by lockfile-aware tooling) is accepted too. */
function dependencyEntry(entry: unknown): { version: string | null; license: string | null } {
  if (typeof entry === "string") return { version: entry, license: null };
  if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    const version = typeof record.version === "string" ? record.version : null;
    const rawLicense = typeof record.license === "string" ? record.license.trim() : "";
    return { version, license: rawLicense.length > 0 ? rawLicense : null };
  }
  return { version: null, license: null };
}

const URL_SPEC = /^(?:git|http|file|link:)/;

export function scanDependencies(packageJsonContent: string): DependencyReport {
  const empty: DependencyReport = { dependencies: 0, licenses: {}, risky: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(packageJsonContent); } catch { return empty; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
  const sections = parsed as Record<string, unknown>;
  const licenses: Record<string, number> = {};
  const risky: string[] = [];
  let dependencies = 0;
  for (const section of ["dependencies", "devDependencies"]) {
    const entries = sections[section];
    if (entries === null || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [name, entry] of Object.entries(entries)) {
      const { version, license } = dependencyEntry(entry);
      dependencies++;
      const key = license ?? "UNKNOWN";
      licenses[key] = (licenses[key] ?? 0) + 1;
      const spec = version?.trim().toLowerCase() ?? "";
      if (key === "UNKNOWN" || (spec !== "" && URL_SPEC.test(spec))) risky.push(name);
    }
  }
  return { dependencies, licenses, risky };
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "dist", "coverage", "__pycache__"]);
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 12;
const BINARY_SNIFF_BYTES = 8192;

export function assessWorkspace(root: string): WorkspaceSecurityReport {
  const files: Array<{ path: string; content: string }> = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) { walk(child, depth + 1); continue; }
      if (!entry.isFile()) continue;
      let content: string;
      try {
        const stat = fs.statSync(path.join(root, child));
        if (stat.size > MAX_FILE_BYTES) continue;
        const buf = fs.readFileSync(path.join(root, child));
        if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue; // binary: NUL in first 8KB
        content = buf.toString("utf8");
      } catch { continue; }
      files.push({ path: child, content });
    }
  };
  walk("", 0);
  const secrets = scanSecrets(files);
  const rootPackageJson = files.find(file => file.path === "package.json")?.content ?? null;
  const dependencies = rootPackageJson !== null ? scanDependencies(rootPackageJson) : null;
  const hasUnknownLicense = dependencies !== null && (dependencies.licenses["UNKNOWN"] ?? 0) > 0;
  const injections = scanPromptInjections(files);
  const advisories = [...auditAuth(files), ...scanInputHandling(files)];
  const risk: WorkspaceSecurityReport["risk"] =
    secrets.length > 0 || injections.length > 0 || (dependencies !== null && dependencies.risky.length > 0) || hasUnknownLicense ? "findings" : "clean";
  return { secrets, dependencies, risk, injections, advisories };
}

/** Roadmap §17: files agents will read must not carry agent-directed instructions.
 * Engine reports under .loam/ are excluded (they legitimately quote gate text). */
const INJECTION_PATTERNS: Array<[string, RegExp]> = [
  ["ignore-instructions", /ignore (?:all |any )?(?:previous |prior |above )?instructions/i],
  ["disregard-rules", /disregard (?:all |any )?(?:previous |prior |above )?(?:instructions|rules|guidelines)/i],
  ["role-hijack", /you are now (?:a|an|the) /i],
  ["prompt-exfiltration", /(?:reveal|print|output|repeat|show) (?:the |your )?(?:full |exact )?system(?: |-)?prompt/i],
  ["chat-template", /<\|(?:im_start|im_end|system\||endoftext\|)/],
  ["developer-mode", /developer mode (?:enabled|: on|jailbreak)/i],
  ["guardrail-override", /override (?:system|safety|guardrails?|policies)/i],
];

export function scanPromptInjections(files: Array<{ path: string; content: string }>): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const file of files) {
    if (file.path.startsWith(".loam/")) continue;
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length > 2000) continue;
      for (const [pattern, regex] of INJECTION_PATTERNS) {
        if (regex.test(line)) { findings.push({ path: file.path, line: i + 1, pattern, excerpt: line.trim().slice(0, 80) }); break; }
      }
    }
  }
  return findings;
}

const CODE_EXT = /\.(?:[cm]?[jt]s|py|rb|php)$/i;

/** Roadmap §17 advisory checks: auth/permission posture and dangerous constructs.
 * Advisory — recorded and reported, never silently dropped, but not blocking:
 * heuristics can false-positive; humans (or the review stage) decide. */
export function auditAuth(files: Array<{ path: string; content: string }>): AdvisoryFinding[] {
  const findings: AdvisoryFinding[] = [];
  const authWords = /auth|token|session|bearer|jwt|api[_-]?key|passport|login|csrf|role|permission|apikey/i;
  for (const file of files) {
    if (!CODE_EXT.test(file.path) || file.path.startsWith(".loam/")) continue;
    const lines = file.content.split("\n");
    let mutating = 0, firstMutatingLine = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/\.\s*(?:post|put|delete|patch)\s*\(\s*["']/.test(lines[i]!)) { mutating++; if (firstMutatingLine === 0) firstMutatingLine = i + 1; }
    }
    if (mutating > 0 && !authWords.test(file.content)) {
      findings.push({ path: file.path, line: firstMutatingLine, kind: "no-auth-mechanism", detail: `${mutating} mutating route registration(s) with no auth/token/session mechanism anywhere in the file` });
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/\beval\s*\(|new\s+Function\s*\(/.test(line)) findings.push({ path: file.path, line: i + 1, kind: "eval-usage", detail: "eval/Function constructor allows arbitrary code execution" });
      if (/\.\s*(?:exec(?:Sync|File(?:Sync)?)?|spawn(?:Sync)?)\s*\(/.test(line) && /(?:\$\{|\+\s*(?:req|params|body|query)|["']\s*\+)/.test(line)) findings.push({ path: file.path, line: i + 1, kind: "shell-interpolation", detail: "shell command built by string interpolation of request data" });
    }
  }
  return findings;
}

/** Roadmap §17 advisory checks: input validation and upload handling. */
export function scanInputHandling(files: Array<{ path: string; content: string }>): AdvisoryFinding[] {
  const findings: AdvisoryFinding[] = [];
  for (const file of files) {
    if (!CODE_EXT.test(file.path) || file.path.startsWith(".loam/")) continue;
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/\bpath\.(?:join|resolve)\s*\([^)\n]*(?:req\.(?:params|query|body)|params\.|body\.)/.test(line)) findings.push({ path: file.path, line: i + 1, kind: "path-from-request", detail: "filesystem path built directly from request data (path traversal risk)" });
      if (/\bquery\s*\(|\.execute\s*\(/.test(line) && /(?:\$\{|\+\s*(?:req|params|body)|["']\s*\+)/.test(line)) findings.push({ path: file.path, line: i + 1, kind: "sql-concat", detail: "SQL built by concatenation/interpolation (injection risk)" });
    }
    if (/multer|busboy|formidable|multipart/i.test(file.content) && !/fileFilter|allowedTypes|allowedExtensions|mimetype/i.test(file.content)) {
      findings.push({ path: file.path, line: 1, kind: "upload-unfiltered", detail: "upload handling without visible type/extension filtering" });
    }
  }
  return findings;
}
