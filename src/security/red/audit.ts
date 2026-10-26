/**
 * Red-team append-only audit log (RED_TEAM_BUILD_SPEC §5.2).
 *
 * One entry per target-touching action: timestamp, AUTHZ-id, capability,
 * action, target, redacted parameters and outcome. The log is never truncated
 * by the app; rotation is copy-then-seal (archives are never touched again).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { stripSecrets } from "../../memory/redact.js";
import { canonicalJson, defaultDataRoot } from "./gate.js";

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
  /** Previous entry hash and this entry's SHA256 (tamper-evident chain). */
  prevHash?: string;
  hash?: string;
}

const SECRET_KEY_RE = /cookie|authorization|bearer|token|secret|password|api[-_]?key|session/i;
const USERINFO_RE = /(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/g;
const BEARER_RE = /\bBearer\s+[^\s,;]+/gi;
const ASSIGNMENT_RE = /\b(cookie|authorization|session|token|secret|password|api[-_]?key)=([^&\s,;]+)/gi;

/** Redact a free-form string before it can become evidence or an audit line. */
export function redactText(value: string): string {
  return stripSecrets(value)
    .replace(USERINFO_RE, "$1[REDACTED]@")
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(ASSIGNMENT_RE, "$1=[REDACTED]");
}

/** Recursively redact objects/arrays; secret-like keys are masked at every depth. */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) ? "[REDACTED]" : redactValue(nested);
    }
    return out;
  }
  return value;
}

/** Mask secret-ish parameter values before anything is persisted. */
export function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  return redactValue(params) as Record<string, unknown>;
}

/**
 * Append-only JSONL audit log. Opening the same root twice continues the
 * sequence — history is counted from the file, never restarted in place.
 */
export class RedAuditLog {
  private readonly file: string;
  private readonly dir: string;
  private seq = 0;
  private lastHash = "";

  constructor(root: string = defaultDataRoot()) {
    this.dir = path.join(root, "audit");
    this.file = path.join(this.dir, "red-audit.jsonl");
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.file)) {
      const lines = fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean);
      this.seq = lines.length;
      if (lines.length) {
        try {
          this.lastHash = (JSON.parse(lines[lines.length - 1]!) as AuditEntry).hash ?? "";
        } catch {
          this.lastHash = "";
        }
      }
    }
  }

  /** Append one entry; assigns the monotonic sequence number and timestamp. */
  append(entry: Omit<AuditEntry, "seq" | "at" | "hash" | "prevHash">): AuditEntry {
    const full: AuditEntry = {
      ...entry,
      target: redactText(entry.target),
      seq: ++this.seq,
      at: new Date().toISOString(),
      params: redactParams(entry.params ?? {}),
      ...(this.lastHash ? { prevHash: this.lastHash } : {}),
    };
    full.hash = createHash("sha256").update(canonicalJson(full)).digest("hex");
    this.lastHash = full.hash;
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

  /** Verify every hash and link in the current file; malformed history fails closed. */
  verify(): boolean {
    if (!fs.existsSync(this.file)) return true;
    let previous: string | undefined;
    for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: AuditEntry;
      try {
        entry = JSON.parse(line) as AuditEntry;
      } catch {
        return false;
      }
      if (!entry.hash) {
        previous = undefined;
        continue; // legacy unsigned entries remain readable
      }
      if (previous !== undefined && (entry.prevHash ?? "") !== previous) return false;
      const { hash, ...unsigned } = entry;
      const expected = createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
      if (expected !== hash) return false;
      previous = hash;
    }
    return true;
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
