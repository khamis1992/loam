// Adapted from jcode (MIT) ref/jcode_daemon_bench.py and ref/SESSION_HIBERNATION.md
// (one long-lived server hosting N sessions instead of one process per task)
//
// J1 "shared" coding-session engine: ONE long-lived process hosts N concurrent
// Loam agent sessions. The original design (jcode) starts a single daemon and
// creates sessions through its debug socket; here the transport is plain JSON
// lines over a Unix socket (Windows: a named pipe) so it works on every platform
// without a TTY, and the session lifecycle keeps the same shape:
//
//   create_session:<cwd>   -> { ok, session }
//   message:<json>         -> { ok, status, session, steps, error? }
//   sessions               -> { ok, sessions: [...] }
//   shutdown               -> { ok, shuttingDown }
//
// This is the engine behind the `code_session` `launcher: "shared"` option and
// the "AFTER" launcher of the J1 memory benchmark. Because every session shares
// one process image, the marginal cost of a session is its own conversation
// state rather than a whole Node runtime.
import net, { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, type RunOptions, type RunResult } from "../agent/loop.js";
import { loadConfig, type Config } from "../config.js";
import { log } from "../log.js";
import { OllamaClient } from "../ollama.js";
import { fileTools } from "../tools/files.js";
import { shellTools } from "../tools/shell.js";
import { createMultiEditTools } from "../tools/multiEdit.js";
import { createTodoTools } from "../tools/todoTools.js";
import { createPhaseTools } from "../tools/phaseTools.js";
import { createFinishTools } from "../tools/finishTools.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Emit } from "../agent/events.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Default max agent steps per shared session. */
export const DEFAULT_SHARED_MAX_STEPS = 40;

/** Default prompt when a `message` carries no text. */
export const DEFAULT_SHARED_PROMPT = "Continue the task.";

export type SharedSessionStatus = "running" | "done" | "failed";

export interface SharedCodeSession {
  id: string;
  cwd: string;
  status: SharedSessionStatus;
  error: string | null;
  steps: number;
  startedAt: number;
  endedAt: number | null;
}

/** Wire shape of one session in the `sessions` listing. */
export interface SharedCodeSessionSummary {
  id: string;
  cwd: string;
  status: SharedSessionStatus;
  steps: number;
  error?: string;
}

export interface SharedCodeSessionServerOptions {
  /** Base URL of the model endpoint every session talks to. */
  modelUrl: string;
  /** Model id used by every session. */
  model: string;
  /** Control socket path; defaults to a per-process path. */
  socketPath?: string;
  /** Per-session agent step budget. */
  maxSteps?: number;
  /** Skip the terminal assistant_message/done events (headless callers). */
  suppressFinal?: boolean;
  /**
   * Pin every session to `modelUrl` only: disable the coding router and the
   * failover chain so no session can be re-routed to a real provider. The J1
   * bench sets this so its scripted fake model is the only endpoint in play.
   * Defaults to false (production sessions keep the configured chain).
   */
  pinToLocalModel?: boolean;
  /** Build the per-session config. Defaults to Loam's own `loadConfig()`. */
  configFactory?: (cwd: string) => Config;
  /** Tool registry shared by every session. Defaults to the coding tool set. */
  registry?: ToolRegistry;
  /** Diagnostic event sink. Defaults to a no-op. */
  emit?: Emit;
  /**
   * Environment snapshot the per-session agent loop sees when it resolves the
   * coding router (`chatWithCodingRouter`). Defaults to `process.env`. A caller
   * that wants to pin the server to one endpoint (the J1 bench, an isolated
   * worktree) passes a narrow copy instead of inheriting the host's failover
   * chain.
   */
  runEnv?: Record<string, string | undefined>;
}

/**
 * The standard Loam coding tool set for a shared session: read/edit/run plus the
 * planning tools the loop's reminder channels expect to exist.
 */
export function sharedCodeSessionRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(fileTools);
  registry.registerAll(shellTools);
  registry.registerAll(createMultiEditTools());
  registry.registerAll(createTodoTools());
  registry.registerAll(createPhaseTools());
  registry.registerAll(createFinishTools());
  return registry;
}

/**
 * One long-lived process hosting N concurrent agent sessions.
 *
 * Sessions never share conversation state; they share only the process image
 * (module graph, JIT code, model client). That is the whole point of the J1
 * measurement: the marginal cost of session N+1 is its own messages and tool
 * results, not another ~100 MB Node runtime.
 */
export class SharedCodeSessionServer {
  readonly sessions = new Map<string, SharedCodeSession>();
  private server: Server | null = null;
  private readonly clients = new Set<Socket>();
  private readonly modelUrl: string;
  private readonly model: string;
  private readonly maxSteps: number;
  private readonly suppressFinal: boolean;
  private readonly configFactory: (cwd: string) => Config;
  private readonly registry: ToolRegistry;
  private readonly emit: Emit;
  private readonly runEnv: Record<string, string | undefined>;
  private readonly pinToLocalModel: boolean;
  private socketPath: string;

  constructor(options: SharedCodeSessionServerOptions) {
    this.modelUrl = options.modelUrl;
    this.model = options.model;
    this.maxSteps = options.maxSteps ?? DEFAULT_SHARED_MAX_STEPS;
    this.suppressFinal = options.suppressFinal ?? true;
    this.registry = options.registry ?? sharedCodeSessionRegistry();
    this.configFactory =
      options.configFactory ??
      ((cwd) => {
        const cfg = loadConfig();
        cfg.model = this.model;
        cfg.fallbackModel = this.model;
        cfg.ollamaUrl = this.modelUrl;
        cfg.workspace = cwd;
        cfg.agent.maxSteps = this.maxSteps;
        // A shared session must never fall through to the user's configured
        // cloud endpoint (`:cloud` model ids). It is pinned to the server's
        // model URL, so drop the cloud config `loadConfig` may have picked up.
        cfg.cloudModel = undefined;
        if (this.pinToLocalModel) {
          // Also drop the router and the failover chain entirely: with routing
          // enabled a coding turn would still be handed to the host's real
          // providers, bypassing `modelUrl`.
          cfg.coding = { enabled: false, chain: [], logEdits: false };
          cfg.failover = { providers: [] };
        }
        return cfg;
      });
    this.emit = options.emit ?? (() => {});
    this.runEnv = options.runEnv ?? process.env;
    this.pinToLocalModel = options.pinToLocalModel ?? false;
    this.socketPath = options.socketPath ?? defaultCodeSessionSocketPath();
  }

  get pid(): number {
    return process.pid;
  }

  /** Absolute path of the control socket (or named pipe on Windows). */
  get socket(): string {
    return this.socketPath;
  }

  /** True once `listen()` has bound the socket. */
  get listening(): boolean {
    return this.server !== null && this.server.listening;
  }

  async listen(): Promise<void> {
    if (this.server) return;
    // A stale socket file from a crashed server must not block a fresh bind.
    // Named pipes on Windows do not exist as files, so only unlink POSIX paths.
    if (!isNamedPipePath(this.socketPath)) {
      try {
        fs.rmSync(this.socketPath, { force: true });
      } catch {
        /* best effort */
      }
    }
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.attach(socket));
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        this.server = server;
        resolve();
      });
    });
    log.info(`shared code-session server listening on ${this.socketPath}`);
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (!isNamedPipePath(this.socketPath)) {
      try {
        fs.rmSync(this.socketPath, { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  private attach(socket: Socket): void {
    this.clients.add(socket);
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length > 0) void this.handleLine(line, socket);
      }
    });
    const drop = (): void => {
      this.clients.delete(socket);
    };
    socket.on("close", drop);
    socket.on("error", drop);
  }

  /** Handle one control command; every reply is a single JSON line. */
  private handleLine(line: string, socket: Socket): void {
    const separator = line.indexOf(" ");
    const command = separator === -1 ? line : line.slice(0, separator);
    const payload = separator === -1 ? "" : line.slice(separator + 1).trim();
    void (async () => {
      try {
        if (command === "create_session") {
          this.reply(socket, { ok: true, session: this.createSession(payload) });
          return;
        }
        if (command === "message") {
          const session = await this.sendMessage(payload);
          this.reply(socket, {
            ok: session.status === "done",
            status: session.status,
            session: session.id,
            steps: session.steps,
            ...(session.error ? { error: session.error } : {}),
          });
          return;
        }
        if (command === "sessions") {
          this.reply(socket, { ok: true, sessions: this.listSessions() });
          return;
        }
        if (command === "shutdown") {
          this.reply(socket, { ok: true, shuttingDown: true });
          setTimeout(() => void this.close().finally(() => process.exit(0)), 25);
          return;
        }
        this.reply(socket, { ok: false, error: `unknown command: ${command}` });
      } catch (err) {
        this.reply(socket, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
  }

  private reply(socket: Socket, payload: Record<string, unknown>): void {
    try {
      socket.write(`${JSON.stringify(payload)}\n`);
    } catch {
      /* client gone */
    }
  }

  /** `create_session:<cwd>` — start a session and return its id. */
  createSession(cwd: string): string {
    const normalized = path.resolve(cwd || ".");
    const id = `s${randomUUID().slice(0, 8)}`;
    this.sessions.set(id, {
      id,
      cwd: normalized,
      status: "running",
      error: null,
      steps: 0,
      startedAt: Date.now(),
      endedAt: null,
    });
    return id;
  }

  /** `message:<json>` — run one prompt in a session; resolves when it finishes. */
  async sendMessage(payload: string): Promise<SharedCodeSession> {
    const request = JSON.parse(payload) as { session: string; text?: string };
    const session = this.sessions.get(request.session);
    if (!session) throw new Error(`unknown session: ${request.session}`);
    if (session.status !== "running") throw new Error(`session ${session.id} is ${session.status}`);
    const text = (request.text ?? "").trim() || DEFAULT_SHARED_PROMPT;
    const result = await this.runSession(session, text);
    session.status = result.status;
    session.error = result.error;
    session.steps = result.steps;
    session.endedAt = Date.now();
    return session;
  }

  private async runSession(
    session: SharedCodeSession,
    text: string,
  ): Promise<{ status: "done" | "failed"; error: string | null; steps: number }> {
    const cfg = this.configFactory(session.cwd);
    const options: RunOptions = {
      cfg,
      ollama: new OllamaClient(cfg.ollamaUrl, cfg.cloudModel),
      tools: this.registry,
      emit: this.emit,
      env: this.runEnv,
      prompt: text,
      suppressFinal: this.suppressFinal,
    };
    try {
      const result: RunResult = await runAgent(options);
      return { status: "done", error: null, steps: result.steps };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err), steps: 0 };
    }
  }

  listSessions(): SharedCodeSessionSummary[] {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      cwd: session.cwd,
      status: session.status,
      steps: session.steps,
      ...(session.error ? { error: session.error } : {}),
    }));
  }
}

/**
 * Client side of the control protocol: line-delimited JSON over a socket.
 *
 * One client owns one connection and serialises commands on it, so concurrent
 * callers must each hold their own client (the server accepts many connections).
 */
export class SharedControlClient {
  private socket: Socket | null = null;
  private buffer = "";
  private readonly waiters: Array<{ resolve: (line: string) => void; reject: (err: Error) => void }> = [];

  constructor(private readonly socketPath: string) {}

  connect(timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`timed out connecting to the shared code-session server at ${this.socketPath}`));
      }, timeoutMs);
      timer.unref?.();
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        let index: number;
        while ((index = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, index).trim();
          this.buffer = this.buffer.slice(index + 1);
          if (line.length === 0) continue;
          const waiter = this.waiters.shift();
          if (!waiter) continue;
          try {
            waiter.resolve(line);
          } catch (err) {
            waiter.reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      });
      socket.on("close", () => this.failWaiters(new Error("shared code-session control socket closed")));
    });
  }

  private failWaiters(err: Error): void {
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const waiter of pending) waiter.reject(err);
  }

  /** Send a command and resolve with the server's single JSON reply. */
  send(command: string, payload = ""): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("shared control client is not connected"));
    return new Promise((resolve, reject) => {
      this.waiters.push({
        resolve: (line) => {
          try {
            resolve(JSON.parse(line) as Record<string, unknown>);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
        reject,
      });
      socket.write(payload ? `${command} ${payload}\n` : `${command}\n`, (err) =>
        err ? reject(err) : undefined,
      );
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.failWaiters(new Error("shared control client closed"));
    if (!socket) return;
    await new Promise<void>((resolve) => {
      socket.end(() => resolve());
      socket.destroySoon?.();
    });
  }
}

/** Poll a control socket until it accepts a connection (server readiness). */
export async function waitForSharedSocket(socketPath: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = net.connect(socketPath);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    if (Date.now() >= deadline) {
      throw new Error(`shared code-session server did not become ready at ${socketPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Default control-socket location, unique per process so parallel runs never
 * clash. Windows must use a named pipe (`\\\\.\\pipe\\...`); a filesystem path
 * there fails with EACCES. POSIX uses a Unix socket file in the temp dir.
 */
export function defaultCodeSessionSocketPath(): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\loam-cs-${process.pid}`;
  return path.join(os.tmpdir(), `loam-cs-${process.pid}.sock`);
}

/** Named-pipe form on Windows, Unix socket file path elsewhere. */
export function isNamedPipePath(socketPath: string): boolean {
  return socketPath.startsWith("\\\\.\\pipe\\");
}

/** True when `id` is a valid shared-session id. */
export function isValidSessionId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/**
 * Entry point:
 * `node --import tsx src/server/sharedCodeSession.ts <socketPath> <modelUrl> <model> [suppressFinal] [pinToLocalModel]`
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [socketPathArg, modelUrl, model = "", suppress = "1", pin = "0"] = argv;
  if (!socketPathArg || !modelUrl) {
    process.stderr.write(
      "usage: sharedCodeSession.ts <socketPath> <modelUrl> <model> [suppressFinal] [pinToLocalModel]\n",
    );
    return 2;
  }
  const server = new SharedCodeSessionServer({
    socketPath: socketPathArg,
    modelUrl,
    model: model || "default",
    suppressFinal: suppress === "1",
    pinToLocalModel: pin === "1",
  });
  await server.listen();
  process.stdout.write(`listening ${server.socket}\n`);
  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Keep the event loop alive on the listening socket; nothing else is needed.
  return new Promise<number>(() => {});
}

// Run only when invoked directly (node --import tsx src/server/sharedCodeSession.ts ...).
const invokedDirectly = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false;
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`shared code-session server failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
