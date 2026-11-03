import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GRAPHIFY_PIN } from "./config.js";
import { buildChildEnv } from "./env.js";
import { engineExecutables, runtimeDir, venvDir } from "./paths.js";
import { run } from "./proc.js";
import type { CodeGraphRuntimeState } from "./types.js";

export interface RuntimeCheck {
  state: CodeGraphRuntimeState;
  version?: string;
  detail?: string;
  executables: ReturnType<typeof engineExecutables>;
}

/**
 * Interpreter start-up hooks run code even when nothing imports the package
 * (the LiteLLM 1.107.0 `.pth` incident). The hash-locked 0.9.95 venv contains
 * none of these on Linux (OBSERVED on the box). DEVIATION on Windows: the lock
 * itself installs `pywin32` (marker `sys_platform == 'win32'`), whose
 * `pywin32.pth` legitimately imports `pywin32_bootstrap`; and `uv venv` writes
 * `_virtualenv.pth` (imports `_virtualenv`). Both are provenance-verified by the
 * hash lock / our own installer, so only these two names are allowed — any
 * other .pth / sitecustomize is still treated as tampering.
 */
const STARTUP_HOOK_ALLOWLIST = new Set(["_virtualenv.pth", "pywin32.pth"]);

export function findStartupHooks(venv: string): string[] {
  const hits: string[] = [];
  const roots = [path.join(venv, "Lib", "site-packages")]; // Windows layout
  const lib = path.join(venv, "lib");
  if (fs.existsSync(lib)) for (const d of fs.readdirSync(lib)) roots.push(path.join(lib, d, "site-packages")); // POSIX layout
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    for (const f of fs.readdirSync(r)) {
      if (f === "sitecustomize.py" || f === "usercustomize.py" || (f.endsWith(".pth") && !STARTUP_HOOK_ALLOWLIST.has(f))) hits.push(path.join(r, f));
    }
  }
  return hits;
}

/** Ready = both console scripts exist, no start-up hooks, and `graphify --version` prints exactly the pinned version. */
export async function checkRuntime(home: string): Promise<RuntimeCheck> {
  const exe = engineExecutables(home);
  if (!fs.existsSync(exe.graphify) || !fs.existsSync(exe.graphifyMcp)) {
    return { state: "not-installed", executables: exe };
  }
  const hooks = findStartupHooks(path.dirname(path.dirname(exe.graphify)));
  if (hooks.length > 0) return { state: "broken", detail: `unexpected interpreter start-up hooks: ${hooks.join(", ")}`, executables: exe };
  const env = buildChildEnv({ pathPrepend: [path.dirname(exe.graphify)] });
  const r = await run(exe.graphify, ["--version"], { cwd: home, env, timeoutMs: 30_000 });
  const m = /graphify\s+(\S+)/.exec(r.stdout + r.stderr);
  if (r.code !== 0 || !m) return { state: "broken", detail: (r.stderr || r.stdout).slice(-2000), executables: exe };
  if (m[1] !== GRAPHIFY_PIN.version) return { state: "broken", version: m[1], detail: `expected ${GRAPHIFY_PIN.version}`, executables: exe };
  return { state: "ready", version: m[1], executables: exe };
}

export function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export interface InstallStep { label: string; file: string; args: string[]; env: Record<string, string> }

/**
 * Install plan (OD-1 default "managed"): a pinned uv binary shipped with Loam
 * provisions CPython 3.12 and a hash-locked venv. Network is used ONLY here
 * (python-build-standalone from GitHub, wheels from PyPI) and only after the
 * user consents in the Services card. Every wheel is verified by sha256 from
 * the committed lock (`--require-hashes`), no sdist builds (`--only-binary :all:`).
 */
export function installPlan(opts: { home: string; uvExe: string; lockFile: string; pinFile: string; platform?: NodeJS.Platform }): InstallStep[] {
  const rt = runtimeDir(opts.home);
  const pyDir = path.join(rt, "python");
  const venv = venvDir(opts.home);
  const platform = opts.platform ?? process.platform;
  const base = buildChildEnv({ pathPrepend: [path.dirname(opts.uvExe)], platform });
  const uvEnv: Record<string, string> = {
    ...base,
    UV_PYTHON_INSTALL_DIR: pyDir,
    UV_CACHE_DIR: path.join(opts.home, "uv-cache"),
    UV_NO_CONFIG: "1",                // ignore any user/system uv.toml
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_NO_PROGRESS: "1",
  };
  const venvPython = platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
  return [
    { label: "python", file: opts.uvExe, args: ["python", "install", GRAPHIFY_PIN.python], env: uvEnv },
    { label: "venv", file: opts.uvExe, args: ["venv", "--python", GRAPHIFY_PIN.python, venv], env: uvEnv },
    {
      label: "packages",
      file: opts.uvExe,
      args: ["pip", "install", "--python", venvPython, "--require-hashes", "--no-deps", "--only-binary", ":all:", "-r", opts.lockFile, "-r", opts.pinFile],
      env: uvEnv,
    },
  ];
}

/** Content of the graphifyy pin file passed alongside the dependency lock. */
export function pinFileContent(): string {
  return `${GRAPHIFY_PIN.distribution}==${GRAPHIFY_PIN.version} \\\n    --hash=sha256:${GRAPHIFY_PIN.wheelSha256}\n`;
}

export async function installRuntime(opts: {
  home: string;
  uvExe: string;
  /** Required: 64 lowercase hex. Empty or malformed refuses the install (fail closed). */
  uvSha256: string;
  lockFile: string;
  /** Required: 64 lowercase hex (GRAPHIFY_PIN.lockFileSha256). */
  lockSha256: string;
  signal?: AbortSignal;
  onStep?: (label: string) => void;
}): Promise<{ ok: boolean; failedStep?: string; detail?: string; check?: RuntimeCheck }> {
  const HEX64 = /^[0-9a-f]{64}$/;
  if (!HEX64.test(opts.uvSha256)) return { ok: false, failedStep: "verify-uv", detail: "uv hash is not pinned" };
  if (!HEX64.test(opts.lockSha256)) return { ok: false, failedStep: "verify-lock", detail: "lock hash is not pinned" };
  if (!fs.existsSync(opts.uvExe) || sha256File(opts.uvExe) !== opts.uvSha256) return { ok: false, failedStep: "verify-uv", detail: "uv binary missing or hash mismatch" };
  if (!fs.existsSync(opts.lockFile) || sha256File(opts.lockFile) !== opts.lockSha256) return { ok: false, failedStep: "verify-lock", detail: "lock file missing or hash mismatch" };
  const rt = runtimeDir(opts.home);
  fs.mkdirSync(rt, { recursive: true });
  const pinFile = path.join(rt, "graphifyy-pin.txt");
  fs.writeFileSync(pinFile, pinFileContent(), "utf8");
  for (const step of installPlan({ home: opts.home, uvExe: opts.uvExe, lockFile: opts.lockFile, pinFile })) {
    opts.onStep?.(step.label);
    const r = await run(step.file, step.args, { cwd: rt, env: step.env, timeoutMs: 900_000, signal: opts.signal });
    if (r.code !== 0) return { ok: false, failedStep: step.label, detail: (r.stderr || r.stdout).slice(-4000) };
  }
  const check = await checkRuntime(opts.home);
  if (check.state !== "ready") return { ok: false, failedStep: "verify", detail: check.detail, check };
  // The uv cache is only needed during install; on NTFS it may be a full copy (~200 MB), so drop it.
  fs.rmSync(path.join(opts.home, "uv-cache"), { recursive: true, force: true });
  fs.writeFileSync(path.join(rt, "runtime-ok.json"), JSON.stringify({
    version: GRAPHIFY_PIN.version, wheelSha256: GRAPHIFY_PIN.wheelSha256, python: GRAPHIFY_PIN.python, installedAt: new Date().toISOString(),
  }, null, 2), "utf8");
  return { ok: true, check };
}

/** Remove the engine (venv + managed Python + uv cache). Graph stores are left unless purgeGraphs. */
export function uninstallRuntime(home: string, purgeGraphs = false): void {
  fs.rmSync(path.join(home, "runtime"), { recursive: true, force: true });
  fs.rmSync(path.join(home, "uv-cache"), { recursive: true, force: true });
  if (purgeGraphs) fs.rmSync(path.join(home, "projects"), { recursive: true, force: true });
}
