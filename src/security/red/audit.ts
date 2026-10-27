/**
 * Red-team append-only audit log (RED_TEAM_BUILD_SPEC §5.2).
 *
 * One entry per target-touching action: timestamp, AUTHZ-id, capability,
 * action, target, redacted parameters and outcome. The log is never truncated
 * by the app; rotation is copy-then-seal (archives are never touched again).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { stripSecrets } from "../../memory/redact.js";
import { canonicalJson, defaultDataRoot } from "./gate.js";

function auditSigningKey(root: string): Buffer {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "audit-hmac.key");
  if (fs.existsSync(file)) {
    const key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
    if (key.length !== 32) throw new Error("invalid audit signing key");
    return key;
  }
  const key = randomBytes(32);
  fs.writeFileSync(file, key.toString("hex"), { encoding: "utf8", mode: 0o600 });
  return key;
}

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
  private readonly root: string;
  private seq = 0;
  private lastHash = "";

  constructor(root: string = defaultDataRoot()) {
    this.root = root;
    this.dir = path.join(root, "audit");
    this.file = path.join(this.dir, "red-audit.jsonl");
    fs.mkdirSync(this.dir, { recursive: true });
    if (!this.verify()) throw new Error("audit history failed integrity verification");
    const entries = this.read();
    this.seq = entries.at(-1)?.seq ?? 0;
    this.lastHash = entries.at(-1)?.hash ?? "";
  }

  private sign(value: unknown): string {
    return createHmac("sha256", auditSigningKey(this.root)).update(canonicalJson(value)).digest("hex");
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
    full.hash = this.sign(full);
    this.lastHash = full.hash;
    fs.appendFileSync(this.file, JSON.stringify(full) + "\n", { encoding: "utf8" });
    return full;
  }

  /** Every entry in order. A malformed or torn line is a hard integrity error. */
  read(): AuditEntry[] {
    if (!fs.existsSync(this.file)) return [];
    const out: AuditEntry[] = [];
    for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AuditEntry);
      } catch {
        throw new Error("malformed audit history");
      }
    }
    return out;
  }

  /** Verify signatures, sequence and links. SHA-256 history is accepted only before the HMAC chain starts. */
  verify(): boolean {
    if (!fs.existsSync(this.file)) return true;
    let previous: string | undefined;
    let expectedSeq = 1;
    let hmacStarted = false;
    for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: AuditEntry;
      try {
        entry = JSON.parse(line) as AuditEntry;
      } catch {
        return false;
      }
      if (entry.seq !== expectedSeq++) return false;
      if (!entry.hash) {
        if (hmacStarted) return false;
        previous = undefined;
        continue;
      }
      if (previous !== undefined && (entry.prevHash ?? "") !== previous) return false;
      if (previous === undefined && entry.prevHash) return false;
      const { hash, ...unsigned } = entry;
      const keyed = this.sign(unsigned) === hash;
      const legacy = !hmacStarted && createHash("sha256").update(canonicalJson(unsigned)).digest("hex") === hash;
      if (!keyed && !legacy) return false;
      if (keyed) hmacStarted = true;
      previous = hash;
    }
    return true;
  }

  /** Copy, sign and seal the archive before starting a new independent chain. */
  seal(): string {
    if (!this.verify()) throw new Error("refusing to seal invalid audit history");
    const history = fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8") : "";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archive = path.join(this.dir, `red-audit-${stamp}.jsonl`);
    fs.writeFileSync(archive, history, { encoding: "utf8", flag: "wx" });
    const manifest = { archive: path.basename(archive), sha256: createHash("sha256").update(history).digest("hex") };
    const signed = { ...manifest, signature: this.sign(manifest) };
    fs.writeFileSync(`${archive}.manifest.json`, JSON.stringify(signed, null, 2), { encoding: "utf8", flag: "wx" });
    fs.writeFileSync(this.file, "", { encoding: "utf8" });
    this.seq = 0;
    this.lastHash = "";
    return archive;
  }

  verifyArchive(archive: string): boolean {
    try {
      if (path.dirname(path.resolve(archive)) !== path.resolve(this.dir)) return false;
      const manifestFile = `${archive}.manifest.json`;
      const parsed = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { archive: string; sha256: string; signature: string };
      const { signature, ...manifest } = parsed;
      if (parsed.archive !== path.basename(archive) || this.sign(manifest) !== signature) return false;
      return createHash("sha256").update(fs.readFileSync(archive)).digest("hex") === parsed.sha256;
    } catch {
      return false;
    }
  }
}
