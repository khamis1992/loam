import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import type { CodeGraphAuditEvent } from "./types.js";

/** Canonical-JSON sha256 of tool args: lets an auditor correlate calls without storing the question text. */
export function argsDigest(args: Record<string, unknown>): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
        : v;
  return createHash("sha256").update(JSON.stringify(canon(args))).digest("hex");
}

export class CodeGraphAudit {
  constructor(private readonly file: string) {}

  write(ev: Omit<CodeGraphAuditEvent, "ts">): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...ev }) + "\n";
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, line, "utf8");
    } catch (err) {
      log.warn(`codegraph audit write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
