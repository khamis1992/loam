import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { redact } from "../../log.js";
import { AUDIT_FILE, AUDIT_MAX_BYTES } from "./constants.js";
import type { AuditLine } from "./types.js";

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** Argument names and a SHA-256 of the canonical values; values themselves are never stored. */
export function argDigest(args: unknown): { argNames: string[]; argsSha256: string | undefined } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { argNames: [], argsSha256: undefined };
  return {
    argNames: Object.keys(args as Record<string, unknown>).sort(),
    argsSha256: crypto.createHash("sha256").update(canonical(args)).digest("hex"),
  };
}

/** Append one JSON line; rotates to .1 at 5 MiB. Never throws. */
export function appendAudit(line: Omit<AuditLine, "at">): void {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    try {
      if (fs.statSync(AUDIT_FILE).size > AUDIT_MAX_BYTES) fs.renameSync(AUDIT_FILE, `${AUDIT_FILE}.1`);
    } catch {
      /* no file yet */
    }
    const record: AuditLine = { at: new Date().toISOString(), ...line, reason: line.reason ? redact(line.reason).slice(0, 200) : undefined };
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    /* auditing must never break a call */
  }
}

/** Last `limit` lines for the panel (newest first). */
export function readAudit(limit: number): AuditLine[] {
  try {
    const lines = fs.readFileSync(AUDIT_FILE, "utf8").trim().split("\n");
    return lines
      .slice(-limit)
      .reverse()
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as AuditLine];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
