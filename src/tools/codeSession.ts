import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DATA_DIR, ROOT } from "../config.js";
import {
  SharedControlClient,
  defaultCodeSessionSocketPath,
  isNamedPipePath,
  waitForSharedSocket,
} from "../server/sharedCodeSession.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str, strs } from "./registry.js";

const execFileAsync = promisify(execFile);

const DEFAULT_MODEL = "longcat/LongCat-2.5-Preview";
const DEFAULT_MAX_CONCURRENT = 4;
const MAX_LOG_LINES = 30;
const MAX_DIFF_CHARS = 20_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** How a code_session runs: one process per task, or a shared long-lived server. */
export type CodeSessionLauncher = "per-process" | "shared";

/** Project root of the Loam app (src/tools -> ../..). */
const APP_ROOT = (() => {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  } catch {
    return ROOT;
  }
})();
const SHARED_SERVER_ENTRY = path.join(APP_ROOT, "src", "server", "sharedCodeSession.ts");

export interface CodeSessionSpawnOptions {
  cwd: string;
  stdio: ["ignore", "pipe", "pipe"];
  windowsHide: boolean;
  env: NodeJS.ProcessEnv;
}

export type CodeSessionSpawnImpl = (
  file: string,
  args: string[],
  options: CodeSessionSpawnOptions,
) => ChildProcess;

export interface SharedServerSpawnOptions {
  cwd: string;
  stdio: ["ignore", "pipe", "pipe"];
  windowsHide: boolean;
  env: NodeJS.ProcessEnv;
}

export type SharedServerSpawnImpl = (
  file: string,
  args: string[],
  options: SharedServerSpawnOptions,
) => ChildProcess;

export interface CreateCodeSessionToolsOptions {
  /** opencode binary to run. Defaults to LOAM_OPENCODE_BIN then "opencode". */
  opencodeBin?: string;
  /** Injection point for tests / alternate runtimes. */
  spawnImpl?: CodeSessionSpawnImpl;
  /** Repo root override; defaults to the run's workspace. */
  workspace?: string;
  /** Directory for logs and briefs; defaults to the app data dir. */
  dataDir?: string;
  /** Hard cap on simultaneously running sessions. */
  maxConcurrent?: number;
  /** Which launcher shape to use. Defaults to LOAM_CODE_SESSION_LAUNCHER then "per-process". */
  launcher?: CodeSessionLauncher;
  /** Injection point for the shared launcher's server spawn (tests). */
  sharedServerSpawnImpl?: SharedServerSpawnImpl;
  /** Base URL the shared server's model client talks to. */
  sharedModelUrl?: string;
  /** Shared-server entry path override (tests). */
  sharedServerEntry?: string;
  /**
   * Pin the shared server to `sharedModelUrl` only: no coding-router or
   * failover-chain re-routing. Defaults to `LOAM_CODE_SESSION_PIN_LOCAL === "1"`.
   */
  sharedPinToLocalModel?: boolean;
  /**
   * Environment the shared server's per-session agent loops see when they
   * resolve the coding router. Defaults to `process.env`.
   */
  sharedRunEnv?: Record<string, string | undefined>;
}

type CodeSessionStatus = "running" | "done" | "failed";

interface CodeSession {
  id: string;
  branch: string;
  worktree: string;
  repo: string;
  base: string;
  model: string;
  logPath: string;
  launcher: CodeSessionLauncher;
  startedAt: number;
  endedAt: number | null;
  status: CodeSessionStatus;
  exitCode: number | null;
  error: string | null;
  /** Session id inside the shared server (shared launcher only). */
  sharedId?: string;
  steps?: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(content: string): ToolResult {
  return { ok: false, content };
}

async function git(repo: string, args: string[], timeoutMs = 20_000): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function resolveRepoRoot(workspace: string): Promise<string> {
  const root = (await git(workspace, ["rev-parse", "--show-toplevel"])).trim();
  if (!root) throw new Error("git returned an empty repository root");
  return path.resolve(root);
}

function makeId(name?: string): string {
  const slug = (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const rand = Math.random().toString(36).slice(2, 8);
  return slug ? `${slug}-${rand}` : rand;
}

function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

function readLogTail(logPath: string, lines: number): string[] {
  let content: string;
  try {
    content = fs.readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const all = content.split(/\r?\n/);
  while (all.length > 0 && all[all.length - 1] === "") all.pop();
  return all.slice(-lines);
}

const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g;
const BASE64_PATTERN = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;
const HEX_PATTERN = /\b[a-f0-9]{40,}\b/gi;

/** Strip material that looks like an API key or long opaque token from logs. */
export function redactSecrets(input: string): string {
  return input
    .replace(API_KEY_PATTERN, "[redacted]")
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(JWT_PATTERN, "[redacted]")
    .replace(BASE64_PATTERN, "[redacted]")
    .replace(HEX_PATTERN, "[redacted]");
}

function humanElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function buildBrief(task: string, acceptance: string, filesHint: string[]): string {
  const lines = [
    "# Code session brief",
    "",
    "## Task",
    task,
    "",
    "## Acceptance criteria",
    acceptance,
  ];
  if (filesHint.length > 0) {
    lines.push("", "## Files to focus on");
    for (const f of filesHint) lines.push(`- ${f}`);
  }
  lines.push(
    "",
    "## Rules",
    "- Work ONLY inside this git worktree.",
    "- Commit your changes when the task is complete.",
    "- Do NOT push, merge, or remove the worktree.",
  );
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Shared launcher: one long-lived server hosting many sessions (J1).
// ---------------------------------------------------------------------------

/** True when a path is a usable control socket on this platform. */
export function isSharedSocketPath(socketPath: string): boolean {
  return process.platform === "win32" ? isNamedPipePath(socketPath) : !isNamedPipePath(socketPath);
}

/**
 * Keep one long-lived shared agent server for the launcher. The first session
 * spawns it; later sessions reuse it, so N tasks cost one process instead of N
 * (the J1 win). Each control connection is independent and concurrency-safe.
 */
export class SharedCodeSessionServer {
  private child: ChildProcess | null = null;
  private socketPath = "";
  private readonly clients = new Set<SharedControlClient>();

  constructor(
    private readonly spawnImpl?: SharedServerSpawnImpl,
    private readonly entryPath?: string,
    private readonly runEnv?: Record<string, string | undefined>,
    private readonly pinToLocalModel?: boolean,
  ) {}

  /** Entry point of the shared server; defaults to src/server/sharedCodeSession.ts. */
  entry(): string {
    return this.entryPath ?? SHARED_SERVER_ENTRY;
  }

  /** Spawn (or reuse) the server. Resolves once its control socket accepts. */
  async start(modelUrl: string, model: string): Promise<string> {
    if (this.child) return this.socketPath;
    const socketPath = defaultCodeSessionSocketPath();
    const entry = this.entry();
    const impl =
      this.spawnImpl ??
      ((file: string, args: string[], options: SharedServerSpawnOptions) =>
        spawn(process.execPath, ["--import", "tsx", file, ...args], options));
    const child = impl(entry, [socketPath, modelUrl, model, "1", this.pinToLocalModel ? "1" : "0"], {
      cwd: APP_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...(this.runEnv ?? process.env),
        LOAM_CODE_SESSION_LAUNCHER: "shared",
      },
    });
    this.child = child;
    this.socketPath = socketPath;
    await waitForSharedSocket(socketPath);
    return socketPath;
  }

  /** Open a control connection; safe to call concurrently. */
  async connect(): Promise<SharedControlClient> {
    const client = new SharedControlClient(this.socketPath);
    await client.connect();
    this.clients.add(client);
    return client;
  }

  /** Stop the shared server (idempotent). */
  stop(): void {
    const child = this.child;
    this.child = null;
    for (const client of this.clients) void client.close().catch(() => undefined);
    this.clients.clear();
    if (!child) return;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get running(): boolean {
    return this.child !== null;
  }
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createCodeSessionTools(options: CreateCodeSessionToolsOptions = {}): Tool[] {
  const opencodeBin = options.opencodeBin ?? process.env.LOAM_OPENCODE_BIN ?? "opencode";
  // A JS fixture/bin is not directly executable on every platform (Windows
  // throws EFTYPE/EINVAL for .js/.cjs/.cmd), so run it through the current
  // Node runtime. Native executables are spawned as-is.
  const isScriptBin = /\.(?:[cm]?js)$/i.test(opencodeBin);
  const spawnImpl: CodeSessionSpawnImpl =
    options.spawnImpl ??
    ((file, args, spawnOptions) =>
      isScriptBin ? spawn(process.execPath, [file, ...args], spawnOptions) : spawn(file, args, spawnOptions));
  const dataDir = options.dataDir ?? DATA_DIR;
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  const launcher: CodeSessionLauncher =
    options.launcher ??
    (process.env.LOAM_CODE_SESSION_LAUNCHER === "shared" ? "shared" : "per-process");
  const sharedServer = new SharedCodeSessionServer(
    options.sharedServerSpawnImpl,
    options.sharedServerEntry,
    options.sharedRunEnv,
    options.sharedPinToLocalModel ?? process.env.LOAM_CODE_SESSION_PIN_LOCAL === "1",
  );
  const sessions = new Map<string, CodeSession>();

  function sessionDir(): string {
    return path.join(dataDir, "code-sessions");
  }

  async function start(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const task = str(args, "task").trim();
    if (!task) return fail("code_session requires a non-empty task");
    const acceptance = str(args, "acceptance").trim();
    if (!acceptance) return fail("code_session requires a non-empty acceptance");

    const repo = options.workspace ?? ctx.workspace;
    if (!repo) return fail("code_session requires a git workspace");

    const running = [...sessions.values()].filter((s) => s.status === "running").length;
    if (running >= maxConcurrent) {
      return fail(`max concurrent code sessions reached (${maxConcurrent}); wait for one to finish`);
    }

    let root: string;
    try {
      root = await resolveRepoRoot(repo);
    } catch (err) {
      return fail(`code_session requires a git repository: ${errorMessage(err)}`);
    }

    let base: string;
    try {
      const requested = str(args, "base").trim();
      base = requested || (await git(root, ["rev-parse", "HEAD"])).trim();
      if (!base) return fail("could not resolve the base commit");
    } catch (err) {
      return fail(`could not resolve the base commit: ${errorMessage(err)}`);
    }

    const id = makeId(str(args, "name"));
    if (!isValidId(id)) return fail(`generated an invalid session id: ${id}`);
    if (sessions.has(id)) return fail(`code session already exists: ${id}`);

    const branch = `loam/cs-${id}`;
    const worktree = path.join(root, ".loam", "code-sessions", id);
    if (fs.existsSync(worktree)) return fail(`worktree path already exists: ${worktree}`);

    try {
      fs.mkdirSync(path.dirname(worktree), { recursive: true });
      await git(root, ["worktree", "add", "-b", branch, worktree, base], 60_000);
    } catch (err) {
      return fail(`git worktree add failed: ${errorMessage(err)}`);
    }

    const model = str(args, "model").trim() || process.env.LOAM_CODE_MODEL || DEFAULT_MODEL;
    const filesHint = strs(args, "files_hint");
    const dir = sessionDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return fail(`could not create the session directory: ${errorMessage(err)}`);
    }

    const briefPath = path.join(dir, `${id}.brief.md`);
    const logPath = path.join(dir, `${id}.log`);
    try {
      fs.writeFileSync(briefPath, buildBrief(task, acceptance, filesHint), "utf8");
    } catch (err) {
      return fail(`could not write the session brief: ${errorMessage(err)}`);
    }

    const session: CodeSession = {
      id,
      branch,
      worktree,
      repo: root,
      base,
      model,
      logPath,
      launcher,
      startedAt: Date.now(),
      endedAt: null,
      status: "running",
      exitCode: null,
      error: null,
    };
    sessions.set(id, session);

    if (launcher === "shared") {
      return startShared(session, task, acceptance, filesHint, briefPath, logPath);
    }
    return startPerProcess(session, briefPath, model, logPath);
  }

  /** Per-process (BEFORE) shape: one child process for this task alone. */
  function startPerProcess(
    session: CodeSession,
    briefPath: string,
    model: string,
    logPath: string,
  ): ToolResult {
    const briefArgs = ["run", "-m", model, "-f", briefPath, "Execute the attached task"];
    let child: ChildProcess;
    try {
      child = spawnImpl(opencodeBin, briefArgs, {
        cwd: session.worktree,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env },
      });
    } catch (err) {
      session.status = "failed";
      session.error = errorMessage(err);
      session.endedAt = Date.now();
      return fail(`failed to start opencode: ${errorMessage(err)}`);
    }

    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    child.stdout?.on("data", (chunk: Buffer) => logStream.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => logStream.write(chunk));
    child.on("error", (err) => {
      session.error = session.error ?? err.message;
    });
    child.on("close", (code, signal) => {
      session.status = code === 0 && !session.error ? "done" : "failed";
      session.exitCode = code;
      session.endedAt = Date.now();
      if (signal) session.error = session.error ?? `terminated by signal ${signal}`;
      logStream.end();
    });

    return {
      ok: true,
      content: JSON.stringify({
        id: session.id,
        branch: session.branch,
        worktree: session.worktree,
        base: session.base,
        model,
        launcher: session.launcher,
        status: "running",
        log: logPath,
      }),
    };
  }

  /**
   * Shared (AFTER) shape: reuse one server process. The brief text is written to
   * the log so status/collect stay identical to the per-process launcher, and the
   * session is recorded as soon as the server accepts it (not when it finishes),
   * because the tool is asynchronous by design.
   */
  async function startShared(
    session: CodeSession,
    task: string,
    acceptance: string,
    filesHint: string[],
    briefPath: string,
    logPath: string,
  ): Promise<ToolResult> {
    const modelUrl = options.sharedModelUrl ?? process.env.LOAM_CODE_MODEL_URL ?? "http://127.0.0.1:11434";
    let socketPath: string;
    try {
      socketPath = await sharedServer.start(modelUrl, session.model);
    } catch (err) {
      session.status = "failed";
      session.error = errorMessage(err);
      session.endedAt = Date.now();
      return fail(`failed to start the shared code-session server: ${errorMessage(err)}`);
    }

    const brief = buildBrief(task, acceptance, filesHint);
    try {
      fs.appendFileSync(logPath, `${brief}\n`, "utf8");
    } catch {
      /* logging is best effort */
    }

    // Fire-and-track: create the session, then run its prompt. The tool returns
    // immediately so the caller can poll with code_session_status, exactly like
    // the per-process launcher.
    void (async () => {
      try {
        const control = await sharedServer.connect();
        const created = await control.send("create_session", session.worktree);
        const sharedId = typeof created.session === "string" ? created.session : "";
        if (!sharedId) throw new Error(`create_session returned ${JSON.stringify(created)}`);
        session.sharedId = sharedId;
        const reply = await control.send(
          "message",
          JSON.stringify({ session: sharedId, text: brief }),
        );
        const status = typeof reply.status === "string" ? reply.status : "failed";
        session.status = status === "done" ? "done" : "failed";
        session.steps = typeof reply.steps === "number" ? reply.steps : undefined;
        if (session.status === "failed") {
          session.error = redactSecrets(String(reply.error ?? "shared session failed"));
          fs.appendFileSync(logPath, `shared session failed: ${session.error}\n`, "utf8");
        } else {
          fs.appendFileSync(
            logPath,
            `shared session done (steps=${String(reply.steps ?? 0)})\n`,
            "utf8",
          );
        }
      } catch (err) {
        session.status = "failed";
        session.error = redactSecrets(errorMessage(err));
        try {
          fs.appendFileSync(logPath, `shared session error: ${session.error}\n`, "utf8");
        } catch {
          /* logging is best effort */
        }
      } finally {
        session.endedAt = Date.now();
      }
    })();

    return {
      ok: true,
      content: JSON.stringify({
        id: session.id,
        branch: session.branch,
        worktree: session.worktree,
        base: session.base,
        model: session.model,
        launcher: session.launcher,
        status: "running",
        sharedServerPid: sharedServer.pid,
        log: logPath,
      }),
    };
  }

  async function status(args: Record<string, unknown>): Promise<ToolResult> {
    const id = str(args, "id").trim();
    if (!isValidId(id)) return fail(`invalid code session id: ${id}`);
    const session = sessions.get(id);
    if (!session) return fail(`unknown code session: ${id}`);
    const endedAt = session.endedAt ?? Date.now();
    const elapsedMs = Math.max(0, endedAt - session.startedAt);
    const log = readLogTail(session.logPath, MAX_LOG_LINES).map(redactSecrets);
    return {
      ok: true,
      content: JSON.stringify({
        id: session.id,
        status: session.status,
        exitCode: session.exitCode,
        elapsedMs,
        elapsed: humanElapsed(elapsedMs),
        branch: session.branch,
        base: session.base,
        launcher: session.launcher,
        ...(session.launcher === "shared" && session.sharedId ? { sharedId: session.sharedId } : {}),
        ...(session.steps !== undefined ? { steps: session.steps } : {}),
        error: session.error ? redactSecrets(session.error) : null,
        log,
      }),
    };
  }

  async function collect(args: Record<string, unknown>): Promise<ToolResult> {
    const id = str(args, "id").trim();
    if (!isValidId(id)) return fail(`invalid code session id: ${id}`);
    const session = sessions.get(id);
    if (!session) return fail(`unknown code session: ${id}`);
    const range = `${session.base}..${session.branch}`;
    try {
      const commits = (await git(session.repo, ["log", "--oneline", range])).trim();
      const diffStat = (await git(session.repo, ["diff", "--stat", range])).trim();
      let diff = (await git(session.repo, ["diff", range], 30_000)).trim();
      if (diff.length > MAX_DIFF_CHARS) {
        diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n[...truncated ${diff.length - MAX_DIFF_CHARS} chars]`;
      }
      return {
        ok: true,
        content: JSON.stringify({ id, branch: session.branch, base: session.base, commits, diffStat, diff }),
      };
    } catch (err) {
      return fail(`code_session_collect failed: ${errorMessage(err)}`);
    }
  }

  return [
    {
      name: "code_session",
      description:
        "Run a coding task in an isolated git worktree. Creates a branch loam/cs-<id> under <repo>/.loam/code-sessions/<id> and returns immediately. The default launcher spawns one opencode process per task (launcher \"per-process\"); pass launcher \"shared\" to host all sessions in a single long-lived agent server so N tasks cost one process instead of N. Use code_session_status to poll and code_session_collect to read the resulting commits and diff.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Self-contained coding task for the child session." },
          acceptance: { type: "string", description: "Concrete acceptance criteria the work must satisfy." },
          files_hint: { type: "array", items: { type: "string" }, description: "Optional files or areas to focus on." },
          model: { type: "string", description: "Model id for the session (defaults to LOAM_CODE_MODEL)." },
          base: { type: "string", description: "Commit or branch to branch from (default current HEAD)." },
          name: { type: "string", description: "Optional stable name folded into the session id and branch." },
          launcher: {
            type: "string",
            enum: ["per-process", "shared"],
            description:
              "\"per-process\" (default) runs one heavyweight process per task; \"shared\" reuses one long-lived agent server for every session, which is far cheaper in RAM per session.",
          },
        },
        required: ["task", "acceptance"],
      },
      run: start,
    },
    {
      name: "code_session_status",
      description:
        "Report whether a code_session is running, done or failed, with its exit code, elapsed time and the last log lines (secrets redacted).",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Session id returned by code_session." } },
        required: ["id"],
      },
      run: status,
    },
    {
      name: "code_session_collect",
      description:
        "Collect the commits and diff produced by a code_session without merging or pushing. Returns git log and a truncated diff for base..branch.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Session id returned by code_session." } },
        required: ["id"],
      },
      run: collect,
    },
  ];
}
