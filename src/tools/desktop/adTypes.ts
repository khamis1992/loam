/** agent-desktop v1.0.2 wire contract (envelope version "2.5") — Loam-authored
 *  type transcription of the CLI's stdout JSON. No upstream code is copied. */

// §1.3 — envelope
export type Delivery = "unknown" | "not_delivered" | "delivery_uncertain" | "delivered_unverified" | "delivered_verified";
export type Retry = "unknown" | "safe" | "unsafe";

export interface Disposition {
  delivery: Delivery;
  retry: Retry;
}

export interface AdOk<T> {
  version: string;
  ok: true;
  command: string;
  data: T;
}

export interface AdErr {
  version: string;
  ok: false;
  command: string;
  error: {
    code: AdErrorCode;
    message: string;
    disposition: Disposition;
    suggestion?: string;
    platform_detail?: unknown;
    details?: Record<string, unknown>;
    recovery?: { strategy: string; retryable: boolean; requires_fresh_snapshot?: boolean; retry_after_ms?: number };
  };
}

export type AdEnvelope<T = unknown> = AdOk<T> | AdErr;

export type AdErrorCode =
  | "PERM_DENIED"
  | "ELEMENT_NOT_FOUND"
  | "APP_NOT_FOUND"
  | "STALE_REF"
  | "AMBIGUOUS_TARGET"
  | "SNAPSHOT_NOT_FOUND"
  | "POLICY_DENIED"
  | "ACTION_FAILED"
  | "ACTION_NOT_SUPPORTED"
  | "APP_UNRESPONSIVE"
  | "PLATFORM_NOT_SUPPORTED"
  | "TIMEOUT"
  | "INVALID_ARGS"
  | "WINDOW_NOT_FOUND"
  | "NOTIFICATION_NOT_FOUND"
  | "INTERNAL";

export const AD_ERROR_CODES: readonly AdErrorCode[] = [
  "PERM_DENIED",
  "ELEMENT_NOT_FOUND",
  "APP_NOT_FOUND",
  "STALE_REF",
  "AMBIGUOUS_TARGET",
  "SNAPSHOT_NOT_FOUND",
  "POLICY_DENIED",
  "ACTION_FAILED",
  "ACTION_NOT_SUPPORTED",
  "APP_UNRESPONSIVE",
  "PLATFORM_NOT_SUPPORTED",
  "TIMEOUT",
  "INVALID_ARGS",
  "WINDOW_NOT_FOUND",
  "NOTIFICATION_NOT_FOUND",
  "INTERNAL",
] as const;

export function isAdErrorCode(value: unknown): value is AdErrorCode {
  return typeof value === "string" && (AD_ERROR_CODES as readonly string[]).includes(value);
}

// §1.4 — snapshot data
export interface AdNode {
  role: string;
  role_description?: string;
  name?: string;
  value?: string;
  ref_id?: string;
  available_actions?: string[];
  states?: string[];
  native_id?: { kind: string; value: string };
  /** Only with --include-bounds. */
  bounds?: { x: number; y: number; width: number; height: number };
  children?: AdNode[];
  children_count?: number;
  subtree_truncated?: boolean;
}

export interface AdSnapshot {
  app: string;
  window: { id: string; title: string };
  snapshot_id: string;
  ref_count: number;
  complete: boolean;
  truncated?: boolean;
  nodes_observed?: number;
  tree: AdNode;
}

export interface AdWindow {
  id: string;
  app_name: string;
  title: string;
  pid?: number;
  minimized?: boolean;
  is_focused?: boolean;
}

export interface AdVersionData {
  version: string;
}

// §3.1 — Loam-side helpers
/** Snapshot-qualified element ref, e.g. `@ab12cd:e7`. A bare `@e7` is invalid. */
export const AD_REF_RE = /^@[a-z0-9]+:e\d+$/i;

export type RefAction =
  | "click"
  | "set-value"
  | "clear"
  | "select"
  | "toggle"
  | "check"
  | "uncheck"
  | "expand"
  | "collapse"
  | "scroll"
  | "scroll-to";

export const REF_ACTIONS: readonly RefAction[] = [
  "click",
  "set-value",
  "clear",
  "select",
  "toggle",
  "check",
  "uncheck",
  "expand",
  "collapse",
  "scroll",
  "scroll-to",
] as const;

export function isRefAction(value: unknown): value is RefAction {
  return typeof value === "string" && (REF_ACTIONS as readonly string[]).includes(value);
}
