import type { ApiOperationPlan } from "./openapi.js";
import type { FlowScan, SourceFlow } from "./source-flow.js";

// Self-planning (section 17): derives a suggested next-step checklist from a
// finished assessment's own evidence — discovered pages, OpenAPI operations,
// source routes/risks and cross-file flows — classified by application
// surface. The plan is ADVISORY ONLY: nothing here executes, no case is
// created, and every suggestion names the operator declaration it still
// needs. The separation between suggestion and execution is explicit and
// structural: buildPlan is a pure read of evidence and carries an
// `execution: "none"` marker the UI/report must keep attached.

export interface PlanSuggestion {
  engine: string;                 // engine family, e.g. "injection", "xssReflected"
  surface: "web" | "api" | "source";
  target: string;                 // page URL, route path, or file:line
  rationale: string;              // why this evidence suggests the check
  operatorInput: string;          // the explicit declaration still required
}
export interface CampaignPlan {
  appType: string;
  surfaces: Array<{ id: "web" | "api" | "source"; present: boolean; evidence: string }>;
  suggestions: PlanSuggestion[];
  /** Ranked source-to-sink taint candidates derived from the taint model (see below). */
  hints: PlannerHint[];
  limitations: string[];
  execution: "none";
}

export interface PlanEvidence {
  target?: string;
  discovery?: { pages: Array<{ url: string }>; truncated?: boolean };
  openapiPlan?: { operations: ApiOperationPlan[] };
  scan?: { routes: Array<{ method: string; path: string; file: string; line: number }>; staticRisks: Array<{ rule: string; file: string; line: number; check?: string }> };
  flowScan?: FlowScan;
  /** Precomputed taint candidates to fold into the plan's ranked suggestions. */
  taintHints?: PlannerHint[];
}

const MAX_SUGGESTIONS = 50;

export function buildPlan(run: PlanEvidence): CampaignPlan {
  const suggestions: PlanSuggestion[] = [];
  const seen = new Set<string>();
  const push = (suggestion: PlanSuggestion) => {
    const key = suggestion.engine + "|" + suggestion.target;
    if (seen.has(key) || suggestions.length >= MAX_SUGGESTIONS) return;
    seen.add(key);
    suggestions.push(suggestion);
  };
  const pages = run.discovery?.pages ?? [];
  const operations = run.openapiPlan?.operations ?? [];
  const routes = run.scan?.routes ?? [];
  const risks = run.scan?.staticRisks ?? [];
  const flows = run.flowScan?.flows ?? [];

  // Web surface: discovered pages suggest parameter-driven checks.
  for (const page of pages.slice(0, 20)) {
    push({ engine: "xssReflected", surface: "web", target: page.url, rationale: "Discovered page reachable in scope; any reflected parameter could carry a canary", operatorInput: "Declare the parameter name that reaches the response (browser.xssReflected case)" });
  }
  // API surface: OpenAPI operations, split by what the plan itself could not do.
  for (const operation of operations.slice(0, 30)) {
    if (operation.reason) { push({ engine: "openapiFlow", surface: "api", target: operation.method + " " + operation.path, rationale: "OpenAPI operation was not automatically exercised: " + operation.reason, operatorInput: "Declare an explicit browser flow or POST allowlist entry covering this operation" }); continue; }
    if (operation.method === "GET") push({ engine: "injection", surface: "api", target: operation.path, rationale: "GET operation exercised by discovery; boolean differentials can confirm or refute injection on its inputs", operatorInput: "Declare the query field and a benign baseline value (injection case)" });
    else push({ engine: "injection", surface: "api", target: operation.method + " " + operation.path, rationale: "Non-GET operation carries request input; POST differentials need explicit authorization", operatorInput: "Allowlist the path in postPaths and declare the JSON field + baseline" });
  }
  // Source surface A: declared routes with no matching dynamic suggestion yet.
  for (const route of routes.slice(0, 30)) {
    push({ engine: "routeVerification", surface: "source", target: route.method + " " + route.path + " (" + route.file + ":" + route.line + ")", rationale: "Route declared in source; dynamic engines have only covered what discovery/openapi reached", operatorInput: "Confirm the route is authorized and declare engine cases against it" });
  }
  // Source surface B: static risks pair with the matching dynamic engine.
  for (const risk of risks.slice(0, 20)) {
    const engine = risk.check === "source_sql" ? "injection" : risk.check === "source_nosql" ? "injection" : risk.check === "source_html" ? "xssReflected" : "sourceReview";
    push({ engine, surface: "source", target: risk.file + ":" + risk.line, rationale: "Static " + (risk.check ?? "pattern") + " indicator (" + risk.rule + ") is a review candidate, not proof; the matching dynamic engine can confirm or refute it", operatorInput: "Declare the route + field serving this code path so the dynamic case (and static→dynamic linking) can run" });
  }
  // Source surface C: cross-file flows map sink kind → engine family.
  for (const flow of flows.slice(0, 20)) {
    const engine = flow.sink.kind === "sql_like" ? "injection" : flow.sink.kind === "html_like" ? "xssReflected" : "command";
    push({ engine, surface: "source", target: flow.source.file + " → " + flow.sink.file + ":" + flow.sink.line, rationale: "Cross-file flow reaches a " + flow.sink.kind.replace("_like", "") + " sink; a dynamic case on the route in " + flow.source.file + " would link statically and dynamically", operatorInput: "Declare the engine case on that route; linkFlowsToDynamicEvidence will join the proofs" });
  }
  // Source surface D: ranked source-to-sink taint candidates (see the taint
  // model below). These are static review candidates with their full hop
  // chain; they are prepended to the plan because they carry the strongest
  // source-level evidence, but they still require explicit operator input.
  // Evidence-gated: hints come either from explicitly supplied `taintHints`
  // or, when absent, are derived from this run's own flowScan flows — a run
  // without a flow scan simply gets no taint surface.
  const hints = run.taintHints ?? (run.flowScan?.flows?.length ? flowScanTaintHints(run.flowScan) : []);
  for (const hint of hints) {
    push({ engine: hint.engine, surface: "source", target: hint.target, rationale: hint.rationale, operatorInput: hint.operatorInput });
  }

  const surfaces: CampaignPlan["surfaces"] = [
    { id: "web", present: pages.length > 0, evidence: pages.length + " discovered page(s)" },
    { id: "api", present: operations.length > 0, evidence: operations.length + " OpenAPI operation(s)" },
    { id: "source", present: routes.length > 0 || risks.length > 0 || flows.length > 0, evidence: routes.length + " route(s), " + risks.length + " static risk(s), " + flows.length + " cross-file flow(s)" },
  ];
  const present = surfaces.filter(s => s.present).map(s => s.id);
  const limitations = [
    "Plan-only output: nothing executes and no case is created by this plan; every suggestion requires explicit operator declarations.",
    "Derived from this assessment's evidence alone — pages beyond discovery limits, undocumented operations and unscanned files are invisible to it.",
    "Suggestion ordering follows evidence order, not risk ranking (hypothesis ranking is a separate open item).",
  ];
  if (run.flowScan?.coverage.bounded) limitations.push("Source-flow analysis was bounded; flows beyond the bound are not suggested.");
  if (hints.length) limitations.push("Taint hints are bounded syntactic candidates from caller-supplied graph input, not proof; absence of a hint proves nothing.");
  if (run.discovery?.truncated) limitations.push("Discovery was truncated; suggestions cover visited pages only.");
  return { appType: present.length ? present.join("+") + " application" : "unknown (no evidence collected)", surfaces, suggestions, hints, limitations, execution: "none" };
}

// ---------------------------------------------------------------------------
// Source-to-sink taint planning (clean-room implementation)
//
// NOTICE: The source -> propagation -> sink model implemented below follows the
// long-established taint-analysis pattern (Shannon-style information-flow
// framing: mark untrusted origins, propagate through a graph, flag dangerous
// sinks). This is an original, self-contained TypeScript implementation
// written for this project; no third-party taint engine, brand, or asset is
// used or copied. It is a bounded syntactic model over caller-supplied
// structured input — not type checking and not a proof: every flow is a review
// candidate with its full hop chain, and absence of a flow proves nothing.
// ---------------------------------------------------------------------------

export type TaintSourceKind = "user_input" | "query" | "body" | "param" | "header" | "cookie" | "path" | "env" | "file";
export type TaintSinkKind = "exec" | "query" | "fs" | "html" | "template" | "redirect" | "deserialize";
export type TaintNodeKind = "source" | "sink" | "function" | "variable" | "param";

export interface TaintNode {
  id: string;
  kind: TaintNodeKind;
  name: string;
  location: string;
  sourceKind?: TaintSourceKind;
  sinkKind?: TaintSinkKind;
}
export interface TaintSourceSpec { id: string; name: string; kind: TaintSourceKind; location: string }
export interface TaintSinkSpec { id: string; name: string; kind: TaintSinkKind; location: string; description?: string }
export interface TaintNodeSpec { id: string; name: string; location: string }
export interface TaintEdgeSpec { from: string; to: string; sanitized?: boolean; guarded?: boolean; label?: string }
export interface TaintGraphSpec { sources: TaintSourceSpec[]; sinks: TaintSinkSpec[]; nodes?: TaintNodeSpec[]; edges: TaintEdgeSpec[] }
export interface TaintGraph { nodes: TaintNode[]; edges: TaintEdgeSpec[] }

export interface TaintPathHop { id: string; name: string; location: string; edge?: string }
export interface TaintFlow {
  source: TaintNode;
  sink: TaintNode;
  path: TaintPathHop[];
  hops: number;
  sanitized: boolean;
}
export interface TaintResult {
  flows: TaintFlow[];
  sources: number;
  sinks: number;
  sinksReached: number;
  sanitizedEdges: number;
  guardedEdges: number;
  coverage: { bounded: boolean; reason?: string };
}

export interface PlannerHint {
  id: string;
  rank: number;
  score: number;
  engine: string;
  surface: "source";
  sourceKind: TaintSourceKind;
  sinkKind: TaintSinkKind;
  source: string;
  target: string;
  path: string[];
  hops: number;
  severity: "critical" | "high" | "medium" | "low";
  confidence: "observed" | "derived" | "inferred";
  rationale: string;
  operatorInput: string;
  execution: "none";
}

const MAX_HINTS = 50;
const MAX_HOPS = 8;
const SOURCE_WEIGHT: Record<TaintSourceKind, number> = { user_input: 30, body: 25, query: 20, param: 18, header: 15, cookie: 15, path: 12, env: 10, file: 8 };
const SINK_WEIGHT: Record<TaintSinkKind, number> = { exec: 100, query: 85, fs: 80, template: 60, deserialize: 55, html: 50, redirect: 40 };

/** Builds a normalized taint graph from the compact caller-supplied spec. */
export function makeGraph(spec: TaintGraphSpec): TaintGraph {
  const nodes: TaintNode[] = [];
  const seen = new Set<string>();
  const push = (node: TaintNode): void => { if (!seen.has(node.id)) { seen.add(node.id); nodes.push(node); } };
  for (const s of spec.sources) push({ id: s.id, kind: "source", name: s.name, location: s.location, sourceKind: s.kind });
  for (const s of spec.sinks) push({ id: s.id, kind: "sink", name: s.name, location: s.location, sinkKind: s.kind });
  for (const n of spec.nodes ?? []) push({ id: n.id, kind: "function", name: n.name, location: n.location });
  return { nodes, edges: spec.edges };
}

/**
 * Propagates taint from every source through the graph and reports each sink
 * reachable along an unsanitized, unguarded path. Breadth-first search keeps
 * the shortest chain per sink; edges flagged `sanitized` or `guarded` stop
 * propagation, so a value that passes a modeled sanitizer/validator never
 * reaches a downstream sink.
 */
export function analyzeTaint(graph: TaintGraph): TaintResult {
  const nodes = new Map(graph.nodes.map(n => [n.id, n] as const));
  const outgoing = new Map<string, TaintEdgeSpec[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  const sources = graph.nodes.filter(n => n.kind === "source");
  const sinks = graph.nodes.filter(n => n.kind === "sink");
  const sanitizedEdges = graph.edges.filter(e => e.sanitized === true).length;
  const guardedEdges = graph.edges.filter(e => e.guarded === true).length;
  const flows: TaintFlow[] = [];
  const coverage: TaintResult["coverage"] = { bounded: false };
  for (const source of sources) {
    const prev = new Map<string, { id: string; edge?: string }>();
    const dist = new Map<string, number>([[source.id, 0]]);
    const queue: string[] = [source.id];
    while (queue.length) {
      const current = queue.shift()!;
      const depth = dist.get(current)!;
      for (const edge of outgoing.get(current) ?? []) {
        if (edge.sanitized === true || edge.guarded === true) continue;
        if (!nodes.has(edge.to)) continue;
        if (dist.has(edge.to)) continue;
        dist.set(edge.to, depth + 1);
        prev.set(edge.to, { id: current, edge: edge.label });
        queue.push(edge.to);
      }
    }
    for (const sink of sinks) {
      if (sink.id === source.id) continue;
      const hops = dist.get(sink.id);
      if (hops === undefined) continue;
      const path: TaintPathHop[] = [];
      let cursor: string | undefined = sink.id;
      while (cursor !== undefined) {
        const node = nodes.get(cursor);
        if (!node) break;
        const step = prev.get(cursor);
        path.unshift({ id: node.id, name: node.name, location: node.location, edge: step?.edge });
        cursor = step?.id;
      }
      const flow: TaintFlow = { source, sink, path, hops, sanitized: false };
      const existing = flows.find(f => f.sink.id === sink.id);
      const sourceScore = SOURCE_WEIGHT[source.sourceKind ?? "user_input"] ?? 10;
      const existingScore = SOURCE_WEIGHT[existing?.source.sourceKind ?? "user_input"] ?? 10;
      const better = !existing || hops < existing.hops || (hops === existing.hops && sourceScore > existingScore);
      if (better) { if (existing) flows.splice(flows.indexOf(existing), 1); flows.push(flow); }
    }
    if (flows.length >= MAX_HINTS) { coverage.bounded = true; coverage.reason = `stopped at the ${MAX_HINTS}-flow reporting limit`; break; }
  }
  return { flows, sources: sources.length, sinks: sinks.length, sinksReached: flows.length, sanitizedEdges, guardedEdges, coverage };
}

function scoreFlow(flow: TaintFlow): number {
  const sinkW = SINK_WEIGHT[flow.sink.sinkKind ?? "query"] ?? 50;
  const srcW = SOURCE_WEIGHT[flow.source.sourceKind ?? "user_input"] ?? 10;
  const hopBonus = Math.max(0, MAX_HOPS - flow.hops + 1) * 4;
  return sinkW + srcW + hopBonus;
}
function severityOf(flow: TaintFlow): PlannerHint["severity"] {
  const sink = flow.sink.sinkKind ?? "query";
  const src = flow.source.sourceKind ?? "user_input";
  const user = src === "user_input" || src === "body" || src === "query" || src === "param";
  if (sink === "exec") return user ? "critical" : "high";
  if (sink === "query") return user ? "high" : "medium";
  if (sink === "fs") return user ? "high" : "medium";
  if (sink === "template") return user ? "high" : "medium";
  if (sink === "deserialize") return user ? "high" : "medium";
  if (sink === "html") return user ? "medium" : "low";
  return user ? "medium" : "low";
}
function engineOf(sink: TaintSinkKind): string {
  switch (sink) {
    case "exec": return "command";
    case "query": return "injection";
    case "fs": return "pathTraversal";
    case "html": return "xssReflected";
    case "template": return "templateInjection";
    case "redirect": return "redirect";
    case "deserialize": return "deserialization";
  }
}
function describeSink(sink: TaintSinkKind): string {
  switch (sink) {
    case "exec": return "command execution";
    case "query": return "database query";
    case "fs": return "filesystem access";
    case "html": return "HTML rendering";
    case "template": return "template rendering";
    case "redirect": return "redirect target";
    case "deserialize": return "deserialization";
  }
}
function describeSource(kind: TaintSourceKind): string {
  switch (kind) {
    case "user_input": return "user input";
    case "query": return "query parameter";
    case "body": return "request body field";
    case "param": return "route parameter";
    case "header": return "request header";
    case "cookie": return "cookie";
    case "path": return "URL path segment";
    case "env": return "environment variable";
    case "file": return "file contents";
  }
}

/**
 * Emits ranked planner hints for the pentest orchestrator: one hint per
 * tainted source-to-sink flow, ordered by a deterministic score (sink
 * severity, source trust, path length) and carrying the full hop chain. The
 * hints are advisory only (`execution: "none"`); the orchestrator must still
 * declare the engine case before anything runs.
 */
export function planTaintHints(graph: TaintGraph, opts: { maxHints?: number } = {}): PlannerHint[] {
  const result = analyzeTaint(graph);
  const max = opts.maxHints ?? MAX_HINTS;
  const hints = result.flows
    .map(flow => {
      const sinkKind = flow.sink.sinkKind ?? "query";
      const sourceKind = flow.source.sourceKind ?? "user_input";
      const path = flow.path.map(hop => `${hop.name}@${hop.location}`);
      const engine = engineOf(sinkKind);
      return {
        id: `taint:${flow.sink.id}:${flow.source.id}`,
        rank: 0,
        score: scoreFlow(flow),
        engine,
        surface: "source" as const,
        sourceKind,
        sinkKind,
        source: `${flow.source.name}@${flow.source.location}`,
        target: `${flow.sink.name}@${flow.sink.location}`,
        path,
        hops: flow.hops,
        severity: severityOf(flow),
        confidence: (flow.hops === 1 ? "derived" : "inferred") as PlannerHint["confidence"],
        rationale: `Tainted ${describeSource(sourceKind)} (${flow.source.name}@${flow.source.location}) reaches a ${describeSink(sinkKind)} sink (${flow.sink.name}@${flow.sink.location}) in ${flow.hops} hop(s): ${path.join(" -> ")}.`,
        operatorInput: `Declare the engine case on the route serving ${flow.source.location} so the ${engine} check can confirm or refute this source-to-sink path.`,
        execution: "none" as const,
      };
    })
    .sort((a, b) => b.score - a.score || a.hops - b.hops || a.target.localeCompare(b.target))
    .slice(0, max);
  hints.forEach((hint, index) => { hint.rank = index + 1; });
  return hints;
}

/** Maps ranked taint hints into the plan's suggestion shape for buildPlan. */
export function taintPlanSuggestions(hints: PlannerHint[]): PlanSuggestion[] {
  return hints.map(hint => ({ engine: hint.engine, surface: "source", target: hint.target, rationale: hint.rationale, operatorInput: hint.operatorInput }));
}

// ---------------------------------------------------------------------------
// Adapter: scanner flow metrics → planner taint hints (evidence-gated)
//
// Thin, scoped bridge: converts the `traceSourceFlows` FlowScan findings into
// the compact TaintGraphSpec the taint model above consumes, then reuses
// `planTaintHints` unchanged for ranking. It does NOT reimplement or alter the
// scanner — every edge simplification is traced back to a reported flow, and a
// run without flow evidence produces no hints at all.
// ---------------------------------------------------------------------------

/** Infers a source trust kind from the scanner's origin description. */
function sourceKindOf(what: string): TaintSourceKind {
  const text = what.toLowerCase();
  if (text.includes("cookie")) return "cookie";
  if (text.includes("header")) return "header";
  if (text.includes("body")) return "body";
  if (text.includes("query")) return "query";
  if (/(?:^|\.)(?:params|param)/.test(text)) return "param";
  return "user_input";
}

const FLOW_SINK_KIND: Record<SourceFlow["sink"]["kind"], TaintSinkKind> = { sql_like: "query", command_like: "exec", html_like: "html" };

export const FLOW_TAINT_MAX_FLOWS = 20;

/** Converts the scanner's cross-file flows into the compact taint graph spec. */
export function taintHintsSourceSpec(flowScan: FlowScan, maxFlows: number = FLOW_TAINT_MAX_FLOWS): TaintGraphSpec {
  const spec: TaintGraphSpec = { sources: [], sinks: [], nodes: [], edges: [] };
  const nodes: NonNullable<TaintGraphSpec["nodes"]> = spec.nodes ?? (spec.nodes = []);
  for (const flow of flowScan.flows.slice(0, maxFlows)) {
    const source: TaintSourceSpec = {
      id: `src:${flow.source.file}:${flow.source.line}`,
      name: flow.source.what.slice(0, 60),
      kind: sourceKindOf(flow.source.what),
      location: `${flow.source.file}:${flow.source.line}`,
    };
    const sink: TaintSinkSpec = {
      id: `sink:${flow.sink.kind}:${flow.sink.file}:${flow.sink.line}`,
      name: flow.sink.what.slice(0, 60),
      kind: FLOW_SINK_KIND[flow.sink.kind],
      location: `${flow.sink.file}:${flow.sink.line}`,
    };
    if (!spec.edges.some(edge => edge.from === source.id && edge.to === sink.id)) {
      spec.sources.push(source);
      spec.sinks.push(sink);
      const carriers = new Map<string, TaintNodeSpec>();
      for (const hop of flow.hops) carriers.set(`${hop.file}:${hop.line}`, { id: `node:${hop.file}:${hop.line}`, name: hop.what.slice(0, 60), location: `${hop.file}:${hop.line}` });
      let prev = source.id;
      for (const [key, node] of carriers) {
        if (!nodes.some(existing => existing.id === node.id)) nodes.push(node);
        spec.edges.push({ from: prev, to: node.id, label: key });
        prev = node.id;
      }
      spec.edges.push({ from: prev, to: sink.id });
    }
  }
  return spec;
}

/**
 * Evidence-gated planner hints from the scanner's own FlowScan: the hints are
 * derived only from flows the scan actually reported (bounded syntactic
 * candidates, review confidence); a run without flow evidence gets none.
 */
export function flowScanTaintHints(flowScan: FlowScan, maxHints?: number, maxFlows?: number): PlannerHint[] {
  if (!flowScan.flows?.length) return [];
  const spec = taintHintsSourceSpec(flowScan, maxFlows);
  if (!spec.edges.length) return [];
  return planTaintHints(makeGraph(spec), { maxHints });
}
