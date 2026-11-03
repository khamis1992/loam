import path from "node:path";
import { DATA_DIR, rootAsset } from "../../config.js";

export const SERVER_NAME = "api-anything";
export const MCP_PREFIX = `mcp__${SERVER_NAME}__`;
export const PINNED_COMMIT = "441e50905acea35f407127c2b8a4032e969288f7";
export const UPSTREAM_VERSION = "0.1.0";

/** Vendored payload; rootAsset prefers app.asar.unpacked in packaged builds. */
export const pkgDir = (): string => rootAsset("addons", "api-anything", "pkg");
export const cliEntry = (): string => path.join(pkgDir(), "dist", "cli.js");
export const bundledSitesDir = (): string => path.join(pkgDir(), "sites");
export const vendoredMarker = (): string => path.join(pkgDir(), ".vendored");

/** api-anything's own state (API_ANYTHING_HOME): specs, cookie jars, captures, browser profile. */
export const HOME_DIR = path.join(DATA_DIR, "api-anything");
/** Loam-side counters (hashes only, no credentials); outside HOME_DIR on purpose. */
export const USAGE_DIR = path.join(DATA_DIR, "api-anything-usage");
export const AUDIT_FILE = path.join(DATA_DIR, "logs", "api-anything-audit.jsonl");
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

export const MCP_TOOL_NAMES = ["list_sites", "list_operations", "call_operation", "login"] as const;
export const LEARN_TOOL_NAMES = [
  "api_sites",
  "api_ops",
  "api_capture",
  "api_inspect",
  "api_add",
  "api_verify",
  "api_heal",
  "api_export",
  "api_logout",
] as const;

export const SITE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export const OP_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const CAPTURE_RE = /^c[0-9a-z]{1,16}$/;
export const CLI_STDOUT_MAX = 2 * 1024 * 1024;
export const LOOKUP_REFRESH_MS = 1_000;
