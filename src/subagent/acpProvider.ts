import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { scrubEnv } from "./env.js";
import type {
  SubagentEvent,
  SubagentProvider,
  SubagentResult,
  SubagentRunHandle,
  SubagentStartOptions,
} from "./types.js";
import { EventQueue } from "./eventQueue.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type IncomingMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

/** Stateless ACP provider: one registered instance whose `start` reads the
 *  executable (command/args) from the per-call options. */
export function createAcpProvider(): SubagentProvider {
  return {
    name: "acp",
    start(opts: SubagentStartOptions): Promise<SubagentRunHandle> {
      return startAcp(opts);
    },
  };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_GRACE_MS = 2_000;

async function startAcp(opts: SubagentStartOptions): Promise<SubagentRunHandle> {
  if (!opts.command || opts.command.trim().length === 0) {
    throw new Error("ACP provider requires a command");
  }
  const id = randomUUID();
  const events = new EventQueue<SubagentEvent>();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;

  let text = "";
  let settled = false;
  let resolveResult!: (value: SubagentResult) => void;
  const resultPromise = new Promise<SubagentResult>((resolve) => {
    resolveResult = resolve;
  });

  const child = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    env: scrubEnv(process.env, opts.env ?? {}),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 1;
  let buffer = "";
  const pending = new Map<string | number, PendingRequest>();
  let killTimer: NodeJS.Timeout | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stdinClosed = false;

  if (opts.signal) {
    if (opts.signal.aborted) {
      dispose();
      finish("cancelled", text);
    } else {
      opts.signal.addEventListener(
        "abort",
        () => {
          if (settled) return;
          dispose();
          finish("cancelled", text);
        },
        { once: true },
      );
    }
  }

  function write(message: unknown): void {
    if (stdinClosed || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method: string, params?: unknown): Promise<unknown> {
    const requestId = nextId++;
    return new Promise((resolve, reject) => {
      if (settled) {
        reject(new Error("subagent cancelled"));
        return;
      }
      pending.set(requestId, { resolve, reject });
      write({ jsonrpc: "2.0", id: requestId, method, params });
    });
  }

  function notification(method: string, params?: unknown): void {
    write({ jsonrpc: "2.0", method, params });
  }

  function finish(stopReason: SubagentResult["stopReason"], finalText: string): void {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    events.close();
    // Unblock any in-flight startup request (e.g. initialize) so a cancel during
    // the handshake cannot leave startAcp awaiting forever.
    const err = new Error("subagent cancelled");
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
    resolveResult({ stopReason, text: finalText });
  }

  function dispose(): void {
    if (stdinClosed) {
      if (killTimer) return;
    }
    stdinClosed = true;
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    if (killTimer) clearTimeout(killTimer);
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, graceMs);
    killTimer.unref?.();
    child.once("exit", () => {
      if (killTimer) clearTimeout(killTimer);
    });
  }

  function handleResponse(msg: JsonRpcResponse): void {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
  }

  function permissionOutcome(options: PermissionOption[]): Record<string, unknown> {
    if (opts.permissionPolicy !== "allow") return { outcome: "cancelled" };
    const allow = options.find((o) => (o.kind ?? "").startsWith("allow")) ?? options[0];
    if (!allow) return { outcome: "cancelled" };
    return { outcome: "selected", optionId: allow.optionId };
  }

  function handleServerRequest(msg: JsonRpcRequest): void {
    if (msg.method === "session/request_permission") {
      const params = (msg.params ?? {}) as { sessionId?: string; options?: PermissionOption[] };
      const options = Array.isArray(params.options) ? params.options : [];
      events.push({
        type: "request_permission",
        id: String(msg.id),
        sessionId: String(params.sessionId ?? ""),
        options,
      });
      write({ jsonrpc: "2.0", id: msg.id, result: { outcome: permissionOutcome(options) } });
      return;
    }
    write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unsupported method: ${msg.method}` } });
  }

  function handleUpdate(params: unknown): void {
    const update = (params as { update?: Record<string, unknown> } | undefined)?.update;
    if (!update || typeof update !== "object") return;
    // Canonical ACP uses `sessionUpdate`; accept `update` as a lenient alias.
    const kind = (update["sessionUpdate"] ?? update["update"]) as string | undefined;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const content = update["content"] as { type?: string; text?: string } | undefined;
      if (content?.type === "text" && typeof content.text === "string") {
        text += content.text;
        events.push({ type: "text", text: content.text });
      }
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const title = update["title"];
      events.push({ type: "tool_call", name: typeof title === "string" ? title : "tool" });
      return;
    }
    events.push({ type: "update", data: update });
  }

  function handleNotification(msg: JsonRpcNotification): void {
    if (msg.method === "session/update") handleUpdate(msg.params);
  }

  function handleLine(line: string): void {
    if (line.trim().length === 0) return;
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(line) as IncomingMessage;
    } catch {
      events.push({ type: "error", message: `Failed to parse ACP message: ${line.slice(0, 200)}` });
      return;
    }
    if (typeof (msg as JsonRpcResponse).id !== "undefined" && ("result" in msg || "error" in msg)) {
      handleResponse(msg as JsonRpcResponse);
      return;
    }
    if (typeof (msg as JsonRpcRequest).method === "string") {
      if (typeof (msg as JsonRpcRequest).id !== "undefined") handleServerRequest(msg as JsonRpcRequest);
      else handleNotification(msg as JsonRpcNotification);
    }
  }

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const message = chunk.toString().trim();
    if (message) events.push({ type: "error", message: message.slice(0, 500) });
  });

  child.on("error", (err: Error) => {
    if (!settled) {
      finish("error", text);
      events.push({ type: "error", message: err.message });
    }
  });

  child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled) return;
    const detail = signal ? `killed by ${signal}` : `exited with code ${code ?? "unknown"}`;
    events.push({ type: "error", message: `ACP process ${detail}` });
    finish("error", text);
  });

  timer = setTimeout(() => {
    if (settled) return;
    events.push({ type: "error", message: `ACP subagent timed out after ${timeoutMs}ms` });
    dispose();
    finish("timeout", text);
  }, timeoutMs);
  timer.unref?.();

  const handle: SubagentRunHandle = {
    id,
    events,
    result: () => resultPromise,
    cancel() {
      if (settled) return;
      dispose();
      finish("cancelled", text);
    },
  };

  try {
    await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = (await request("session/new", { cwd: opts.cwd, mcpServers: [] })) as { sessionId?: string };
    const sessionId = created?.sessionId;
    if (!sessionId) throw new Error("ACP session/new did not return a sessionId");
    const promptId = nextId++;
    pending.set(promptId, {
      resolve: (value) => {
        const stopReason = ((value as { stopReason?: string } | undefined)?.stopReason ?? "completed");
        dispose();
        finish(stopReason === "error" ? "error" : "completed", text);
      },
      reject: (err) => {
        dispose();
        events.push({ type: "error", message: err.message });
        finish("error", text);
      },
    });
    write({ jsonrpc: "2.0", id: promptId, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: opts.prompt }] } });
  } catch (err) {
    // A cancellation (parent signal or explicit cancel) during startup already
    // settled the result; surface the handle rather than a startup failure.
    if (settled) return handle;
    dispose();
    if (err instanceof Error) events.push({ type: "error", message: err.message });
    throw err;
  }

  return handle;
}
