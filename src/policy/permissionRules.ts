/**
 * Permission rules: user-configured `allow` / `deny` / `ask` lists whose entries
 * are `tool(pattern)` rules, evaluated BEFORE the risk-tier matrix.
 *
 * A rule names a tool and, optionally, a glob over the tool's primary argument
 * (see `primaryArgument` in `./riskTier.ts`):
 *
 *   shell_run(npm test*)      — every `shell_run` whose command starts with "npm test"
 *   file_write(src/**)        — writes under `src/`
 *   web_fetch(https://*.example.com/*)
 *   file_read                 — the whole tool, any arguments
 *   file_read()               — same as above
 *
 * Glob syntax is case-insensitive and supports `*` (any run of characters,
 * including none and including spaces), `?` (exactly one character) and
 * `[abc]` / `[a-z]` character sets. Everything else is matched literally.
 *
 * Precedence is deny > ask > allow: a prohibition always wins, a request for
 * confirmation wins over a blanket allowance, and an allowance only applies
 * when nothing stricter matched. When no rule matches the caller falls through
 * to the sandbox/risk-tier gate unchanged.
 *
 * This module is pure (no I/O, no clock) so it can be unit-tested as a rule
 * matrix and reused by the protocol adapter, the desktop operator and the loop.
 */
import {
  DEFAULT_SANDBOX_MODE,
  classifyToolCall,
  primaryArgument,
  resolveGate,
  type GateDecision,
  type GateRuleLike,
  type SandboxMode,
} from "./riskTier.js";
import { LruCache } from "../memory/cache.js";
import { registerCacheStats } from "../memory/stats.js";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type PermissionAction = "allow" | "deny" | "ask";

export const PERMISSION_ACTIONS: readonly PermissionAction[] = ["allow", "deny", "ask"];

export function isPermissionAction(value: unknown): value is PermissionAction {
  return typeof value === "string" && (PERMISSION_ACTIONS as string[]).includes(value);
}

/** A parsed rule: tool name plus the optional argument glob. */
export interface PermissionRulePattern {
  /** Lower-cased tool name; matching is case-insensitive. */
  tool: string;
  /** `null` means "any arguments". */
  pattern: string | null;
}

/** A rule pattern bound to the list it came from. */
export interface PermissionRule extends PermissionRulePattern {
  action: PermissionAction;
}

export type ParseRuleResult =
  | { ok: true; value: PermissionRulePattern }
  | { ok: false; error: string };

// ----------------------------------------------------------------------------
// Parsing
// ----------------------------------------------------------------------------

const TOOL_NAME_RE = /^[A-Za-z0-9_.:@/-]+$/;

/**
 * Parse one `tool` / `tool(pattern)` entry. The action is deliberately not part
 * of the text: it comes from the list the entry belongs to.
 */
export function parsePermissionRulePattern(rule: string): ParseRuleResult {
  const raw = rule.trim();
  if (!raw) return { ok: false, error: "empty permission rule" };

  const open = raw.indexOf("(");
  if (open === -1) {
    const tool = raw.trim();
    if (!TOOL_NAME_RE.test(tool)) return { ok: false, error: `invalid tool name in "${raw}"` };
    return { ok: true, value: { tool: tool.toLowerCase(), pattern: null } };
  }

  if (!raw.endsWith(")")) {
    return { ok: false, error: `permission rule "${raw}" must end with ")"` };
  }
  const tool = raw.slice(0, open).trim();
  if (!TOOL_NAME_RE.test(tool)) return { ok: false, error: `invalid tool name in "${raw}"` };

  const pattern = raw.slice(open + 1, -1).trim();
  return { ok: true, value: { tool: tool.toLowerCase(), pattern: pattern.length > 0 ? pattern : null } };
}

export interface PermissionRuleSet {
  allow: PermissionRule[];
  deny: PermissionRule[];
  ask: PermissionRule[];
}

export interface BuildRuleSetInput {
  allow?: readonly string[];
  deny?: readonly string[];
  ask?: readonly string[];
}

/**
 * Build the three rule lists from raw strings, dropping malformed entries and
 * reporting them so a caller can surface configuration errors instead of
 * silently ignoring a typo.
 */
export function buildPermissionRuleSet(input: BuildRuleSetInput = {}): {
  set: PermissionRuleSet;
  errors: string[];
} {
  const errors: string[] = [];
  const build = (entries: readonly string[] | undefined, action: PermissionAction): PermissionRule[] => {
    const out: PermissionRule[] = [];
    for (const entry of entries ?? []) {
      const parsed = parsePermissionRulePattern(entry);
      if (!parsed.ok) {
        errors.push(parsed.error);
        continue;
      }
      out.push({ ...parsed.value, action });
    }
    return out;
  };
  return {
    set: {
      allow: build(input.allow, "allow"),
      deny: build(input.deny, "deny"),
      ask: build(input.ask, "ask"),
    },
    errors,
  };
}

// ----------------------------------------------------------------------------
// Glob matching
// ----------------------------------------------------------------------------

/** Bounded glob→RegExp cache (J6): only user-authored patterns ever enter it,
 *  but a long-lived session with many distinct rules must not grow forever. */
const globCache = new LruCache<RegExp>({ capacity: 256, name: "policy-glob" });
registerCacheStats("policy-glob", () => globCache.stats());

function compileGlob(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      out += ".*";
    } else if (ch === "?") {
      out += ".";
    } else if (ch === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
      } else {
        let set = glob.slice(i + 1, end);
        if (set.startsWith("!")) set = `^${set.slice(1)}`;
        set = set.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
        out += `[${set}]`;
        i = end;
      }
    } else if ("\\^$.|+(){}".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`, "i");
}

/** Compile (and cache) a glob into an anchored, case-insensitive RegExp. */
export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  const compiled = compileGlob(glob);
  globCache.set(glob, compiled);
  return compiled;
}

/** True when `value` matches the glob `pattern` (case-insensitive). */
export function matchGlob(value: string, pattern: string): boolean {
  return globToRegExp(pattern).test(value);
}

// ----------------------------------------------------------------------------
// Evaluation
// ----------------------------------------------------------------------------

export interface PermissionEvaluationInput {
  allow?: readonly string[];
  deny?: readonly string[];
  ask?: readonly string[];
  tool: string;
  args?: unknown;
}

export interface PermissionMatch {
  action: PermissionAction;
  rule: PermissionRule;
  /** The primary argument string that was tested (useful for diagnostics). */
  matchedValue: string;
}

function asArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

/**
 * Evaluate the three lists against one tool call.
 *
 * Returns the winning rule or `null` when nothing matched (the caller should
 * then apply the risk-tier gate). Within each list the first matching entry in
 * declaration order wins; across lists deny beats ask beats allow.
 */
export function evaluatePermissionRules(input: PermissionEvaluationInput): PermissionMatch | null {
  const tool = input.tool.trim().toLowerCase();
  if (!tool) return null;
  const args = asArgs(input.args);
  const value = primaryArgument(input.tool, args);

  const check = (entries: readonly string[], action: PermissionAction): PermissionMatch | null => {
    for (const entry of entries ?? []) {
      const parsed = parsePermissionRulePattern(entry);
      if (!parsed.ok) continue;
      const { tool: ruleTool, pattern } = parsed.value;
      if (ruleTool !== tool) continue;
      if (pattern === null || matchGlob(value, pattern)) {
        return { action, rule: { tool: ruleTool, pattern, action }, matchedValue: value };
      }
    }
    return null;
  };

  return check(input.deny ?? [], "deny") ?? check(input.ask ?? [], "ask") ?? check(input.allow ?? [], "allow");
}

// ----------------------------------------------------------------------------
// Composition with the risk-tier gate
// ----------------------------------------------------------------------------

export interface ToolPermissionInput extends PermissionEvaluationInput {
  /** Workspace root used only when falling through to the risk-tier classifier. */
  workspaceRoot?: string;
  /** Sandbox mode used only when falling through to the risk-tier gate. */
  mode?: SandboxMode;
  /** Saved approval rule, passed through to `resolveGate`. */
  rule?: GateRuleLike | null;
  /** Per-task "Approve for me" toggle, passed through to `resolveGate`. */
  autoApprove?: boolean;
}

export interface ToolPermissionResolution {
  decision: GateDecision;
  source: "permission-rule" | "matrix" | "rule" | "auto";
  reason: string;
  matchedRule?: PermissionRule;
}

/**
 * Resolve one tool call: permission rules first, risk-tier gate second.
 *
 * A matching rule decides immediately (`allow`/`ask`/`deny`) and is reported
 * with `source: "permission-rule"`. Otherwise the call is classified into a
 * risk tier and the sandbox matrix, saved rules and task auto-approve toggle
 * decide exactly as before.
 */
export function evaluateToolPermission(input: ToolPermissionInput): ToolPermissionResolution {
  const match = evaluatePermissionRules(input);
  if (match) {
    return {
      decision: match.action,
      source: "permission-rule",
      reason: `${match.action} rule matched ${match.rule.tool}${match.rule.pattern ? `(${match.rule.pattern})` : ""}`,
      matchedRule: match.rule,
    };
  }

  const tier = classifyToolCall(input.tool, asArgs(input.args), input.workspaceRoot);
  const gate = resolveGate({
    mode: input.mode ?? DEFAULT_SANDBOX_MODE,
    tier,
    rule: input.rule,
    autoApprove: input.autoApprove,
  });
  return { decision: gate.decision, source: gate.source, reason: gate.reason ?? "" };
}
