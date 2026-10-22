/**
 * Per-edit diagnostics.
 *
 * After a successful edit to a TypeScript/JavaScript/Python file, run a fast
 * static checker with a hard time budget and append the first findings to the
 * tool result. The checker never fails the edit: diagnostics are advisory and a
 * checker crash or timeout degrades to a short note.
 *
 * Checkers:
 *   - `tsc`       project-wide `tsc --noEmit` (incremental build info is left to
 *                 the project's tsconfig) or a single-file `tsc` fallback.
 *   - `eslint`    file-scoped ESLint with JSON output.
 *   - `pycompile` `python -m py_compile` for syntax errors.
 *
 * Configuration is resolved in layers (later wins):
 *   1. built-in defaults (20 s budget, first 20 findings, auto checker)
 *   2. `diagnostics` in config.json
 *   3. a `## Diagnostics` section or a ```json diagnostics block in the
 *      workspace's LOAM.md / AGENTS.md / CLAUDE.md
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT } from "../config.js";

export type DiagnosticSeverity = "error" | "warning";
export type DiagnosticCheckerKind = "auto" | "tsc" | "eslint" | "pycompile";

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: DiagnosticSeverity;
  message: string;
  code: string;
}

export interface DiagnosticSettings {
  enabled: boolean;
  /** Hard wall-clock budget for one checker run. */
  timeoutMs: number;
  /** Maximum findings appended to the tool result. */
  maxErrors: number;
  checker: DiagnosticCheckerKind;
}

export interface DiagnosticOutcome {
  file: string;
  checker: string;
  diagnostics: Diagnostic[];
  /** Total findings before the maxErrors cap, for honest reporting. */
  total: number;
  timedOut: boolean;
  elapsedMs: number;
  note?: string;
}

export interface DiagnosticChecker {
  readonly name: string;
  supports(file: string): boolean;
  check(file: string, settings: DiagnosticSettings, signal: AbortSignal): Promise<Diagnostic[]>;
}

export const DEFAULT_DIAGNOSTIC_SETTINGS: DiagnosticSettings = {
  enabled: true,
  timeoutMs: 20_000,
  maxErrors: 20,
  checker: "auto",
};

const TS_EXT = /\.(?:[cm]?[jt]sx?)$/i;
const PY_EXT = /\.py$/i;
const MAX_FINDINGS = 100;
const MEMORY_FILES = ["LOAM.md", "AGENTS.md", "CLAUDE.md"];
const MAX_MEMORY_BYTES = 200_000;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function isCheckerKind(value: unknown): value is DiagnosticCheckerKind {
  return value === "auto" || value === "tsc" || value === "eslint" || value === "pycompile";
}

export function normalizeDiagnosticSettings(partial?: Partial<DiagnosticSettings>): DiagnosticSettings {
  const p = partial ?? {};
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : DEFAULT_DIAGNOSTIC_SETTINGS.enabled,
    timeoutMs: clampInt(p.timeoutMs, 1_000, 120_000, DEFAULT_DIAGNOSTIC_SETTINGS.timeoutMs),
    maxErrors: clampInt(p.maxErrors, 1, MAX_FINDINGS, DEFAULT_DIAGNOSTIC_SETTINGS.maxErrors),
    checker: isCheckerKind(p.checker) ? p.checker : DEFAULT_DIAGNOSTIC_SETTINGS.checker,
  };
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runProcess(command: string, args: string[], cwd: string, signal: AbortSignal): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd, windowsHide: true });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const kill = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const onAbort = (): void => kill();
    if (signal.aborted) kill();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code });
    });
  });
}

function findTsConfigDir(file: string): string | null {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (fs.existsSync(path.join(dir, "tsconfig.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function appTscPath(): string {
  return path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
}

function appEslintPath(): string {
  return path.join(ROOT, "node_modules", "eslint", "bin", "eslint.js");
}

function parseTscOutput(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Za-z]+\d+):\s+(.*)$/;
  for (const rawLine of output.split(/\r?\n/)) {
    const m = re.exec(rawLine.trim());
    if (!m) continue;
    diagnostics.push({
      file: m[1] ?? "",
      line: Number(m[2]),
      column: Number(m[3]),
      severity: m[4] === "warning" ? "warning" : "error",
      message: (m[6] ?? "").trim(),
      code: m[5] ?? "",
    });
  }
  return diagnostics;
}

const TscChecker: DiagnosticChecker = {
  name: "tsc",
  supports: (file) => TS_EXT.test(file),
  async check(file, _settings, signal) {
    const tsc = appTscPath();
    if (!fs.existsSync(tsc)) return [];
    const dir = findTsConfigDir(file);
    const args = dir
      ? ["--noEmit", "--pretty", "false", "-p", path.join(dir, "tsconfig.json")]
      : ["--noEmit", "--pretty", "false", "--skipLibCheck", file];
    const res = await runProcess(process.execPath, [tsc, ...args], dir ?? path.dirname(file), signal);
    return parseTscOutput(`${res.stdout}\n${res.stderr}`);
  },
};

function parseEslintOutput(output: string, editedFile: string): Diagnostic[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const diagnostics: Diagnostic[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const messages = record.messages;
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      if (typeof message !== "object" || message === null) continue;
      const m = message as Record<string, unknown>;
      const severity = m.severity === 1 ? "warning" : "error";
      diagnostics.push({
        file: typeof record.filePath === "string" ? record.filePath : editedFile,
        line: typeof m.line === "number" ? m.line : 0,
        column: typeof m.column === "number" ? m.column : 0,
        severity,
        message: typeof m.message === "string" ? m.message : "",
        code: typeof m.ruleId === "string" ? m.ruleId : "",
      });
    }
  }
  return diagnostics;
}

const EslintChecker: DiagnosticChecker = {
  name: "eslint",
  supports: (file) => TS_EXT.test(file),
  async check(file, _settings, signal) {
    const eslint = appEslintPath();
    if (!fs.existsSync(eslint)) return [];
    const res = await runProcess(process.execPath, [eslint, "--format", "json", "--no-color", file], path.dirname(file), signal);
    return parseEslintOutput(res.stdout, file);
  },
};

function parsePyCompileOutput(output: string, editedFile: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const fileRe = /File "([^"]+)", line (\d+)/g;
  const errorRe = /^\s*([A-Za-z_][A-Za-z0-9_]*(?:Error|Warning)):\s*(.*)$/;
  const lines = output.split(/\r?\n/);
  let lastFile: string | null = null;
  let lastLine = 0;
  for (const line of lines) {
    for (const m of line.matchAll(fileRe)) {
      lastFile = m[1] ?? null;
      lastLine = Number(m[2]);
    }
    const err = errorRe.exec(line);
    if (err && lastFile) {
      diagnostics.push({
        file: lastFile,
        line: lastLine,
        column: 0,
        severity: "error",
        message: `${err[1] ?? "Error"}: ${err[2] ?? ""}`.trim(),
        code: err[1] ?? "Error",
      });
    }
  }
  if (diagnostics.length === 0 && output.trim()) {
    diagnostics.push({ file: editedFile, line: 0, column: 0, severity: "error", message: output.trim().split(/\r?\n/).pop() ?? "", code: "SyntaxError" });
  }
  return diagnostics;
}

const PyCompileChecker: DiagnosticChecker = {
  name: "pycompile",
  supports: (file) => PY_EXT.test(file),
  async check(file, _settings, signal) {
    const python = process.env.LOAM_PYTHON ?? "python";
    const res = await runProcess(python, ["-m", "py_compile", file], path.dirname(file), signal);
    if (res.code === 0) return [];
    return parsePyCompileOutput(`${res.stderr}\n${res.stdout}`, file);
  },
};

function selectChecker(file: string, settings: DiagnosticSettings, injected?: DiagnosticChecker): DiagnosticChecker | null {
  if (injected) return injected;
  switch (settings.checker) {
    case "tsc":
      return TscChecker;
    case "eslint":
      return EslintChecker;
    case "pycompile":
      return PyCompileChecker;
    default:
      break;
  }
  if (PY_EXT.test(file)) return PyCompileChecker;
  if (TS_EXT.test(file)) {
    if (findTsConfigDir(file) && fs.existsSync(appTscPath())) return TscChecker;
    if (fs.existsSync(appEslintPath())) return EslintChecker;
    return TscChecker;
  }
  return null;
}

function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const rank = (d: Diagnostic): number => (d.severity === "error" ? 0 : 1);
  return [...diagnostics].sort((a, b) => rank(a) - rank(b) || a.line - b.line || a.column - b.column || a.file.localeCompare(b.file));
}

export async function runDiagnostics(
  file: string,
  settings: DiagnosticSettings,
  injected?: DiagnosticChecker,
): Promise<DiagnosticOutcome | null> {
  if (!settings.enabled) return null;
  const checker = selectChecker(file, settings, injected);
  if (!checker) return null;

  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  let settleTimeout: (() => void) | undefined;
  const timeoutPromise = new Promise<{ ok: false }>((resolve) => {
    settleTimeout = () => resolve({ ok: false });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    settleTimeout?.();
  }, settings.timeoutMs);

  try {
    const result = await Promise.race([
      checker.check(file, settings, controller.signal).then((diagnostics) => ({ ok: true as const, diagnostics })),
      timeoutPromise,
    ]);
    if (!result.ok) {
      return {
        file,
        checker: checker.name,
        diagnostics: [],
        total: 0,
        timedOut: true,
        elapsedMs: Date.now() - started,
        note: `timed out after ${settings.timeoutMs} ms; no diagnostics reported`,
      };
    }
    const sorted = sortDiagnostics(result.diagnostics);
    return {
      file,
      checker: checker.name,
      diagnostics: sorted.slice(0, settings.maxErrors),
      total: sorted.length,
      timedOut: false,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      file,
      checker: checker.name,
      diagnostics: [],
      total: 0,
      timedOut: false,
      elapsedMs: Date.now() - started,
      note: `checker failed: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function formatDiagnostic(d: Diagnostic): string {
  const loc = d.line > 0 ? `(${d.line},${d.column})` : "";
  const code = d.code ? ` ${d.code}:` : "";
  return `${d.file}${loc}: ${d.severity}${code} ${d.message}`.trimEnd();
}

export function formatDiagnosticReport(outcome: DiagnosticOutcome): string {
  const header = `Diagnostics (${outcome.checker}, ${outcome.elapsedMs} ms)`;
  if (outcome.timedOut) return `${header}: ${outcome.note ?? "timed out"}`;
  if (outcome.diagnostics.length === 0) {
    const clean = `${header}: no errors.`;
    return outcome.note ? `${clean}\n${outcome.note}` : clean;
  }
  const errors = outcome.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = outcome.diagnostics.length - errors;
  const summary = `${errors} error(s)${warnings ? `, ${warnings} warning(s)` : ""}`;
  const lines = outcome.diagnostics.map(formatDiagnostic);
  if (outcome.total > outcome.diagnostics.length) {
    lines.push(`… ${outcome.total - outcome.diagnostics.length} more finding(s) not shown`);
  }
  const note = outcome.note ? `\n${outcome.note}` : "";
  return `${header}: ${summary}\n${lines.join("\n")}${note}`;
}

function applySettingsObject(target: Partial<DiagnosticSettings>, value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const obj = value as Record<string, unknown>;
  if (typeof obj.enabled === "boolean") target.enabled = obj.enabled;
  const timeout = obj.timeoutMs ?? obj.timeout_ms ?? obj.timeout;
  if (typeof timeout === "number" && Number.isFinite(timeout)) target.timeoutMs = timeout;
  const max = obj.maxErrors ?? obj.max_errors ?? obj.max;
  if (typeof max === "number" && Number.isFinite(max)) target.maxErrors = max;
  if (typeof obj.checker === "string") target.checker = obj.checker as DiagnosticCheckerKind;
}

function parseMemoryDiagnostics(text: string): Partial<DiagnosticSettings> {
  const out: Partial<DiagnosticSettings> = {};
  const fence = /```[ \t]*json[ \t]*diagnostics[^\n]*\n([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) {
    try {
      applySettingsObject(out, JSON.parse(fence[1]));
    } catch {
      /* malformed block is ignored */
    }
  }
  let inSection = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const heading = /^##[ \t]+([A-Za-z][A-Za-z0-9 _-]*)[ \t]*$/.exec(rawLine);
    if (heading) {
      inSection = (heading[1] ?? "").trim().toLowerCase() === "diagnostics";
      continue;
    }
    if (!inSection) continue;
    const m = /^([A-Za-z]+)[ \t]*:[ \t]*(.*?)\s*$/.exec(rawLine);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const value = m[2] ?? "";
    if (key === "enabled") out.enabled = value.toLowerCase() === "true";
    else if (key === "timeoutms" || key === "timeout") out.timeoutMs = Number(value);
    else if (key === "maxerrors" || key === "max") out.maxErrors = Number(value);
    else if (key === "checker") out.checker = value as DiagnosticCheckerKind;
  }
  return out;
}

export function readDiagnosticsFromMemory(workspace: string): Partial<DiagnosticSettings> {
  for (const name of MEMORY_FILES) {
    const full = path.join(workspace, name);
    try {
      if (!fs.existsSync(full)) continue;
      if (fs.statSync(full).size > MAX_MEMORY_BYTES) continue;
      const parsed = parseMemoryDiagnostics(fs.readFileSync(full, "utf8"));
      if (Object.keys(parsed).length > 0) return parsed;
    } catch {
      /* unreadable memory file is not fatal */
    }
  }
  return {};
}

export function resolveDiagnosticsSettings(
  workspace: string,
  cfg?: { diagnostics?: Partial<DiagnosticSettings> },
): DiagnosticSettings {
  return normalizeDiagnosticSettings({
    ...cfg?.diagnostics,
    ...readDiagnosticsFromMemory(workspace),
  });
}
