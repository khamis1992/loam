/** Shared types for Loam's unified red-team capability (RED_TEAM_BUILD_SPEC §0.4, §4). */

/** A gated target: an exact HTTP(S) URL. */
export interface RedTarget {
  url: string;
}

/** One target-touching action a red capability wants to perform. */
export interface RedAction {
  /** Capability id, e.g. "red.sqli", "red.templates". */
  capability: string;
  /** "write" covers anything that may mutate target state. */
  verb: "read" | "write";
  /** Destructive actions need explicit human approval unless the authorization record allows them. */
  destructive?: boolean;
  /** Redaction happens at the audit boundary; these are the raw parameters. */
  params?: Record<string, unknown>;
}

/** Result of consulting the authorization gate. */
export interface GateDecision {
  allow: boolean;
  reason: string;
  authzId: string | null;
}
