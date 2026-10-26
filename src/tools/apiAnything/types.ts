/** Upstream failure classes (OBSERVED api-anything src/classify.ts:6, src/execute.ts:57-69) plus Loam's "refused". */
export type ApiAnythingClass = "ok" | "drift" | "auth" | "rate" | "blocked" | "input" | "error" | "refused";
export type ApiAnythingTier = 1 | 2 | 3;

/** Shape of call_operation's JSON (upstream CallResult), as Loam reads it. */
export interface ApiAnythingCallResult {
  ok: boolean;
  class: ApiAnythingClass;
  data?: unknown;
  truncated?: boolean;
  tier?: ApiAnythingTier;
  healed?: boolean;
  ms: number;
  reason?: string;
  next?: string;
  /** Added by Loam's budget when it trimmed the result. */
  omittedItems?: number;
  cutStrings?: number;
}

/** list_operations param entry (OBSERVED api-anything src/mcp.ts:124-165). */
export interface ApiAnythingParam {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  required: boolean;
  description?: string;
  example?: unknown;
  hint?: string;
  pattern?: string;
}

export interface ApiAnythingOperationInfo {
  name: string;
  description?: string;
  write?: true;
  returns?: string[];
  params: ApiAnythingParam[];
}

export interface ApiAnythingConfig {
  enabled: boolean;
  /** Start the MCP server with --allow-writes (OD-3). */
  allowWrites: boolean;
  /** Let api_capture / api_add pass --write (OD-3). */
  allowWriteLearning: boolean;
  /** API_ANYTHING_BROWSER: a name (edge, chrome, brave) or an absolute path. */
  browser: string;
  sites: "all" | string[];
  /** Domains learning (and login by URL) may target, besides known sites' hosts. */
  learnDomains: string[];
  /** "site.op" entries that return data about a named person (§5.5). */
  peopleOps: string[];
  /** Tasks where people lookups are switched on. */
  peopleOpsTasks: string[];
  peopleLimitPerTask: number;
  rateLimit: { calls: number; windowMs: number };
  outputBudgetChars: number;
  timeouts: { listMs: number; callMs: number; loginMs: number; learnMs: number };
}

/** Panel-managed overrides stored in DATA_DIR/api-anything-settings.json. */
export interface ApiAnythingUserSettings {
  enabled?: boolean;
  allowWrites?: boolean;
  allowWriteLearning?: boolean;
  learnDomains?: string[];
  peopleOpsTasks?: string[];
  sites?: "all" | string[];
}

export type SpecSource = "user" | "registry" | "bundled";

export interface OpIndexEntry {
  site: string;
  op: string;
  readOnly: boolean;
  source: SpecSource;
  params: string[];
}

export interface SiteIndexEntry {
  site: string;
  displayName?: string;
  baseUrl: string;
  host: string;
  source: SpecSource;
  ops: number;
  writes: number;
  loginCookies: string[];
  shared: boolean;
}

export interface ApiAnythingReadiness {
  ready: boolean;
  reason?: "disabled" | "not-vendored" | "wrong-commit" | "node-too-old";
  detail?: string;
}

export interface HomeStatus {
  home: string;
  acl: "applied" | "posix-0700" | "failed";
  error?: string;
}

export interface CliRun {
  code: number;
  json: unknown;
  next?: string;
  /** Last 2,000 characters of stderr, redacted. */
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  overflow: boolean;
  ms: number;
}

/** What probeChild asks the vendored code; values never included. */
export interface ChildProbe {
  node: string;
  platform: string;
  browser: { name: string; bin: string } | null;
  sites: Array<
    | { name: string; loggedIn: boolean; cookieCount: number; source: string | null; updatedAt: string | null }
    | { name: string; error: string }
  >;
}

export interface AuditLine {
  at: string;
  taskId: string | null;
  tool: string;
  site?: string;
  op?: string;
  argNames: string[];
  argsSha256: string | undefined;
  decision: "sent" | "refused";
  class?: string;
  tier?: number;
  ms?: number;
  reason?: string;
}

export interface ApiAnythingStatus {
  enabled: boolean;
  readiness: ApiAnythingReadiness;
  commit: string;
  version: string;
  home: string;
  acl: string[];
  server: { connected: boolean; toolCount: number };
  node?: string;
  browser?: { name: string; bin: string } | null;
  probeError?: string;
  settings: Pick<ApiAnythingConfig, "allowWrites" | "allowWriteLearning" | "learnDomains" | "peopleOpsTasks" | "sites">;
  restartRequired: boolean;
}
