/** Cap H §6.11 — the nine api_* learn tools. MCP cannot create operations, so
 *  learning runs the vendored CLI as a child (cli.ts runCli: no shell, minimal
 *  env, kill-tree on timeout/abort). Every tool is registered `integration: true`
 *  and is therefore reachable only through integration_call after a per-task
 *  grant — exactly like the MCP tools. Output is next-rewritten, token-redacted
 *  and budget-fit; the audit log records names + hashes only. */
import path from "node:path";
import { isInside } from "../../policy/paths.js";
import type { Tool, ToolContext, ToolResult } from "../registry.js";
import { fitJson } from "./budget.js";
import { redactLearnOutput, runCli } from "./cli.js";
import { CAPTURE_RE, OP_RE, SITE_RE } from "./constants.js";
import { rewriteNextDeep } from "./nextHints.js";
import { opIndex } from "./opIndex.js";
import { refusal, type ApiAnythingPolicy } from "./policy.js";
import { appendAudit } from "./audit.js";
import type { ApiAnythingConfig, CliRun } from "./types.js";

const STEP_ACTIONS = new Set(["click", "fill", "press", "wait", "goto"]);
const MATCH_KEYS = new Set(["method", "host", "path", "operationName"]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 2_000): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

function kvFlags(flag: string, v: unknown): string[] | string {
  if (v === undefined) return [];
  if (!isRecord(v)) return `${flag.replace(/^--/, "")} must be an object of param -> value`;
  const out: string[] = [];
  for (const [k, val] of Object.entries(v)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) return `bad param name ${k}`;
    if (!["string", "number", "boolean"].includes(typeof val)) return `${k} must be a string, number or boolean`;
    out.push(flag, `${k}=${String(val)}`);
  }
  return out;
}

function stepsFlag(v: unknown): string[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 20) return "steps must be an array of at most 20 steps";
  for (const s of v) {
    if (!isRecord(s) || typeof s.action !== "string" || !STEP_ACTIONS.has(s.action)) return "each step needs action click|fill|press|wait|goto";
    for (const k of Object.keys(s)) if (!["action", "selector", "value", "ms"].includes(k)) return `unknown step field ${k}`;
  }
  return ["--steps", JSON.stringify(v)];
}

function opt(flag: string, v: unknown, max = 2_000): string[] {
  const s = str(v, max);
  return s ? [flag, s] : [];
}

function refusalLike(cls: string, reason: string, next: string): ToolResult {
  return { ok: false, content: JSON.stringify({ ok: false, class: cls, reason, next }) };
}

function out(run: CliRun, budget: number, timeoutMs: number): ToolResult {
  if (run.timedOut) {
    return refusalLike("error", `stopped after ${Math.round(timeoutMs / 1000)} s`, "retry once; if the page is slow, ask Khamis whether to continue");
  }
  if (run.aborted) return refusalLike("error", "stopped by the user", "do not retry unless Khamis asks");
  if (run.overflow) return refusalLike("error", "the command printed more than 2 MiB", "use api_inspect with extract or pick to narrow the response");
  const base: Record<string, unknown> = isRecord(run.json) ? { ...run.json } : run.json === undefined ? { ok: run.code === 0, stderr: run.stderr } : { data: run.json };
  if (run.next) base.next = run.next;
  const rewritten = rewriteNextDeep(base);
  const redacted = redactLearnOutput(JSON.stringify(rewritten));
  let value: unknown;
  try {
    value = JSON.parse(redacted);
  } catch {
    value = { ok: false, class: "error", reason: "the output could not be redacted safely" };
  }
  return { ok: run.code === 0, content: fitJson(value, budget) };
}

export function createApiAnythingLearnTools(cfg: ApiAnythingConfig, policy: ApiAnythingPolicy): Tool[] {
  const budget = cfg.outputBudgetChars;
  const learnMs = cfg.timeouts.learnMs;
  const listMs = cfg.timeouts.listMs;

  const guard = (ctx: ToolContext, site?: string): ToolResult | undefined => {
    if (!ctx.taskId) return refusal("api-anything runs inside a task", "start an execution task");
    if (site !== undefined && (!SITE_RE.test(site) || !policy.siteAllowed(site))) {
      return refusal(`site ${site} is not enabled in Loam`, "ask Khamis to enable it in Services > واجهات المواقع");
    }
    return undefined;
  };

  const exec = async (
    tool: string,
    argv: string[],
    ctx: ToolContext,
    timeoutMs: number,
    audit: { site?: string; op?: string } = {},
  ): Promise<ToolResult> => {
    const run = await runCli(argv, cfg, { timeoutMs, signal: ctx.signal });
    appendAudit({ taskId: ctx.taskId ?? null, tool, ...audit, argNames: [], argsSha256: undefined, decision: "sent", class: run.code === 0 ? "ok" : "error", ms: run.ms });
    if (["api_add", "api_heal", "api_logout"].includes(tool)) opIndex.refresh();
    return out(run, budget, timeoutMs);
  };

  const learnUrl = (raw: unknown): { url: string } | ToolResult => {
    const s = str(raw);
    if (!s) return refusal("url is required", "pass the page URL Khamis named");
    const checked = policy.learnUrlAllowed(s.replace(/\{[^}]+\}/g, "x"));
    if (!checked.ok) return refusal(checked.reason, "ask Khamis to add the domain in Services > واجهات المواقع");
    return { url: s };
  };

  const writeAllowed = (v: unknown): ToolResult | undefined =>
    v === true && !cfg.allowWriteLearning
      ? refusal("learning write operations is turned off in Loam", "tell Khamis; only he can turn on write learning in Services > واجهات المواقع")
      : undefined;

  const tools: Tool[] = [
    {
      name: "api_sites",
      description: "api-anything: list sites with learned operations (source: user, registry or bundled). No network.",
      parameters: { type: "object", properties: {} },
      async run(_args, ctx) {
        return guard(ctx) ?? exec("api_sites", ["sites"], ctx, listMs);
      },
    },
    {
      name: "api_ops",
      description: "api-anything: list one site's operations, params with formats, and the site's notes. No network.",
      parameters: { type: "object", properties: { site: { type: "string" } }, required: ["site"] },
      async run(args, ctx) {
        const site = str(args.site, 64);
        if (!site) return refusal("site is required", "integration_call api_sites {}");
        return guard(ctx, site) ?? exec("api_ops", ["ops", site], ctx, listMs, { site });
      },
    },
    {
      name: "api_capture",
      description:
        "api-anything: load a page in a headless browser on api-anything's own profile and list the requests it made, ranked by which carry the example values. Returns a capture id for api_inspect and api_add. Only domains Khamis enabled.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "https page URL" },
          examples: { type: "object", description: "param -> example value typed into the page (3+ characters)" },
          steps: { type: "array", description: "[{action: click|fill|press|wait|goto, selector?, value?, ms?}]", items: { type: "object" } },
          softFrom: { type: "string", description: "neutral https page to load first (single-page apps)" },
          outline: { type: "boolean", description: "summarize the top 3 candidates (default true)" },
          limit: { type: "number", description: "candidates to list, 1-30 (default 15)" },
          write: { type: "boolean", description: "abort every non-GET request (write learning; off unless Khamis enabled it)" },
        },
        required: ["url"],
      },
      async run(args, ctx) {
        const g = guard(ctx);
        if (g) return g;
        const u = learnUrl(args.url);
        if (!("url" in u)) return u;
        if (args.softFrom !== undefined) {
          const s = learnUrl(args.softFrom);
          if (!("url" in s)) return s;
        }
        const w = writeAllowed(args.write);
        if (w) return w;
        const examples = kvFlags("--example", args.examples);
        if (typeof examples === "string") return refusal(examples, "fix the arguments");
        const steps = stepsFlag(args.steps);
        if (typeof steps === "string") return refusal(steps, "fix the arguments");
        const host = new URL(u.url.replace(/\{[^}]+\}/g, "x")).hostname;
        const rate = policy.checkRate(ctx.taskId!, `learn:${host}`);
        if (rate) return refusal(rate, "stop and tell Khamis; do not retry in this task");
        const limit = typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 30 ? ["--limit", String(args.limit)] : [];
        const argv = [
          "capture",
          u.url,
          ...examples,
          ...steps,
          ...opt("--soft-from", args.softFrom),
          ...(args.outline === false ? [] : ["--outline"]),
          ...limit,
          ...(args.write === true ? ["--write"] : []),
        ];
        return exec("api_capture", argv, ctx, learnMs);
      },
    },
    {
      name: "api_inspect",
      description:
        "api-anything: read a saved capture (no browser, no network). Without request, lists its requests; with request, shows it through a recipe (extract, pick, html, embedded) or an outline.",
      parameters: {
        type: "object",
        properties: {
          capture: { type: "string", description: "capture id from api_capture or api_add, e.g. c1a2b3c4" },
          request: { type: "number" },
          extract: { type: "string" },
          pick: { type: "string", description: "a,b.c,name=x.y" },
          html: { type: "object", description: "{items: css, fields: {name: css[@attr]}}" },
          embedded: { type: "string", description: "regex; group 1 marks where the JSON starts" },
          outline: { type: "boolean" },
          examples: { type: "object" },
        },
        required: ["capture"],
      },
      async run(args, ctx) {
        const g = guard(ctx);
        if (g) return g;
        const capture = str(args.capture, 20);
        if (!capture || !CAPTURE_RE.test(capture)) return refusal("capture must be a capture id like c1a2b3c4", "use the id api_capture returned");
        const request = typeof args.request === "number" && Number.isInteger(args.request) && args.request >= 0 ? [String(args.request)] : [];
        const examples = kvFlags("--example", args.examples);
        if (typeof examples === "string") return refusal(examples, "fix the arguments");
        const argv = [
          "inspect",
          capture,
          ...request,
          ...opt("--extract", args.extract, 500),
          ...opt("--pick", args.pick, 500),
          ...(isRecord(args.html) ? ["--html", JSON.stringify(args.html)] : []),
          ...opt("--embedded", args.embedded, 200),
          ...(args.outline === true ? ["--outline"] : []),
          ...examples,
        ];
        return exec("api_inspect", argv, ctx, listMs);
      },
    },
    {
      name: "api_add",
      description:
        "api-anything: learn and save an operation. Either run the trigger page twice (trigger + examples [+ examples2]) or learn from a capture (from + pickRequest [+ from2]). Returns a preview of what a call returns and warnings to read.",
      parameters: {
        type: "object",
        properties: {
          site: { type: "string" },
          op: { type: "string" },
          trigger: { type: "string", description: "https page URL template with {param} placeholders" },
          examples: { type: "object" },
          examples2: { type: "object", description: "second, different example values for the two-run diff" },
          steps: { type: "array", items: { type: "object" } },
          softFrom: { type: "string" },
          match: { type: "object", description: "{method?, host?, path?, operationName?}" },
          from: { type: "string" },
          pickRequest: { type: "number" },
          from2: { type: "string" },
          extract: { type: "string" },
          pick: { type: "string" },
          html: { type: "object" },
          embedded: { type: "string" },
          public: { type: "array", items: { type: "string" } },
          write: { type: "boolean" },
          description: { type: "string" },
        },
        required: ["site", "op"],
      },
      async run(args, ctx) {
        const site = str(args.site, 64);
        const op = str(args.op, 64);
        if (!site || !SITE_RE.test(site) || !op || !OP_RE.test(op)) return refusal("site and op must be short names (letters, digits, . _ -)", "fix the arguments");
        const g = guard(ctx, site);
        if (g) return g;
        const w = writeAllowed(args.write);
        if (w) return w;
        if (args.trigger === undefined && args.from === undefined) return refusal("trigger or from is required", "pass trigger + examples, or from + pickRequest");
        const flags: string[] = [];
        if (args.trigger !== undefined) {
          const t = learnUrl(args.trigger);
          if (!("url" in t)) return t;
          flags.push("--trigger", t.url);
        }
        if (args.softFrom !== undefined) {
          const s = learnUrl(args.softFrom);
          if (!("url" in s)) return s;
          flags.push("--soft-from", s.url);
        }
        for (const [key, flag] of [["from", "--from"], ["from2", "--from2"]] as const) {
          const v = args[key];
          if (v === undefined) continue;
          if (typeof v !== "string" || !CAPTURE_RE.test(v)) return refusal(`${key} must be a capture id`, "use the id api_capture returned");
          flags.push(flag, v);
        }
        if (args.pickRequest !== undefined) {
          if (typeof args.pickRequest !== "number" || !Number.isInteger(args.pickRequest) || args.pickRequest < 0) return refusal("pickRequest must be a request id", "fix the arguments");
          flags.push("--pick-request", String(args.pickRequest));
        }
        const examples = kvFlags("--example", args.examples);
        if (typeof examples === "string") return refusal(examples, "fix the arguments");
        const examples2 = kvFlags("--example2", args.examples2);
        if (typeof examples2 === "string") return refusal(examples2, "fix the arguments");
        const steps = stepsFlag(args.steps);
        if (typeof steps === "string") return refusal(steps, "fix the arguments");
        if (args.match !== undefined) {
          if (!isRecord(args.match)) return refusal("match must be an object", "fix the arguments");
          for (const [k, v] of Object.entries(args.match)) {
            if (!MATCH_KEYS.has(k) || typeof v !== "string" || v.length > 300) return refusal(`bad match field ${k}`, "use method, host, path or operationName");
            flags.push("--match", `${k}=${v}`);
          }
        }
        if (args.public !== undefined) {
          if (!Array.isArray(args.public) || args.public.some((x) => typeof x !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(x))) return refusal("public must be a list of header or field names", "fix the arguments");
          if (args.public.length) flags.push("--public", args.public.join(","));
        }
        if (args.trigger !== undefined) {
          const host = new URL(String(args.trigger).replace(/\{[^}]+\}/g, "x")).hostname;
          const rate = policy.checkRate(ctx.taskId!, `learn:${host}`);
          if (rate) return refusal(rate, "stop and tell Khamis; do not retry in this task");
        }
        const argv = [
          "add",
          site,
          op,
          ...flags,
          ...examples,
          ...examples2,
          ...steps,
          ...opt("--extract", args.extract, 500),
          ...opt("--pick", args.pick, 500),
          ...(isRecord(args.html) ? ["--html", JSON.stringify(args.html)] : []),
          ...opt("--embedded", args.embedded, 200),
          ...(args.write === true ? ["--write"] : []),
          ...(typeof args.description === "string" ? ["--description", args.description.slice(0, 500)] : []),
        ];
        return exec("api_add", argv, ctx, learnMs, { site, op });
      },
    },
    {
      name: "api_verify",
      description: "api-anything: call every read operation of a site (or all sites) with its stored example args, healing operations that fail.",
      parameters: { type: "object", properties: { site: { type: "string" } } },
      async run(args, ctx) {
        const site = args.site === undefined ? undefined : str(args.site, 64);
        if (args.site !== undefined && !site) return refusal("site must be a name", "fix the arguments");
        const g = guard(ctx, site);
        if (g) return g;
        if (!site && cfg.sites !== "all") return refusal("name the site to verify", "pass site");
        return exec("api_verify", site ? ["verify", site] : ["verify"], ctx, learnMs, { site });
      },
    },
    {
      name: "api_heal",
      description: "api-anything: force a heal of a read operation (rescan, then recapture), even when it is marked stale.",
      parameters: { type: "object", properties: { site: { type: "string" }, op: { type: "string" }, args: { type: "object" } }, required: ["site", "op"] },
      async run(args, ctx) {
        const site = str(args.site, 64);
        const op = str(args.op, 64);
        if (!site || !op || !OP_RE.test(op)) return refusal("site and op are required", "fix the arguments");
        const g = guard(ctx, site);
        if (g) return g;
        const pairs = args.args === undefined ? [] : isRecord(args.args) ? Object.entries(args.args) : undefined;
        if (!pairs) return refusal("args must be an object", "fix the arguments");
        const kv = pairs.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
        return exec("api_heal", ["heal", site, op, ...kv], ctx, learnMs, { site, op });
      },
    },
    {
      name: "api_export",
      description: "api-anything: write a shareable copy of a site's spec (examples and shapes stripped; refused if a live credential is inside) into the task workspace.",
      parameters: { type: "object", properties: { site: { type: "string" }, out: { type: "string", description: "workspace-relative path ending in .json" } }, required: ["site", "out"] },
      async run(args, ctx) {
        const site = str(args.site, 64);
        const rel = str(args.out, 260);
        if (!site || !rel || !rel.endsWith(".json")) return refusal("site and a .json out path are required", "fix the arguments");
        const g = guard(ctx, site);
        if (g) return g;
        const abs = path.resolve(ctx.workspace, rel);
        if (!isInside(ctx.workspace, abs)) return refusal("out must be inside the task workspace", "use a relative path");
        return exec("api_export", ["export", site, "--out", abs], ctx, listMs, { site });
      },
    },
    {
      name: "api_logout",
      description: "api-anything: clear a site's stored cookie jar and its cookies in api-anything's browser profile. Specs stay.",
      parameters: { type: "object", properties: { site: { type: "string" } }, required: ["site"] },
      async run(args, ctx) {
        const site = str(args.site, 64);
        if (!site) return refusal("site is required", "fix the arguments");
        return guard(ctx, site) ?? exec("api_logout", ["logout", site], ctx, listMs, { site });
      },
    },
  ];
  return tools.map((t) => ({ ...t, integration: true }));
}
