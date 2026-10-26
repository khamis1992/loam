import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, DEFAULTS, type Config, type McpServerConfig } from "../../config.js";
import { log } from "../../log.js";
import { registerProtectedPath } from "../../policy/riskTier.js";
import type { McpServerHooks } from "../mcp.js";
import { AUDIT_FILE, HOME_DIR, PINNED_COMMIT, SERVER_NAME, USAGE_DIR, cliEntry, vendoredMarker } from "./constants.js";
import { ensureHome } from "./home.js";
import { opIndex } from "./opIndex.js";
import { createApiAnythingPolicy, installTierResolver, type ApiAnythingPolicy } from "./policy.js";
import { SETTINGS_FILE, applyUserSettings, loadUserSettings } from "./settings.js";
import type { ApiAnythingConfig, ApiAnythingReadiness } from "./types.js";

/** Config keeps the block optional for test fixtures; resolve it once per entry point. */
function resolveCfg(cfg: Config): ApiAnythingConfig {
  return cfg.apiAnything ?? DEFAULTS.apiAnything!;
}

export function apiAnythingServerConfig(cfg: Config): McpServerConfig {
  const a = resolveCfg(cfg);
  return {
    command: "node",
    args: [cliEntry(), "mcp", ...(a.allowWrites ? ["--allow-writes"] : [])],
    envMode: "minimal",
    env: { API_ANYTHING_HOME: HOME_DIR, API_ANYTHING_BROWSER: a.browser },
    toolTimeouts: {
      list_sites: a.timeouts.listMs,
      list_operations: a.timeouts.listMs,
      call_operation: a.timeouts.callMs,
      login: a.timeouts.loginMs,
    },
    defaultTimeoutMs: a.timeouts.callMs,
  };
}

export function apiAnythingReadiness(cfg: Config): ApiAnythingReadiness {
  if (!resolveCfg(cfg).enabled) return { ready: false, reason: "disabled" };
  if (!fs.existsSync(cliEntry())) return { ready: false, reason: "not-vendored" };
  const marker = fs.existsSync(vendoredMarker()) ? fs.readFileSync(vendoredMarker(), "utf8").trim() : "";
  if (marker !== PINNED_COMMIT) return { ready: false, reason: "wrong-commit", detail: marker.slice(0, 40) };
  // The child runs on this process's own binary (mcp.ts maps "node" to process.execPath), so this is the child's Node.
  const [maj = 0, min = 0] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) return { ready: false, reason: "node-too-old", detail: process.versions.node };
  return { ready: true };
}

export interface PreparedApiAnything {
  servers: Record<string, McpServerConfig>;
  hooks: Record<string, McpServerHooks>;
  readiness: ApiAnythingReadiness;
  policy?: ApiAnythingPolicy;
}

/**
 * Overlay the panel settings, protect Loam's api-anything files, and add the Loam-managed
 * server to the MCP map when enabled and vendored. A user-written mcpServers["api-anything"]
 * entry is always removed: Loam owns this server.
 */
export function prepareApiAnything(cfg: Config, servers: Record<string, McpServerConfig>): PreparedApiAnything {
  // Fill the optional block once so hooks, settings, and policy share one live object.
  const a = resolveCfg(cfg);
  cfg.apiAnything = a;
  applyUserSettings(a, loadUserSettings(), true);
  for (const p of [HOME_DIR, USAGE_DIR, SETTINGS_FILE, AUDIT_FILE]) registerProtectedPath(p);
  // OD-11: Loam's per-task grant file has the same self-grant gap (src/tools/integrations.ts:7-11).
  registerProtectedPath(path.join(DATA_DIR, "integration-grants"));
  installTierResolver();
  const readiness = apiAnythingReadiness(cfg);
  const rest = { ...servers };
  if (rest[SERVER_NAME]) {
    log.warn(`config.json mcpServers["${SERVER_NAME}"] is ignored: Loam manages this server (apiAnything.enabled)`);
    delete rest[SERVER_NAME];
  }
  if (!readiness.ready) {
    if (a.enabled) log.warn(`api-anything not started: ${readiness.reason}${readiness.detail ? ` (${readiness.detail})` : ""}`);
    return { servers: rest, hooks: {}, readiness };
  }
  const home = ensureHome();
  if (home.acl === "failed") log.warn(`api-anything home ACL not applied: ${home.error ?? "unknown error"}`);
  opIndex.refresh();
  const policy = createApiAnythingPolicy(a);
  return { servers: { ...rest, [SERVER_NAME]: apiAnythingServerConfig(cfg) }, hooks: { [SERVER_NAME]: policy.hooks }, readiness, policy };
}
