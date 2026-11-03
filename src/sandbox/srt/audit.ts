/** srt audit log — SANDBOX_RUNTIME_INTO_LOAM §6.4 (appendix C3).
 *  Append-only JSONL at `<DATA_DIR>/srt/audit.jsonl`, same pattern as the rea/cua
 *  audit logs (seq continues from full lines; torn tails healed before append).
 *  Scalars only: modes, counts, exit codes, durations, command ids. Never proxy
 *  auth tokens, DPAPI blobs, environment values, or raw command text. */
import fs from "node:fs";
import path from "node:path";
import { srtAuditPath } from "./policy.js";

export type SrtAuditOutcome = "started" | "completed" | "failed" | "denied" | "skipped" | "warned";

export interface SrtAuditEntry {
  seq: number;
  at: string;
  name:
    | "srt_install_started"
    | "srt_install_finished"
    | "srt_session_open"
    | "srt_session_close"
    | "srt_exec"
    | "srt_violation"
    | "srt_blocked_tool";
  outcome: SrtAuditOutcome;
  mode?: string;
  commandId?: string;
  toolName?: string;
  cwd?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  sandboxed?: boolean;
  durationMs?: number;
  violationCount?: number;
  allowedDomainsCount?: number;
  skipProfileGrant?: boolean;
  detail?: string;
}

export class SrtAuditLog {
  private readonly file: string;
  private seq = 0;

  constructor(file: string) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.seq = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0).length;
    } catch {
      this.seq = 0;
    }
  }

  append(entry: Omit<SrtAuditEntry, "seq" | "at">): SrtAuditEntry {
    const full: SrtAuditEntry = { seq: ++this.seq, at: new Date().toISOString(), ...entry };
    let prefix = "";
    try {
      const stat = fs.statSync(this.file);
      if (stat.size > 0) {
        const fd = fs.openSync(this.file, "r");
        const tail = Buffer.alloc(1);
        fs.readSync(fd, tail, 0, 1, stat.size - 1);
        fs.closeSync(fd);
        if (tail[0] !== 0x0a) prefix = "\n";
      }
    } catch { /* new file */ }
    fs.appendFileSync(this.file, `${prefix}${JSON.stringify(full)}\n`, "utf8");
    return full;
  }

  read(): SrtAuditEntry[] {
    try {
      return fs.readFileSync(this.file, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .flatMap((l) => {
          try { return [JSON.parse(l) as SrtAuditEntry]; } catch { return []; }
        });
    } catch {
      return [];
    }
  }
}

/** Singleton bound to the configured data dir. */
let log: SrtAuditLog | undefined;
export function srtAudit(): SrtAuditLog {
  if (!log) log = new SrtAuditLog(srtAuditPath());
  return log;
}
