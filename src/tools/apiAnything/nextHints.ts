const NPX_NOTE = /\s*\(api-anything is a CLI:[^)]*\)/g;
const LOGIN_TERMINAL = /ask the user to run in a terminal: api-anything login ([\w.-]+)(?: \(or use mode "window"\))?/g;
const UNSAFE = /\bnpx\b|github:|\bshell\b|\bterminal\b/i;
const ALLOW_WRITES = /ask the user to restart this MCP server with --allow-writes|rerun with --allow-writes(?: \(MCP: [^)]*\))?/g;
const LOGIN_TOOL = /the login tool \{"site":"([\w.-]+)"\} \(mode "window"[^)]*\)/g;
const BARE_TOOL = /(?<![\w_])(list_operations|list_sites|call_operation)(?=\s|\{|$)/g;
const CLI = /\bapi-anything\s+(heal|add|capture|verify|export|inspect|logout|pull|publish|call|ops|sites|login)\b((?:\s+(?!--)[^\s;,()]+)*)/g;

function q(s: string): string {
  return JSON.stringify(s);
}

function mapCli(cmd: string, rest: string): string {
  const a = rest.trim().split(/\s+/).filter(Boolean);
  const site = a[0] && !a[0].startsWith("<") ? a[0] : undefined;
  switch (cmd) {
    case "heal":
      return site && a[1] ? `integration_call api_heal {"site":${q(site)},"op":${q(a[1])}}` : "integration_call api_heal with site and op";
    case "add":
      return "integration_call api_add with site, op, trigger and examples (see the api-anything skill)";
    case "capture":
      return a[0] ? `integration_call api_capture {"url":${q(a[0])}}` : "integration_call api_capture with the page URL";
    case "verify":
      return site ? `integration_call api_verify {"site":${q(site)}}` : "integration_call api_verify {}";
    case "export":
      return site ? `integration_call api_export {"site":${q(site)}}` : "integration_call api_export with site";
    case "inspect":
      return a[0] && !a[0].startsWith("<")
        ? `integration_call api_inspect {"capture":${q(a[0])}${a[1] && /^\d+$/.test(a[1]) ? `,"request":${a[1]}` : ""}}`
        : "integration_call api_inspect with the capture id";
    case "logout":
      return site ? `ask Khamis whether to sign out of ${site} (integration_call api_logout {"site":${q(site)}})` : "ask Khamis which site to sign out of";
    case "pull":
    case "publish":
      return "(sharing specs is not available in Loam)";
    case "call":
      return site && a[1]
        ? `integration_call mcp__api-anything__call_operation {"site":${q(site)},"op":${q(a[1])}}`
        : "integration_call mcp__api-anything__call_operation";
    case "ops":
      return site ? `integration_call mcp__api-anything__list_operations {"site":${q(site)}}` : "integration_call mcp__api-anything__list_sites {}";
    case "sites":
      return "integration_call mcp__api-anything__list_sites {}";
    case "login":
      return site
        ? `integration_call mcp__api-anything__login {"site":${q(site)}} (opens a window; Khamis signs in and closes it)`
        : "integration_call mcp__api-anything__login with site";
    default:
      return "follow the api-anything skill";
  }
}

/** Rewrite one upstream hint into Loam tool calls. Never returns text that runs code from a shell. */
export function rewriteNext(next: string): string {
  let out = next
    .replace(NPX_NOTE, "")
    .replace(ALLOW_WRITES, "writes are turned off in Loam; tell Khamis, only he can turn them on in Services > واجهات المواقع")
    .replace(LOGIN_TERMINAL, (_m, site: string) => `integration_call mcp__api-anything__login {"site":${q(site)}} (opens a window; Khamis signs in and closes it)`)
    .replace(LOGIN_TOOL, (_m, site: string) => `integration_call mcp__api-anything__login {"site":${q(site)}} (opens a window; Khamis signs in and closes it)`)
    .replace(CLI, (_m, cmd: string, rest: string) => mapCli(cmd, rest))
    .replace(BARE_TOOL, (m: string) => `integration_call mcp__api-anything__${m}`)
    .replace(/integration_call mcp__api-anything__integration_call mcp__api-anything__/g, "integration_call mcp__api-anything__");
  out = out.replace(/\s{2,}/g, " ").trim();
  if (UNSAFE.test(out)) return "follow the api-anything skill; never run api-anything from a shell";
  return out;
}

/** Apply rewriteNext to every string field named `next` at any depth. */
export function rewriteNextDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteNextDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === "next" && typeof v === "string" ? rewriteNext(v) : rewriteNextDeep(v);
    return out;
  }
  return value;
}
