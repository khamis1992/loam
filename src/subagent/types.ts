/** Shared types for the ACP-style subagent delegation layer. */

import type { Config } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import type { ToolRegistry } from "../tools/registry.js";

export type SubagentProviderType = "in-process" | "acp";

/** Credential-scrubbed environment plus explicit caller extras. */
export interface SubagentEnv {
  /** Extra environment variables merged after scrubbing process.env. */
  extra?: Record<string, string>;
}

export interface SubagentStartOptions {
  provider: SubagentProviderType;
  prompt: string;
  cwd: string;
  model?: string;
  /** Overall wall-clock budget. Defaults to 120000ms. */
  timeoutMs?: number;
  /** Extra env variables for the ACP child (merged after scrubbing). */
  env?: Record<string, string>;
  /** ACP permission policy. Defaults to "reject". */
  permissionPolicy?: "allow" | "reject";
  /** Grace period in ms before SIGKILL after closing stdin. Defaults to 2000. */
  graceMs?: number;
  /** ACP executable + args. Required when provider is "acp". */
  command?: string;
  args?: string[];
  /** MCP servers the task already granted; passed to session/new (never vault credentials). */
  mcpServers?: Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> } | { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }>;
  /** W3C traceparent so the ACP child can join the run's trace. */
  traceparent?: string;
  /** Current delegation depth (0 = top-level). Used to enforce maxDepth. */
  depth?: number;
  /** Max tool steps for the in-process child loop. Defaults to 20. */
  maxSteps?: number;
  /** Stable session id for this child inside its workspace. Distinct children get
   *  distinct ids so cross-session file-touch notices reach the right run (jcode J8). */
  sessionId?: string;
  /** Runtime dependencies for the in-process provider. */
  cfg?: Config;
  ollama?: OllamaClient;
  tools?: ToolRegistry;
  /** Parent run signal; when it aborts the child is cancelled too. */
  signal?: AbortSignal;
}

export type SubagentEvent =
  | { type: "text"; text: string }
  | { type: "update"; data: unknown }
  | { type: "error"; message: string }
  | { type: "tool_call"; name: string; node?: { id: string; title: string; kind: string; status: string; paths: string[] } }
  | { type: "request_permission"; id: string; sessionId: string; options: unknown }
  | { type: "acp_models"; agent: string; current: string | null; available: string[] };

export type SubagentStopReason = "completed" | "error" | "timeout" | "cancelled";

export interface SubagentResult {
  stopReason: SubagentStopReason;
  text: string;
}

export interface SubagentRunHandle {
  id: string;
  events: AsyncIterable<SubagentEvent>;
  result(): Promise<SubagentResult>;
  cancel(): void;
}

export interface SubagentProvider {
  name: string;
  start(opts: SubagentStartOptions): Promise<SubagentRunHandle>;
}
