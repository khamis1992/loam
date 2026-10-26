import type { ReAllowlistEntry, ReToolName } from "./types.js";

/** Fifteen engine-free tools (REA OD-3 / OD-M-B3). OBSERVED names from REA MCP list. */
export const RE_ALLOWLIST: ReAllowlistEntry[] = [
  { name: "analyze_javascript_application", effect: "read", engineFree: true },
  { name: "analyze_web_bundle", effect: "read", engineFree: true },
  { name: "inspect_asar_archive", effect: "read", engineFree: true },
  { name: "list_asar_entries", effect: "read", engineFree: true },
  { name: "extract_asar_entry", effect: "write_workspace", engineFree: true },
  { name: "inspect_web_network_capture", effect: "read", engineFree: true },
  { name: "summarize_evidence_bundle", effect: "read", engineFree: true },
  { name: "export_evidence_bundle", effect: "write_workspace", engineFree: true },
  { name: "import_evidence_bundle", effect: "write_workspace", engineFree: true },
  { name: "verify_evidence_digest", effect: "read", engineFree: true },
  { name: "get_tool_schema", effect: "read", engineFree: true },
  { name: "get_provider_status", effect: "read", engineFree: true },
  { name: "doctor", effect: "read", engineFree: true },
  { name: "list_llms", effect: "read", engineFree: true },
  { name: "get_run_budget", effect: "read", engineFree: true },
];

const BY_NAME = new Map(RE_ALLOWLIST.map((e) => [e.name, e]));

export function isAllowedReTool(name: string): name is ReToolName {
  return BY_NAME.has(name as ReToolName);
}

export function filterReToolsList(tools: Array<{ name: string }>): Array<{ name: string }> {
  return tools.filter((t) => isAllowedReTool(t.name));
}

export function reToolEffect(name: string): ReAllowlistEntry["effect"] | null {
  return BY_NAME.get(name as ReToolName)?.effect ?? null;
}

export const RE_ALLOWLIST_NAMES: ReToolName[] = RE_ALLOWLIST.map((e) => e.name);
