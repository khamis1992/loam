/**
 * C4: the client side of the Agent Client Protocol that Loam's ACP provider
 * (src/subagent/acpProvider.ts) is missing today.
 *
 * OBSERVED in Loam 0.5.31 acpProvider.ts: initialize sends
 * clientCapabilities {} (:285), session/new sends mcpServers [] (:286),
 * opts.model is ignored, the only server request handled is
 * session/request_permission with a blind allow/cancel (first "allow*"
 * option or cancelled), every fs/* and terminal/* request gets -32601, and
 * cancel never sends session/cancel.
 *
 * OBSERVED in OpenHands SDK acp_agent.py: model discovery from the session
 * response (configOptions select, else the legacy `models` block) and
 * switching via session/set_config_option or session/set_model; fs/terminal
 * are NOT implemented there (NotImplementedError :1694-1750) and permissions
 * are auto-approved (:1652). Loam goes further on both: scoped fs and
 * permissions routed to Loam's own gate.
 *
 * Wire shapes follow agentclientprotocol.com/protocol (v1): initialization,
 * file-system, tool-calls, session-setup, session-config-options, prompt-turn.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface AcpClientSettings {
  advertiseFs: boolean;
  advertiseTerminal: boolean;
  passMcpServers: boolean;
  clientVersion: string;
}

export function initializeParams(s: AcpClientSettings) {
  return {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: s.advertiseFs, writeTextFile: s.advertiseFs },
      terminal: s.advertiseTerminal,
    },
    clientInfo: { name: "loam", title: "Loam", version: s.clientVersion },
  };
}

export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
  | { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> };

/** Loam passes only MCP servers the task already granted; never credentials from the vault. */
export function sessionNewParams(cwd: string, servers: AcpMcpServer[], s: AcpClientSettings) {
  return { cwd, mcpServers: s.passMcpServers ? servers : [] };
}

export interface AcpModelInfo {
  id: string;
  name: string;
  description?: string;
}
export interface AcpModelState {
  current: string | null;
  available: AcpModelInfo[];
  via: "config_option" | "legacy_models" | "none";
  configId?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Reads model state off a session/new or session/load result. */
export function extractModels(result: unknown): AcpModelState {
  if (!isObj(result)) return { current: null, available: [], via: "none" };
  const opts = Array.isArray(result.configOptions) ? result.configOptions : [];
  const modelOpt = opts.find((o) => isObj(o) && o.type === "select" && (o.category === "model" || o.id === "model"));
  if (isObj(modelOpt)) {
    const flat: unknown[] = [];
    for (const o of Array.isArray(modelOpt.options) ? modelOpt.options : []) {
      // Options may be grouped: { name, options: [...] } (session-config-options.md:135).
      if (isObj(o) && Array.isArray(o.options)) flat.push(...o.options);
      else flat.push(o);
    }
    const available = flat
      .filter(isObj)
      .filter((o) => typeof o.value === "string" && o.value)
      .map((o) => ({ id: o.value as string, name: typeof o.name === "string" ? o.name : (o.value as string), description: typeof o.description === "string" ? o.description : undefined }));
    return { current: typeof modelOpt.currentValue === "string" ? modelOpt.currentValue : null, available, via: "config_option", configId: String(modelOpt.id) };
  }
  if (isObj(result.models)) {
    const m = result.models;
    const available = (Array.isArray(m.availableModels) ? m.availableModels : [])
      .filter(isObj)
      .filter((o) => typeof o.modelId === "string" && o.modelId)
      .map((o) => ({ id: o.modelId as string, name: typeof o.name === "string" ? o.name : (o.modelId as string), description: typeof o.description === "string" ? o.description : undefined }));
    return { current: typeof m.currentModelId === "string" ? m.currentModelId : null, available, via: "legacy_models" };
  }
  return { current: null, available: [], via: "none" };
}

/** The request to switch model, or undefined when the agent cannot switch or the model is unknown. */
export function modelSwitchRequest(sessionId: string, state: AcpModelState, wanted: string): { method: string; params: Record<string, unknown> } | undefined {
  if (!wanted || wanted === state.current || !state.available.some((m) => m.id === wanted)) return undefined;
  if (state.via === "config_option") return { method: "session/set_config_option", params: { sessionId, configId: state.configId ?? "model", value: wanted } };
  if (state.via === "legacy_models") return { method: "session/set_model", params: { sessionId, modelId: wanted } };
  return undefined;
}

export const cancelNotification = (sessionId: string) => ({ method: "session/cancel", params: { sessionId } });

// ---------------------------------------------------------------------------
// Server-initiated requests
// ---------------------------------------------------------------------------

export type AcpToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind | string;
}
export interface PermissionRequest {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string; kind?: string; rawInput?: unknown; locations?: Array<{ path: string; line?: number | null }> };
  options: PermissionOption[];
}

/** Loam's decision port: in Loam it creates an `acp_permission` interrupt (durable/interrupts.ts). */
export type PermissionBroker = (req: PermissionRequest, risk: "low" | "high" | "unknown") => Promise<{ optionId: string } | "cancelled">;

const LOW_RISK: ReadonlySet<string> = new Set(["read", "search", "think"]);
const HIGH_RISK: ReadonlySet<string> = new Set(["edit", "delete", "move", "execute", "fetch", "switch_mode"]);

export function permissionRisk(kind: string | undefined): "low" | "high" | "unknown" {
  if (kind && LOW_RISK.has(kind)) return "low";
  if (kind && HIGH_RISK.has(kind)) return "high";
  return "unknown";
}

/** Never picks *_always: a child agent may not remember a grant beyond one call. */
export function pickOption(options: PermissionOption[], want: "allow" | "reject"): string | undefined {
  const exact = options.find((o) => o.kind === `${want}_once`);
  return (exact ?? options.find((o) => String(o.kind).startsWith(want) && !String(o.kind).endsWith("_always")))?.optionId;
}

export interface FsPolicy {
  roots: string[];
  maxReadBytes: number;
  maxWriteBytes: number;
  /** Optional hook so Loam can route writes through its own file pipeline (versioning, locks). */
  write?: (absPath: string, content: string) => Promise<void>;
}

const SECRET_FILE = /(^|[\\/])(\.env(\.[^\\/]*)?|id_rsa|id_ed25519|\.npmrc|\.netrc|credentials(\.json)?|[^\\/]+\.pem|[^\\/]+\.key)$/i;

export class AcpFsError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

async function realOrParent(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    const parent = await fs.realpath(path.dirname(p)).catch(() => path.dirname(p));
    return path.join(parent, path.basename(p));
  }
}

export async function resolveScoped(p: unknown, policy: FsPolicy): Promise<string> {
  if (typeof p !== "string" || !path.isAbsolute(p)) throw new AcpFsError(-32602, "path must be absolute");
  const real = await realOrParent(path.resolve(p));
  const roots = await Promise.all(policy.roots.map((r) => fs.realpath(r).catch(() => path.resolve(r))));
  const inside = roots.some((r) => real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
  if (!inside) throw new AcpFsError(-32001, "path is outside the task workspace");
  if (SECRET_FILE.test(real)) throw new AcpFsError(-32001, "secret files are not readable or writable by child agents");
  return real;
}

export async function readTextFile(params: Record<string, unknown>, policy: FsPolicy): Promise<{ content: string }> {
  const abs = await resolveScoped(params.path, policy);
  const st = await fs.stat(abs).catch(() => undefined);
  if (!st || !st.isFile()) throw new AcpFsError(-32002, "file not found");
  if (st.size > policy.maxReadBytes) throw new AcpFsError(-32003, `file larger than ${policy.maxReadBytes} bytes`);
  const text = await fs.readFile(abs, "utf8");
  const line = typeof params.line === "number" && params.line >= 1 ? Math.floor(params.line) : 1;
  const limit = typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : undefined;
  if (line === 1 && limit === undefined) return { content: text };
  const lines = text.split("\n");
  return { content: lines.slice(line - 1, limit === undefined ? undefined : line - 1 + limit).join("\n") };
}

export async function writeTextFile(params: Record<string, unknown>, policy: FsPolicy): Promise<Record<string, never>> {
  const abs = await resolveScoped(params.path, policy);
  if (typeof params.content !== "string") throw new AcpFsError(-32602, "content must be a string");
  if (Buffer.byteLength(params.content) > policy.maxWriteBytes) throw new AcpFsError(-32003, `content larger than ${policy.maxWriteBytes} bytes`);
  if (policy.write) await policy.write(abs, params.content);
  else {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, params.content, "utf8");
  }
  return {};
}

export interface ServerRequestContext {
  settings: AcpClientSettings;
  fs: FsPolicy;
  broker: PermissionBroker;
  /** "allow"/"reject" from SubagentStartOptions.permissionPolicy overrides the broker. */
  fixedPolicy?: "allow" | "reject";
  /** True once the client sent session/cancel: permissions must answer "cancelled". */
  cancelled: () => boolean;
  /** Paths written through fs/write_text_file, for the run graph and file-touch tracking. */
  onWrite?: (absPath: string) => void;
}

export type ServerReply = { result: unknown } | { error: { code: number; message: string } };

/** Replaces handleServerRequest in acpProvider.ts. */
export async function handleServerRequest(method: string, params: unknown, ctx: ServerRequestContext): Promise<ServerReply> {
  const p = isObj(params) ? params : {};
  try {
    if (method === "session/request_permission") {
      const req = p as unknown as PermissionRequest;
      const options = Array.isArray(req.options) ? req.options : [];
      if (ctx.cancelled()) return { result: { outcome: { outcome: "cancelled" } } };
      if (ctx.fixedPolicy) {
        const id = pickOption(options, ctx.fixedPolicy);
        return { result: { outcome: id ? { outcome: "selected", optionId: id } : { outcome: "cancelled" } } };
      }
      const decision = await ctx.broker(req, permissionRisk(req.toolCall?.kind));
      if (decision === "cancelled" || !options.some((o) => o.optionId === decision.optionId)) return { result: { outcome: { outcome: "cancelled" } } };
      return { result: { outcome: { outcome: "selected", optionId: decision.optionId } } };
    }
    if (method === "fs/read_text_file" && ctx.settings.advertiseFs) return { result: await readTextFile(p, ctx.fs) };
    if (method === "fs/write_text_file" && ctx.settings.advertiseFs) {
      const out = await writeTextFile(p, ctx.fs);
      ctx.onWrite?.(await resolveScoped(p.path, ctx.fs));
      return { result: out };
    }
    return { error: { code: -32601, message: `unsupported method ${method}` } };
  } catch (err) {
    if (err instanceof AcpFsError) return { error: { code: err.code, message: err.message } };
    return { error: { code: -32603, message: err instanceof Error ? err.message : String(err) } };
  }
}

/** Maps a session/update tool_call into a Loam run-graph tool node payload. */
export function toolCallNode(update: Record<string, unknown>): { id: string; title: string; kind: string; status: string; paths: string[] } | undefined {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return undefined;
  if (typeof update.toolCallId !== "string") return undefined;
  const locs = Array.isArray(update.locations) ? update.locations.filter(isObj).map((l) => String(l.path ?? "")).filter(Boolean) : [];
  return {
    id: update.toolCallId,
    title: typeof update.title === "string" ? update.title : "",
    kind: typeof update.kind === "string" ? update.kind : "other",
    status: typeof update.status === "string" ? update.status : "pending",
    paths: locs,
  };
}
