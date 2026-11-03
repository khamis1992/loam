/**
 * MCP / agent-tool surface scanner (ALL_SERVICES §12) — the Loam-aware check, first-party.
 * Static analysis of what Loam itself loads: bridge manifests (over-broad declared
 * effects vs argv needs, unpinned commands), skills (prompt-injection sinks in SKILL.md),
 * and configured MCP servers. No network: reads local manifests/config only.
 */
import fs from "node:fs";
import path from "node:path";
import type { RawFinding } from "../normalize/types.js";

export interface BridgeManifestShape {
  id?: string;
  name?: string;
  effect?: string;
  version?: string;
  commands?: Array<{ name?: string; effect?: string; argv?: unknown[]; timeoutSeconds?: number }>;
}

const WRITE_HINTS = /(write|save|export|render|convert|encode|build|compile)/i;
const NET_HINTS = /(upload|publish|send|fetch|download|sync|push)/i;

/** A command whose declared effect exceeds what its argv plausibly needs. */
export function scanBridgeManifest(m: BridgeManifestShape, file: string): RawFinding[] {
  const out: RawFinding[] = [];
  const id = m.id ?? path.basename(file);
  if (!m.version && (m.commands?.length ?? 0) > 0) {
    out.push({ engine: "mcp", ruleId: "unpinned", severity: "low", target: `${file}:${id}`,
      title: `Bridge "${id}" is not version-pinned`,
      detail: "Without a version pin the executed binary can drift between installs.",
      remediation: "Pin the engine version in the manifest and probe it at load." });
  }
  for (const cmd of m.commands ?? []) {
    if (!cmd.name) continue;
    const argvText = (cmd.argv ?? []).map((t) => (typeof t === "string" ? t : JSON.stringify(t))).join(" ");
    if ((cmd.effect === "write_workspace" || cmd.effect === "exec_script") && !WRITE_HINTS.test(cmd.name) && !WRITE_HINTS.test(argvText)) {
      out.push({ engine: "mcp", ruleId: "over-broad-effect", severity: "medium", target: `${file}:${cmd.name}`,
        title: `Command "${cmd.name}" declares ${cmd.effect} beyond its argv`,
        detail: `Declared effect ${cmd.effect} but neither the command name nor argv suggests writes or script execution.`,
        remediation: "Declare the minimum effect (read) unless the command really writes or executes." });
    }
    if (cmd.effect === "read" && NET_HINTS.test(cmd.name)) {
      out.push({ engine: "mcp", ruleId: "under-declared-effect", severity: "medium", target: `${file}:${cmd.name}`,
        title: `Command "${cmd.name}" looks network-bound but declares read`,
        detail: "A read effect cannot gate an outbound network action.",
        remediation: "Declare effect external and route through the authorized-scope gate." });
    }
  }
  return out;
}

const INJECTION_PATTERNS: Array<[RegExp, string, RawFinding["severity"]]> = [
  [/ignore (all )?(previous|prior|above) instructions/i, "instruction-override", "critical"],
  [/(you are now|act as|pretend to be) (a|an) .{0,40}(developer|admin|root|dan)/i, "persona-injection", "high"],
  [/exfiltrat|send (this|the) (file|content|data|secret)s? (to|over)|(?:curl|wget)\s+(?:-[A-Za-z]+\s+)*https?:\/\//i, "exfil-hint", "critical"],
  [/delete (all|the) (files|workspace)|rm\s+-rf?\s+\//i, "destructive-hint", "critical"],
  [/\bAPI[_ -]?KEY\b\s*[:=]\s*[A-Za-z0-9_\-]{16,}/, "embedded-credential", "critical"],
];

/** SKILL.md / prompt-asset scan: injection sinks written as data, flagged as findings. */
export function scanSkillDocument(text: string, file: string): RawFinding[] {
  const out: RawFinding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [re, ruleId, severity] of INJECTION_PATTERNS) {
      if (!re.test(line)) continue;
      out.push({ engine: "mcp", ruleId: `skill-${ruleId}`, severity, target: `${file}:${i + 1}`,
        title: `Skill content contains a ${ruleId} pattern`,
        detail: line.trim().slice(0, 160),
        remediation: "Treat skill text as untrusted content; rewrite or quarantine the skill before activation." });
      break;
    }
  });
  return out;
}

export interface McpServerConfigShape { command?: string; url?: string; args?: string[]; env?: Record<string, unknown> }

/** Configured MCP servers: shell-spawn commands and inline secrets in env. */
export function scanMcpServerConfig(name: string, cfg: McpServerConfigShape, file: string): RawFinding[] {
  const out: RawFinding[] = [];
  if (cfg.command && (cfg.command.includes("&&") || /;\s*\S/.test(cfg.command) || /[|>]/.test(cfg.command))) {
    out.push({ engine: "mcp", ruleId: "shell-mcp-command", severity: "high", target: `${file}:${name}`,
      title: `MCP server "${name}" spawns through a shell line`,
      detail: `command contains shell metacharacters: ${cfg.command.slice(0, 120)}`,
      remediation: "Use a plain executable path with an args array; no shell chaining." });
  }
  for (const [k, v] of Object.entries(cfg.env ?? {})) {
    if (/key|token|secret|password/i.test(k) && typeof v === "string" && v.length >= 12) {
      out.push({ engine: "mcp", ruleId: "mcp-env-secret", severity: "high", target: `${file}:${name}.${k}`,
        title: `MCP server "${name}" carries an inline secret env (${k.replace(/[A-Za-z0-9]/g, (c, idx) => (idx < 3 ? c : "*"))})`,
        detail: "Secret values in config files leak through backups and logs.",
        remediation: "Move the credential into the secret store and reference it." });
    }
  }
  if (cfg.url && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(cfg.url) && /^https?:\/\//i.test(cfg.url)) {
    out.push({ engine: "mcp", ruleId: "non-loopback-mcp", severity: "medium", target: `${file}:${name}`,
      title: `MCP server "${name}" points at a non-loopback URL`,
      detail: "Every tool result from this server is untrusted remote content and its reachability depends on the network.",
      remediation: "Prefer local servers; otherwise pin and review the remote's tool surface explicitly." });
  }
  return out;
}
