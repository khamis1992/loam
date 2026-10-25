/** Clean-room mirrors of the Cua Driver contract shapes Loam touches —
 *  CUA_INTO_LOAM_INTEGRATION §8. Types only: runtime validation is the driver's job;
 *  `verify_state.expect` predicates pass through untouched (U6: fail closed on the
 *  driver's refusal rather than re-specifying its schema). */

/** Exact window or desktop target — contract `click.target`. */
export type CuaDriverTarget =
  | { kind: "window"; pid: number; window_id: number }
  | { kind: "desktop"; display_id: "primary" | string };

/** Snapshot-bound element token — pattern ^s[0-9a-f]{8}:[0-9]+$ from
 *  `get_window_state` rows; invalidated when a new snapshot replaces them. */
export type CuaElementToken = string;

export type CuaDeliveryMode = "background" | "foreground";

export interface CuaClickArgs {
  target: CuaDriverTarget;
  delivery_mode: CuaDeliveryMode;
  element_token?: CuaElementToken;
  x?: number;
  y?: number;
  button?: "left" | "right" | "middle";
  count?: 1 | 2 | 3;
  capture_id?: string;
  session?: string;
}

export interface CuaGetWindowStateArgs {
  pid: number;
  window_id: number;
  query?: string;
  max_elements?: number;
  max_depth?: number;
  include_screenshot?: boolean;
  include_accessibility_tree?: boolean;
  tree_format?: "markdown" | "elements" | "both";
  since?: string;
  timeout_ms?: number;
  session?: string;
}

export interface CuaVerifyStateArgs {
  pid: number;
  window_id: number;
  /** Driver predicate object — pass through; do not invent fields. */
  expect: Record<string, unknown>;
  include_screenshot?: boolean;
  timeout_ms?: number;
  stable_samples?: number;
  session?: string;
}

export interface CuaDriverSessionConfig {
  enabled: boolean;
  /** Absolute path to cua-driver.exe (empty = resolved from the pinned data-dir slot). */
  binaryPath: string;
  /** Exact version directory name, e.g. "0.38.0". */
  version: string;
  permissionMode: "standard" | "bounded" | "unrestricted";
  /** sha256 of the pinned release zip. */
  sha256?: string;
}

/** Validates the element-token shape before a tool call reuses a token (§7.5 rule 4:
 *  always act with a FRESH token; stale ones must fail this check). */
export function isCuaElementToken(value: string): boolean {
  return /^s[0-9a-f]{8}:[0-9]+$/.test(value);
}
