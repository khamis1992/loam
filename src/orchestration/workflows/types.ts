/**
 * C7: Loam Workflows (user-authored multi-agent graphs). Named "Workflows"
 * (UI: «مسارات العمل») to stay distinct from two things Loam already has:
 * the "automate" mode labelled "Loam Flow" (modes/catalog.ts:71) and the 12
 * prompt templates in templates/flows (served by /api/flow-templates).
 * Schema ideas from ChatDev 2.0 YAML graphs (Apache-2.0) and Mastra's step
 * DSL (Apache-2.0 part); engine semantics (supersteps + checkpoint per
 * superstep + interrupt) from LangGraph.js (MIT). All code is Loam's own.
 */
import type { JsonSchema } from "../contracts/schema.js";

export type NodeKind = "agent" | "tool" | "human" | "vote" | "condition" | "subworkflow" | "transform";

export type Condition =
  | { op: "eq" | "neq" | "contains" | "gt" | "lt"; path: string; value: string | number | boolean }
  | { op: "exists"; path: string }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export interface AgentNodeSpec {
  /** Template; `{{inputs.x}}` and `{{state.y}}` are substituted. */
  prompt: string;
  /** Loam mode id (ask, research, build, write, data, media, security, automate). */
  mode?: string;
  /** Optional cloud model; the local model is rejected at validation time. */
  model?: string;
  outputSchema?: JsonSchema;
  maxSteps?: number;
}

export interface WorkflowNode {
  id: string;
  kind: NodeKind;
  title?: string;
  /** State key the node's output is written to (not used by condition). */
  outputKey?: string;
  /** Run only after every listed node finished in the current pass (join). */
  waitFor?: string[];
  /** Max executions of this node in one run (loop guard). Default 10. */
  maxVisits?: number;
  agent?: AgentNodeSpec;
  tool?: { name: string; args: Record<string, unknown> };
  human?: { title: string; question: string; options?: string[]; ttlMs?: number };
  vote?: { from: string[]; goal: string };
  condition?: Condition;
  subworkflow?: { workflowId: string; inputs: Record<string, string> };
  transform?: { set: Record<string, string> };
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** Required on edges leaving a condition node: "true" or "false". */
  when?: "true" | "false";
}

export interface WorkflowDef {
  id: string;
  version: 1;
  title: string;
  description?: string;
  inputs: JsonSchema;
  start: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export type RunStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface WorkflowRunState {
  runId: string;
  workflowId: string;
  taskId: string;
  status: RunStatus;
  inputs: Record<string, unknown>;
  state: Record<string, unknown>;
  frontier: string[];
  visits: Record<string, number>;
  /** Nodes finished in the current pass, for waitFor joins. */
  done: string[];
  superstep: number;
  waitingInterrupt?: { interruptId: string; nodeId: string };
  error?: string;
}
