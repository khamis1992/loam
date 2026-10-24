/** REA audit log — REA_INTO_LOAM_INTEGRATION §4.4 (appendix A5).
 *  Append-only JSONL at `<DATA_DIR>/rea/audit.jsonl`, same pattern as the red
 *  audit log (seq continues from the existing line count; torn lines are skipped).
 *  Entries carry scalars only — tool names, outcomes, digests, byte counts, durations.
 *  No tool arguments (they may contain target bytes), no secrets, ever. */
import fs from "node:fs";
import path from "node:path";

export type ReaAuditOutcome = "allowed" | "started" | "completed" | "failed" | "skipped" | "warned";

export interface ReaAuditEntry {
  seq: number;
  at: string;
  /** Event name, e.g. `rea.mcp.connect`, `rea.mcp.call`, `rea.bundle.import`, `rea.asar.audit`. */
  name: string;
  outcome: ReaAuditOutcome;
  tool?: string;
  target?: string;
  contentDigest?: string;
  bytes?: number;
  durationMs?: number;
  detail?: string;
}

export function reaAuditPath(dataDir: string): string {
  return path.join(dataDir, "rea", "audit.jsonl");
}

export class ReaAuditLog {
  private readonly file: string;
  private seq = 0;

  constructor(file: string) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
      this.seq = lines.length;
    } catch {
      this.seq = 0;
    }
  }

  append(entry: Omit<ReaAuditEntry, "seq" | "at">): ReaAuditEntry {
    const full: ReaAuditEntry = { seq: ++this.seq, at: new Date().toISOString(), ...entry };
    // Heal a torn line first: a crash mid-write leaves no trailing newline, and a
    // plain append would merge the fragment with this entry, losing both.
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

  read(): ReaAuditEntry[] {
    try {
      return fs.readFileSync(this.file, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .flatMap((l) => {
          try { return [JSON.parse(l) as ReaAuditEntry]; } catch { return []; }
        });
    } catch {
      return [];
    }
  }
}
