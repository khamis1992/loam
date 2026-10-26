import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AuditLog } from "../audit.js";
import type { KeyProvider } from "../crypto.js";

export interface AuditAnchor {
  format: "loam-legal-audit-anchor/1";
  seq: number;
  hash: string;
  signedAt: string;
  signature: string;
}

function signature(keys: KeyProvider, seq: number, hash: string, signedAt: string): string {
  return crypto.createHmac("sha256", keys.key()).update(`${seq}|${hash}|${signedAt}`, "utf8").digest("hex");
}

export function exportAuditAnchor(audit: AuditLog, outputPath: string, keys: KeyProvider, now: () => Date = () => new Date()): AuditAnchor {
  const latest = audit.list({ limit: 1 })[0];
  const seq = latest?.seq ?? 0;
  const hash = latest?.hash ?? "0".repeat(64);
  const signedAt = now().toISOString();
  const anchor: AuditAnchor = { format: "loam-legal-audit-anchor/1", seq, hash, signedAt, signature: signature(keys, seq, hash, signedAt) };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(anchor, null, 2)}\n`);
  fs.renameSync(tmp, outputPath);
  return anchor;
}

export function verifyAuditAnchor(anchor: AuditAnchor, keys: KeyProvider): boolean {
  if (anchor.format !== "loam-legal-audit-anchor/1" || !Number.isInteger(anchor.seq) || !/^[0-9a-f]{64}$/.test(anchor.hash)) return false;
  const expected = signature(keys, anchor.seq, anchor.hash, anchor.signedAt);
  const left = Buffer.from(anchor.signature, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
