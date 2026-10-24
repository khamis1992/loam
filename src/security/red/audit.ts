/**
 * Red-team append-only audit log (RED_TEAM_BUILD_SPEC §5.2).
 *
 * One entry per target-touching action: timestamp, AUTHZ-id, capability,
 * action, target, redacted parameters and outcome. The log is never truncated
 * by the app; rotation is copy-then-seal (archives are never touched again).
 */
import fs from "node:fs";
import path from "node:path";
import { defaultDataRoot } from "./gate.js";

export type AuditOutcome =
  | "allowed"
  | "denied"
  | "started"
  | "completed"
  | "failed"
  | "killswitch_engaged"
  | "destructive_approved";

export interface AuditEntry {
  seq: number;
  /** ISO-8601 (UTC; Riyadh is UTC+3). */
  at: string;
  authzId: string | null;
  capability: string;
  action: string;
  target: string;
  /** Already redacted at append time. */
  params: Record<string, unknown>;
  outcome: AuditOutcome;
  reason?: string;
  evidenceIds?: string[];
}

const SECRET_KEY_RE = /cookie|authorization|bearer|token|secret|password|api[-_]?key|session/i;

/** Mask secret-ish parameter values before anything is persisted. */
export function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = SECRET_KEY_RE.test(key) ? "[REDACTED]" : value;
  }
  return out;
}

/**
 * Append-only JSONL audit log. Opening the same root twice continues the
 * sequence — history is counted from the file, never restarted in place.
 */
export class RedAuditLog {
  private readonly file: string;
  private readonly dir: string;
  private seq = 0;

  constructor(root: string = defaultDataRoot()) {
    this.dir = path.join(root, "audit");
    this.file = path.join(this.dir, "red-audit.jsonl");
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.file)) {
      const lines = fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean);
      this.seq = lines.length;
    }
  }

  /** Append one entry; assigns the monotonic sequence number and timestamp. */
  append(entry: Omit<AuditEntry, "seq" | "at">): AuditEntry {
    const full: AuditEntry = {
      ...entry,
      seq: ++this.seq,
      at: new Date().toISOString(),
      params: redactParams(entry.params ?? {}),
    };
    fs.appendFileSync(this.file, JSON.stringify(full) + "\n", { encoding: "utf8" });
    return full;
  }

  /** Every entry in order. Malformed lines are skipped, never thrown. */
  read(): AuditEntry[] {
    if (!fs.existsSync(this.file)) return [];
    const out: AuditEntry[] = [];
    for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AuditEntry);
      } catch {
        /* a torn line never breaks reads */
      }
    }
    return out;
  }

  /**
   * Rotate copy-then-seal: the current history is copied verbatim to an
   * archive file that is never written again, and the live file restarts.
   * Returns the archive path.
   */
  seal(): string {
    const history = fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8") : "";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archive = path.join(this.dir, `red-audit-${stamp}.jsonl`);
    fs.writeFileSync(archive, history, { encoding: "utf8" });
    fs.writeFileSync(this.file, "", { encoding: "utf8" });
    this.seq = 0;
    return archive;
  }
}
