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

/**
 * Shell command patterns that irreversibly destroy data, change external state,
 * or execute untrusted code. Mirrored by the risk-tier classifier
 * (src/policy/riskTier.ts): a command matching any of these is `destructive`.
 *
 * Matching is deliberately conservative and substring-based per command segment
 * so that `git reset --hard` and `curl … | sh` are caught while `git status`
 * and a plain `curl https://example.com` (a read-only network call) are not.
 */
const DESTRUCTIVE_COMMAND_PATTERNS: readonly string[] = [
  "rm -rf",
  "rm -fr",
  "rm -r",
  "rm --recursive",
  "rmdir /s",
  "rd /s",
  "del /f",
  "del /s /q",
  "remove-item -recurse -force",
  "format ",
  "mkfs",
  "fdisk",
  "dd if=",
  "git reset --hard",
  "git clean -fd",
  "git clean -f",
  "git push",
  "git branch -d",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init 0",
  "init 6",
  "reg add",
  "reg delete",
  "regsvr32",
  "net user ",
  "net localgroup ",
  "sc delete",
  "netsh ",
  "takeown /f",
  "icacls ",
  "chmod -r",
  "chown -r",
  "drop table",
  "truncate table",
  "delete from",
  "| sh",
  "| sh ",
  "|sh",
  "| bash",
  "| bash ",
  "|bash",
  "curl -fsSL",
  "wget -o-",
  ":(){",
  "killall ",
  "pkill ",
  "taskkill",
];

/** Split a shell line into one token array per `&&`/`||`/`;`/`|`/newline segment. */
export function parseShellCommandSegments(command: string): string[][] {
  return command
    .split(/&&|\|\||;|\||\r?\n/)
    .map((segment) => segment.trim().split(/\s+/).filter(Boolean));
}

/** True when any command segment matches a known destructive pattern. */
export function isDestructiveCommand(command: string): boolean {
  if (!command || !command.trim()) return false;
  const lc = command.toLowerCase();
  return DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => lc.includes(pattern));
}

/** Keep the tail (like Manus' SANDBOX_COMMAND_OUTPUT_TAIL) — most useful for errors. */
export function tailOutput(s: string, max = 8000): string {
  return s.length > max ? `[...truncated ${s.length - max} chars]\n${s.slice(-max)}` : s;
}

export function headOutput(s: string, max = 8000): string {
  return s.length > max ? `${s.slice(0, max)}\n[...truncated ${s.length - max} chars]` : s;
}
