import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { registerToolTierResolver, type RiskTier } from "../../policy/riskTier.js";
import type { McpBeforeDecision, McpServerHooks } from "../mcp.js";
import type { ToolContext, ToolResult } from "../registry.js";
import { appendAudit, argDigest } from "./audit.js";
import { fitJson } from "./budget.js";
import { LEARN_TOOL_NAMES, MCP_PREFIX, OP_RE, SITE_RE, USAGE_DIR } from "./constants.js";
import { rewriteNextDeep } from "./nextHints.js";
import { opIndex } from "./opIndex.js";
import type { ApiAnythingConfig } from "./types.js";

/** Tier of an api-anything tool by its (lower-case) registry name. Unknown ⇒ destructive. */
export function apiAnythingTier(name: string, args: Record<string, unknown> | undefined): RiskTier {
  switch (name) {
    case `${MCP_PREFIX}list_sites`:
    case `${MCP_PREFIX}list_operations`:
    case "api_sites":
    case "api_ops":
    case "api_inspect":
      return "read";
    case `${MCP_PREFIX}login`:
      return "secret";
    case `${MCP_PREFIX}call_operation`: {
      const site = typeof args?.site === "string" ? args.site : "";
      const op = typeof args?.op === "string" ? args.op : "";
      const entry = opIndex.lookup(site, op);
      return entry?.readOnly === true ? "network-external" : "destructive";
    }
    case "api_capture":
    case "api_add":
      return args?.write === true ? "destructive" : "network-external";
    case "api_verify":
    case "api_heal":
      return "network-external";
    case "api_export":
      return "write-workspace";
    case "api_logout":
      return "destructive";
    default:
      return "destructive";
  }
}

let unregister: (() => void) | undefined;
/** Idempotent: one resolver per process. */
export function installTierResolver(): void {
  if (unregister) return;
  unregister = registerToolTierResolver({ prefix: MCP_PREFIX, names: LEARN_TOOL_NAMES, resolve: apiAnythingTier, untrusted: true });
}
export function uninstallTierResolver(): void {
  unregister?.();
  unregister = undefined;
}

export function refusal(reason: string, next: string): ToolResult {
  return { ok: false, content: JSON.stringify({ ok: false, class: "refused", reason, next, ms: 0 }) };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** host equals d or is a subdomain of d. */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

const PRIVATE_V4 = [/^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./, /^0\./];

/** https only, no IP literals in private ranges, no localhost. */
export function assertPublicHttps(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "only https URLs can be learned or signed in to" };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return { ok: false, reason: "local addresses are not allowed" };
  if (PRIVATE_V4.some((re) => re.test(host))) return { ok: false, reason: "private network addresses are not allowed" };
  if (host === "::1" || /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) {
    return { ok: false, reason: "private network addresses are not allowed" };
  }
  return { ok: true, url };
}

interface Usage {
  people: string[];
}

export interface ApiAnythingPolicy {
  hooks: McpServerHooks;
  siteAllowed(site: string): boolean;
  learnUrlAllowed(raw: string): { ok: true; url: URL } | { ok: false; reason: string };
  /** Shared by the learn tools so a learn call counts against the same per-site window. */
  checkRate(taskId: string, site: string): string | undefined;
}

export function createApiAnythingPolicy(cfg: ApiAnythingConfig, now: () => number = Date.now): ApiAnythingPolicy {
  const calls = new Map<string, number[]>();
  let loginOpen = false;

  const siteAllowed = (site: string): boolean => cfg.sites === "all" || cfg.sites.includes(site);

  const learnUrlAllowed = (raw: string): { ok: true; url: URL } | { ok: false; reason: string } => {
    const checked = assertPublicHttps(raw);
    if (!checked.ok) return checked;
    const host = checked.url.hostname.toLowerCase();
    const known = opIndex.sites().map((s) => s.host).filter(Boolean);
    const allowed = [...cfg.learnDomains, ...known].some((d) => hostMatches(host, d));
    return allowed ? checked : { ok: false, reason: `${host} is not in the api-anything learn list` };
  };

  const checkRate = (taskId: string, site: string): string | undefined => {
    const k = `${taskId}\u0000${site}`;
    const t = now();
    const recent = (calls.get(k) ?? []).filter((at) => t - at < cfg.rateLimit.windowMs);
    if (recent.length >= cfg.rateLimit.calls) {
      calls.set(k, recent);
      const minutes = Math.round(cfg.rateLimit.windowMs / 60_000);
      return `${cfg.rateLimit.calls} calls to ${site} in ${minutes} minutes is this task's limit`;
    }
    recent.push(t);
    calls.set(k, recent);
    return undefined;
  };

  const usageFile = (taskId: string): string => {
    if (!/^task_[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error("Invalid task id");
    return path.join(USAGE_DIR, `${taskId}.json`);
  };
  const readUsage = (taskId: string): Usage => {
    try {
      const v = JSON.parse(fs.readFileSync(usageFile(taskId), "utf8")) as Partial<Usage>;
      return { people: Array.isArray(v.people) ? v.people.filter((x): x is string => typeof x === "string") : [] };
    } catch {
      return { people: [] };
    }
  };
  const writeUsage = (taskId: string, usage: Usage): void => {
    fs.mkdirSync(USAGE_DIR, { recursive: true });
    const file = usageFile(taskId);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(usage));
    fs.renameSync(`${file}.tmp`, file);
  };

  /** undefined = allowed; string = refusal reason. Counts a new person only when allowed. */
  const checkPeople = (ctx: ToolContext, site: string, op: string, args: Record<string, unknown>): string | undefined => {
    if (!cfg.peopleOps.includes(`${site}.${op}`)) return undefined;
    const taskId = ctx.taskId ?? "";
    if ((ctx.depth ?? 0) > 0) return "people lookups are not available to sub-agents";
    if (!cfg.peopleOpsTasks.includes(taskId)) return "people lookups are off for this task";
    const values = Object.keys(args).sort().map((k) => String(args[k]).trim().toLowerCase());
    const person = crypto.createHash("sha256").update(`${site}\u0000${values.join("\u0000")}`).digest("hex");
    const usage = readUsage(taskId);
    if (usage.people.includes(person)) return undefined;
    if (usage.people.length >= cfg.peopleLimitPerTask) return `this task already looked up ${cfg.peopleLimitPerTask} people`;
    usage.people.push(person);
    writeUsage(taskId, usage);
    return undefined;
  };

  const block = (taskId: string | undefined, tool: string, args: Record<string, unknown>, reason: string, next: string): McpBeforeDecision => {
    const site = typeof args.site === "string" ? args.site : undefined;
    const op = typeof args.op === "string" ? args.op : undefined;
    appendAudit({ taskId: taskId ?? null, tool, site, op, ...argDigest(args.args), decision: "refused", reason });
    return { block: refusal(reason, next) };
  };

  const before = (tool: string, args: Record<string, unknown>, ctx: ToolContext): McpBeforeDecision => {
    const taskId = ctx.taskId;
    if (!taskId) return block(undefined, tool, args, "api-anything runs inside a task", "start an execution task and enable the tools in Services > Integrations");
    const site = typeof args.site === "string" ? args.site : undefined;
    if (site !== undefined && (!SITE_RE.test(site) || !siteAllowed(site))) {
      return block(taskId, tool, args, `site ${site} is not enabled in Loam`, "ask Khamis to enable it in Services > واجهات المواقع");
    }
    switch (tool) {
      case "list_sites":
        return undefined;
      case "list_operations":
        return site ? undefined : block(taskId, tool, args, "site is required", "integration_call mcp__api-anything__list_sites {}");
      case "call_operation": {
        const op = typeof args.op === "string" ? args.op : "";
        if (!site || !OP_RE.test(op)) return block(taskId, tool, args, "site and op are required", "integration_call mcp__api-anything__list_operations {\"site\":\"<site>\"}");
        const callArgs = args.args === undefined ? {} : args.args;
        if (!isRecord(callArgs)) return block(taskId, tool, args, "args must be an object", "pass args as {\"param\": value}");
        const people = checkPeople(ctx, site, op, callArgs);
        if (people) return block(taskId, tool, args, people, "ask Khamis before looking up more people in this task");
        const rate = checkRate(taskId, site);
        if (rate) return block(taskId, tool, args, rate, "stop and tell Khamis; do not retry in this task");
        return undefined;
      }
      case "login": {
        if (loginOpen) return block(taskId, tool, args, "a sign-in window is already open", "ask Khamis to finish signing in and close that window");
        if (typeof args.url === "string") {
          const checked = learnUrlAllowed(args.url);
          if (!checked.ok) return block(taskId, tool, args, checked.reason, "ask Khamis to add the domain in Services > واجهات المواقع");
        }
        if (!site && typeof args.url !== "string") return block(taskId, tool, args, "site or url is required", "integration_call mcp__api-anything__list_sites {}");
        loginOpen = true;
        // Windows cannot import browser cookies (upstream src/import.ts:131); always open the window.
        return { args: { ...args, mode: "window" } };
      }
      default:
        return block(taskId, tool, args, `unknown api-anything tool ${tool}`, "use integration_list to see the enabled tools");
    }
  };

  const after = (tool: string, args: Record<string, unknown>, result: ToolResult, ctx: ToolContext, ms: number): ToolResult => {
    if (tool === "login") loginOpen = false;
    let value: unknown;
    try {
      value = JSON.parse(result.content);
    } catch {
      value = {
        ok: false,
        class: "error",
        reason: result.content.slice(0, 500),
        next: tool === "login" ? "ask Khamis whether the sign-in window is still open; close it and retry once" : "retry once; if it fails again, report it to Khamis",
        ms,
      };
    }
    value = rewriteNextDeep(value);
    if (tool === "list_sites" && Array.isArray(value)) {
      value = value.filter((s) => isRecord(s) && typeof s.name === "string" && siteAllowed(s.name));
    }
    if (tool === "call_operation" || tool === "login") {
      const v = isRecord(value) ? value : {};
      appendAudit({
        taskId: ctx.taskId ?? null,
        tool,
        site: typeof args.site === "string" ? args.site : undefined,
        op: typeof args.op === "string" ? args.op : undefined,
        ...argDigest(args.args),
        decision: "sent",
        class: typeof v.class === "string" ? v.class : v.ok === true ? "ok" : "error",
        tier: typeof v.tier === "number" ? v.tier : undefined,
        ms,
      });
    }
    return { ok: result.ok, content: fitJson(value, cfg.outputBudgetChars) };
  };

  return { hooks: { before, after }, siteAllowed, learnUrlAllowed, checkRate };
}
