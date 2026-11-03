/** MCP stdio sandbox wrap — SANDBOX_RUNTIME_INTO_LOAM §7.2/Appendix A
 *  (appendix C4: OPT-IN per server via `"sandbox": true` in mcpServers — never
 *  default-on, because loopback-dependent servers like memory-skills→Ollama would
 *  break under OD-5). Rewrites the spawn to
 *  `node <pin>/dist/cli.js --settings <loam-srt-settings> -- <original…>` so the
 *  MCP server process tree runs inside the OS sandbox. The CLI reads our complete
 *  settings file; we refresh it at wrap time so domain edits apply on reconnect. */
import { resolveSrtPolicy, srtCliEntry, srtSettingsFile, srtWinExePath } from "./policy.js";
import { writeSrtSettingsFile } from "./session.js";
import { srtAudit } from "./audit.js";
import { getSettings } from "../../server/settings.js";

export interface WrappableCommand {
  command: string;
  args: string[];
}

/** Returns the wrapped spawn when the server opted in AND the mode is on;
 *  null leaves the original command untouched. */
export function wrapMcpCommandForSandbox(
  cfg: { sandbox?: boolean } & WrappableCommand,
  workspace: string,
  dataDirSettings: { sandboxMode?: string; sandboxAllowedDomains?: string[] } = getSettings(),
): { command: string; args: string[]; settingsFile: string } | null {
  if (cfg.sandbox !== true) return null;
  const mode = dataDirSettings.sandboxMode === "untrusted_only" || dataDirSettings.sandboxMode === "all_shell"
    ? dataDirSettings.sandboxMode
    : "off";
  if (mode === "off") return null;
  const policy = resolveSrtPolicy({ sandboxMode: mode, sandboxAllowedDomains: dataDirSettings.sandboxAllowedDomains });
  // Refresh the CLI settings file so the wrap always uses the current allowlist.
  const settingsFile = writeSrtSettingsFile(policy, workspace, srtWinExePath());
  srtAudit().append({ name: "srt_session_open", outcome: "completed", mode, allowedDomainsCount: policy.allowedDomains.length, detail: `mcp-wrap ${workspace}` });
  return {
    // node <cli> --settings <file> -- <original command> <original args…>
    command: process.execPath,
    args: [srtCliEntry(), "--settings", settingsFile, "--", cfg.command, ...cfg.args],
    settingsFile,
  };
}
