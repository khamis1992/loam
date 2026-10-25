/** Cua Driver audit log — CUA_INTO_LOAM_INTEGRATION §6.4 (appendix B4).
 *  Append-only JSONL at `<DATA_DIR>/cua/audit.jsonl`, same pattern as the rea
 *  audit log (seq continues from the existing line count; torn lines are skipped;
 *  a torn tail is healed before the next append). Scalars only: tool names,
 *  outcomes, durations, session/pid/window_id ids. **No typed text, no clipboard
 *  contents, no screenshot bytes** — tool arguments are never logged; text-bearing
 *  args (e.g. type_text) are reduced to their target ids. */
import fs from "node:fs";
import path from "node:path";

export type CuaAuditOutcome = "allowed" | "denied" | "started" | "completed" | "failed" | "skipped" | "warned";

export interface CuaAuditEntry {
  seq: number;
  at: string;
  /** Event name: cua.driver.connect | cua.driver.call | cua.driver.allowlist.reject | cua.driver.disconnect. */
  name: string;
  outcome: CuaAuditOutcome;
  tool?: string;
  /** Driver session id (opaque string id, never content). */
  session?: string;
  pid?: number;
  windowId?: number;
  durationMs?: number;
  detail?: string;
}

export function cuaAuditPath(dataDir: string): string {
  return path.join(dataDir, "cua", "audit.jsonl");
}

/** Reduce call args to the auditable scalars — anything text-shaped is dropped. */
export function cuaAuditScopes(args: Record<string, unknown>): { session?: string; pid?: number; windowId?: number } {
  const target = args["target"] as { kind?: string; pid?: number; window_id?: number } | undefined;
  const session = typeof args["session"] === "string" ? (args["session"] as string) : undefined;
  const pid = typeof args["pid"] === "number" ? (args["pid"] as number) : (typeof target?.pid === "number" ? target.pid : undefined);
  const windowId = typeof args["window_id"] === "number" ? (args["window_id"] as number) : (typeof target?.window_id === "number" ? target.window_id : undefined);
  const out: { session?: string; pid?: number; windowId?: number } = {};
  if (session !== undefined) out.session = session;
  if (pid !== undefined) out.pid = pid;
  if (windowId !== undefined) out.windowId = windowId;
  return out;
}

export class CuaAuditLog {
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

  append(entry: Omit<CuaAuditEntry, "seq" | "at">): CuaAuditEntry {
    const full: CuaAuditEntry = { seq: ++this.seq, at: new Date().toISOString(), ...entry };
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

  read(): CuaAuditEntry[] {
    try {
      return fs.readFileSync(this.file, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .flatMap((l) => {
          try { return [JSON.parse(l) as CuaAuditEntry]; } catch { return []; }
        });
    } catch {
      return [];
    }
  }
}
