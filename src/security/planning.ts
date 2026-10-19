import type { ApiOperationPlan } from "./openapi.js";
import type { FlowScan } from "./source-flow.js";

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
  limitations: string[];
  execution: "none";
}

export interface PlanEvidence {
  target?: string;
  discovery?: { pages: Array<{ url: string }>; truncated?: boolean };
  openapiPlan?: { operations: ApiOperationPlan[] };
  scan?: { routes: Array<{ method: string; path: string; file: string; line: number }>; staticRisks: Array<{ rule: string; file: string; line: number; check?: string }> };
  flowScan?: FlowScan;
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
  if (run.discovery?.truncated) limitations.push("Discovery was truncated; suggestions cover visited pages only.");
  return { appType: present.length ? present.join("+") + " application" : "unknown (no evidence collected)", surfaces, suggestions, limitations, execution: "none" };
}
