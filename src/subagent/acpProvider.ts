import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { scrubEnv } from "./env.js";
import * as acp from "./acpClient.js";
import { createInterrupt, waitForInterrupt, RESPONSE_SCHEMAS } from "../orchestration/durable/interrupts.js";
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
  // C4: real client capabilities from the orchestration config; the child can
  // only ask for what we actually implement.
  const settings: acp.AcpClientSettings = {
    advertiseFs: opts.cfg?.orchestration?.acp.advertiseFs ?? true,
    advertiseTerminal: opts.cfg?.orchestration?.acp.advertiseTerminal ?? false,
    passMcpServers: opts.cfg?.orchestration?.acp.passMcpServers ?? true,
    clientVersion: process.env.npm_package_version ?? "0.0.0",
  };
  let acpSessionId: string | undefined;
  let cancelSent = false;

  let text = "";
  let settled = false;
  let resolveResult!: (value: SubagentResult) => void;
  const resultPromise = new Promise<SubagentResult>((resolve) => {
    resolveResult = resolve;
  });

  const child = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    // C5: a traceparent lets the child join the run's trace when its caller
    // (the orchestrator or the C11 host) provides one.
    env: { ...scrubEnv(process.env, opts.env ?? {}), ...(opts.traceparent ? { TRACEPARENT: opts.traceparent } : {}) },
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
      cancelSent = true;
      dispose();
      finish("cancelled", text);
    } else {
      opts.signal.addEventListener(
        "abort",
        () => {
          if (settled) return;
          cancelSent = true;
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

  /**
   * C4: every server-initiated request goes through the ACP client — scoped
   * fs, permission brokering through Loam's `acp_permission` interrupt (or
   * the fixed policy), and JSON-RPC errors for anything not advertised.
   */
  async function handleServerRequest(msg: JsonRpcRequest): Promise<void> {
    const reply = await acp.handleServerRequest(msg.method, msg.params, {
      settings,
      fs: { roots: [opts.cwd], maxReadBytes: 2_000_000, maxWriteBytes: 5_000_000 },
      ...(opts.permissionPolicy === "allow" || opts.permissionPolicy === "reject" ? { fixedPolicy: opts.permissionPolicy } : {}),
      cancelled: () => cancelSent,
      onWrite: (p) => events.push({ type: "tool_call", name: `acp:write ${p}` }),
      broker: async (req, risk) => {
        const mode = opts.cfg?.orchestration?.acp.permissionDefault ?? "ask";
        if (mode === "reject") {
          const id = acp.pickOption(req.options, "reject");
          return id ? { optionId: id } : "cancelled";
        }
        if (mode === "allow_once" && risk === "low") {
          const id = acp.pickOption(req.options, "allow");
          return id ? { optionId: id } : "cancelled";
        }
        const rec = createInterrupt({
          taskId: opts.sessionId ?? "acp",
          kind: "acp_permission",
          payload: {
            title: req.toolCall.title ?? req.toolCall.kind ?? "ACP tool call",
            kind: req.toolCall.kind ?? "other",
            risk,
            // Never offer a *_always option to the user either.
            options: req.options.filter((o) => !String(o.kind).endsWith("_always")),
          },
          responseSchema: RESPONSE_SCHEMAS.acp_permission,
          ttlMs: 15 * 60_000,
          maxPendingPerTask: 20,
        });
        events.push({ type: "request_permission", id: rec.interruptId, sessionId: req.sessionId, options: rec.payload.options });
        const done = await waitForInterrupt<{ optionId: string }>(rec.interruptId, opts.signal);
        return done?.status === "resolved" && done.response ? { optionId: done.response.optionId } : "cancelled";
      },
    });
    write({ jsonrpc: "2.0", id: msg.id, ...reply });
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
      // C4: map the call onto a run-graph tool node payload when the agent
      // followed the canonical shape; the title stays the human label.
      const node = acp.toolCallNode(update);
      const title = typeof update["title"] === "string" ? update["title"] : "tool";
      events.push({ type: "tool_call", name: node?.title || title, ...(node ? { node } : {}) });
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
      if (typeof (msg as JsonRpcRequest).id !== "undefined") void handleServerRequest(msg as JsonRpcRequest).catch((err: unknown) => {
        events.push({ type: "error", message: `ACP server request failed: ${err instanceof Error ? err.message : String(err)}` });
      });
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
      // C4: tell the agent first (session/cancel notification), then close
      // stdin and reserve SIGKILL for after the grace period.
      cancelSent = true;
      if (acpSessionId && !stdinClosed) write({ jsonrpc: "2.0", ...acp.cancelNotification(acpSessionId) });
      dispose();
      finish("cancelled", text);
    },
  };

  try {
    await request("initialize", acp.initializeParams(settings));
    const created = (await request("session/new", acp.sessionNewParams(opts.cwd, opts.mcpServers ?? [], settings))) as { sessionId?: string };
    const sessionId = created?.sessionId;
    if (!sessionId) throw new Error("ACP session/new did not return a sessionId");
    acpSessionId = sessionId;
    // C4: model discovery and switching (opts.model was ignored before). A
    // failed switch keeps the agent's default model.
    const models = acp.extractModels(created);
    events.push({ type: "acp_models", agent: opts.command ?? "acp", current: models.current, available: models.available.map((m) => m.id) });
    const sw = opts.model && (opts.cfg?.orchestration?.acp.modelSelection ?? true) ? acp.modelSwitchRequest(sessionId, models, opts.model) : undefined;
    if (sw) await request(sw.method, sw.params).catch(() => undefined);
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
