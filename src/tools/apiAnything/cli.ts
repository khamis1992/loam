import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { redact } from "../../log.js";
import { MINIMAL_ENV_KEYS } from "../mcp.js";
import { CLI_STDOUT_MAX, HOME_DIR, cliEntry, pkgDir } from "./constants.js";
import type { ApiAnythingConfig, ChildProbe, CliRun } from "./types.js";

/** Same minimal environment as the MCP server (src/tools/mcp.ts childEnv, envMode "minimal"). */
export function cliEnv(cfg: ApiAnythingConfig): Record<string, string> {
  const allow = new Set(MINIMAL_ENV_KEYS.map((k) => k.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && allow.has(k.toUpperCase())) env[k] = v;
  env.API_ANYTHING_HOME = HOME_DIR;
  env.API_ANYTHING_BROWSER = cfg.browser;
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

/** Query/JSON string values of 32+ token characters containing letters and digits. */
const TOKEN = /(?<![A-Za-z0-9+=_-])(?=[A-Za-z0-9+=_-]*[A-Za-z])(?=[A-Za-z0-9+=_-]*\d)[A-Za-z0-9+=_-]{32,}(?![A-Za-z0-9+=_-])/g;

/** Loam's keyword redaction plus long-token redaction. Keeps JSON valid (no quotes introduced). */
export function redactLearnOutput(text: string): string {
  return redact(text).replace(TOKEN, (m) => `<redacted:${m.length} chars>`);
}

function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    const r = spawnSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    if (r.status !== 0) child.kill();
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function spawnChild(args: string[], cfg: ApiAnythingConfig, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<CliRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    if (opts.signal?.aborted) {
      resolve({ code: -1, json: undefined, stderr: "", timedOut: false, aborted: true, overflow: false, ms: 0 });
      return;
    }
    fs.mkdirSync(HOME_DIR, { recursive: true });
    const child = spawn(process.execPath, args, {
      cwd: HOME_DIR,
      env: cliEnv(cfg),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let overflow = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      killTree(child);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length + chunk.length > CLI_STDOUT_MAX) {
        overflow = true;
        killTree(child);
        return;
      }
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8_192);
    });
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const last = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      let json: unknown;
      if (last) {
        try {
          json = JSON.parse(last);
        } catch {
          json = undefined;
        }
      }
      const nextLine = stderr.split(/\r?\n/).reverse().find((l) => l.startsWith("next: "));
      resolve({
        code,
        json,
        next: nextLine ? nextLine.slice("next: ".length).trim() : undefined,
        stderr: redactLearnOutput(stderr.slice(-2_000)),
        timedOut,
        aborted,
        overflow,
        ms: Date.now() - started,
      });
    };
    child.on("error", (err: Error) => {
      stderr += err.message;
      finish(-1);
    });
    child.on("close", (code: number | null) => finish(code ?? -1));
  });
}

/** Run `api-anything <argv…>` from the vendored payload. Never uses a shell. */
export function runCli(argv: string[], cfg: ApiAnythingConfig, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<CliRun> {
  return spawnChild([cliEntry(), ...argv], cfg, opts);
}

/**
 * Ask the vendored code (not Loam) which Node and browser it sees and whether each site's jar
 * counts as signed in. Returns booleans, counts and the session source label only: no values.
 */
export async function probeChild(cfg: ApiAnythingConfig): Promise<ChildProbe | { error: string }> {
  const dist = (f: string): string => JSON.stringify(pathToFileURL(path.join(pkgDir(), "dist", f)).href);
  const script = [
    `import { browserChoice } from ${dist("browser.js")};`,
    `import { loadSession, loggedIn } from ${dist("session.js")};`,
    `import { listSites, loadSite } from ${dist("store.js")};`,
    "const sites = listSites().map((name) => {",
    "  try {",
    "    const r = loadSite(name); const s = loadSession(name);",
    "    return { name, loggedIn: loggedIn(s.cookies, r.site.loginCookies), cookieCount: s.cookies.length, source: s.source ?? null, updatedAt: s.updatedAt ?? null };",
    "  } catch (e) { return { name, error: String(e && e.message).slice(0, 200) }; }",
    "});",
    "const b = browserChoice();",
    "console.log(JSON.stringify({ node: process.versions.node, platform: process.platform, browser: b ? { name: b.name, bin: b.bin } : null, sites }));",
  ].join("\n");
  const run = await spawnChild(["--input-type=module", "-e", script], cfg, { timeoutMs: 20_000 });
  if (run.code !== 0 || !run.json || typeof run.json !== "object") return { error: run.stderr || `exit ${run.code}` };
  return run.json as ChildProbe;
}
