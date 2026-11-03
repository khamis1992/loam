import { validate as validateSchema, type JsonSchema } from "../contracts/schema.js";
import type { WorkflowDef, NodeKind } from "./types.js";

export interface WorkflowLimits {
  maxNodes: number;
  isCloudModel: (model: string) => boolean;
}

const ID = /^[a-z][a-z0-9_]{0,39}$/;

const CONDITION_SCHEMA: JsonSchema = { type: "object" };

const NODE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["id", "kind"],
  properties: {
    id: { type: "string", pattern: ID.source },
    kind: { enum: ["agent", "tool", "human", "vote", "condition", "subworkflow", "transform"] },
    title: { type: "string", maxLength: 120 },
    outputKey: { type: "string", pattern: ID.source },
    waitFor: { type: "array", maxItems: 16, items: { type: "string" } },
    maxVisits: { type: "integer", minimum: 1, maximum: 50 },
    condition: CONDITION_SCHEMA,
  },
};

export const WORKFLOW_SCHEMA: JsonSchema = {
  type: "object",
  required: ["id", "version", "title", "inputs", "start", "nodes", "edges"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^[a-z][a-z0-9-]{1,63}$" },
    version: { const: 1 },
    title: { type: "string", minLength: 1, maxLength: 120 },
    description: { type: "string", maxLength: 2000 },
    inputs: { type: "object" },
    start: { type: "string" },
    nodes: { type: "array", minItems: 1, maxItems: 256, items: NODE_SCHEMA },
    edges: {
      type: "array",
      maxItems: 1024,
      items: { type: "object", required: ["from", "to"], additionalProperties: false, properties: { from: { type: "string" }, to: { type: "string" }, when: { enum: ["true", "false"] } } },
    },
  },
};

const NEEDS: Record<NodeKind, keyof WorkflowDef["nodes"][number] | null> = {
  agent: "agent",
  tool: "tool",
  human: "human",
  vote: "vote",
  condition: "condition",
  subworkflow: "subworkflow",
  transform: "transform",
};

/** Returns human-readable problems; empty = valid. */
export function validateWorkflow(def: unknown, lim: WorkflowLimits): string[] {
  const shape = validateSchema(WORKFLOW_SCHEMA, def);
  if (shape.length) return shape.map((i) => `${i.path} ${i.message}`);
  const wf = def as WorkflowDef;
  const errs: string[] = [];
  if (wf.nodes.length > lim.maxNodes) errs.push(`more than ${lim.maxNodes} nodes`);
  const ids = new Set<string>();
  for (const n of wf.nodes) {
    if (ids.has(n.id)) errs.push(`duplicate node id ${n.id}`);
    ids.add(n.id);
    const key = NEEDS[n.kind];
    if (key && !n[key]) errs.push(`node ${n.id}: kind ${n.kind} needs a "${String(key)}" block`);
    if (n.kind !== "condition" && n.kind !== "human" && !n.outputKey && n.kind !== "transform") errs.push(`node ${n.id}: outputKey is required`);
    if (n.agent?.model && !lim.isCloudModel(n.agent.model)) errs.push(`node ${n.id}: model ${n.agent.model} is not a cloud model`);
    if (n.kind === "human" && !n.outputKey) errs.push(`node ${n.id}: outputKey is required`);
  }
  if (!ids.has(wf.start)) errs.push(`start node ${wf.start} does not exist`);
  for (const e of wf.edges) {
    if (!ids.has(e.from)) errs.push(`edge from unknown node ${e.from}`);
    if (!ids.has(e.to)) errs.push(`edge to unknown node ${e.to}`);
  }
  for (const n of wf.nodes) {
    for (const w of n.waitFor ?? []) if (!ids.has(w)) errs.push(`node ${n.id}: waitFor unknown node ${w}`);
    for (const f of n.vote?.from ?? []) if (!ids.has(f)) errs.push(`node ${n.id}: vote from unknown node ${f}`);
    if (n.kind === "condition") {
      const out = wf.edges.filter((e) => e.from === n.id);
      if (out.length === 0 || out.some((e) => !e.when)) errs.push(`node ${n.id}: every edge leaving a condition needs when: "true" | "false"`);
    }
  }
  // Reachability from start.
  const seen = new Set<string>([wf.start]);
  const queue = [wf.start];
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const e of wf.edges) if (e.from === cur && !seen.has(e.to)) {
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  for (const id of ids) if (!seen.has(id)) errs.push(`node ${id} is unreachable from ${wf.start}`);
  return errs;
}
