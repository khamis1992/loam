import type { Config } from "../config.js";

export interface CommandCheck {
  ok: boolean;
  reason?: string;
}

/** Mirror of the Manus "workspace-write" policy idea: deny known-destructive patterns,
 *  optionally require an allowlist, and never allow shell escapes we cannot reason about. */
export function checkCommand(cfg: Config, command: string): CommandCheck {
  const lc = command.toLowerCase();
  for (const pat of cfg.policy.denyCommandPatterns) {
    if (pat && lc.includes(pat.toLowerCase())) {
      return { ok: false, reason: `denied command pattern: ${pat}` };
    }
  }
  const allow = cfg.policy.allowCommandPatterns.filter((p) => p && p.length > 0);
  if (allow.length > 0 && !allow.some((p) => lc.includes(p.toLowerCase()))) {
    return { ok: false, reason: "command not present in allowCommandPatterns allowlist" };
  }
  return { ok: true };
}

/** Keep the tail (like Manus' SANDBOX_COMMAND_OUTPUT_TAIL) — most useful for errors. */
export function tailOutput(s: string, max = 8000): string {
  return s.length > max ? `[...truncated ${s.length - max} chars]\n${s.slice(-max)}` : s;
}

export function headOutput(s: string, max = 8000): string {
  return s.length > max ? `${s.slice(0, max)}\n[...truncated ${s.length - max} chars]` : s;
}
