import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ToolContext, ToolResult } from "./registry.js";

export type ReadGuardCode = "NOT_READ" | "STALE";

/** Snapshot of a file at the moment it was read. */
export interface FileReadRecord {
  mtimeMs: number;
  size: number;
  hash: string;
}

export type ReadGuardResult = { ok: true } | { ok: false; code: ReadGuardCode; message: string };

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Per-session record of which files the agent has read and in what state.
 *
 * Edit and write tools consult this before touching an existing file so a
 * model can never blind-edit content it has not seen, and can never overwrite
 * a file that changed on disk since it was read. A fresh instance starts empty
 * for every agent run; `file_read` populates it.
 */
export class ReadState {
  private readonly records = new Map<string, FileReadRecord>();

  private key(p: string): string {
    return path.resolve(p);
  }

  /** Record a file as read. Pass the content when the caller already read it. */
  record(p: string, content?: string): void {
    const abs = this.key(p);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    let hash: string;
    if (content !== undefined) {
      hash = hashContent(content);
    } else {
      try {
        hash = hashContent(fs.readFileSync(abs, "utf8"));
      } catch {
        return;
      }
    }
    this.records.set(abs, { mtimeMs: st.mtimeMs, size: st.size, hash });
  }

  /** Forget a file (for example after it was deleted or moved). */
  forget(p: string): void {
    this.records.delete(this.key(p));
  }

  hasRead(p: string): boolean {
    return this.records.has(this.key(p));
  }

  /** Verify the file on disk still matches the recorded read. */
  check(p: string): ReadGuardResult {
    const abs = this.key(p);
    const record = this.records.get(abs);
    if (!record) {
      return {
        ok: false,
        code: "NOT_READ",
        message: `Not read yet: read ${abs} with file_read before editing it. Reading first gives you the exact current content, then retry this edit. (NOT_READ)`,
      };
    }
    let st: fs.Stats;
    let current: string;
    try {
      st = fs.statSync(abs);
      current = fs.readFileSync(abs, "utf8");
    } catch {
      return {
        ok: false,
        code: "STALE",
        message: `${abs} is no longer readable or was removed since you read it. Read it again with file_read, then retry this edit. (STALE)`,
      };
    }
    if (st.mtimeMs !== record.mtimeMs || st.size !== record.size || hashContent(current) !== record.hash) {
      return {
        ok: false,
        code: "STALE",
        message: `${abs} changed on disk since you last read it (by you, the user, or a formatter). Read it again with file_read to refresh your view, then retry this edit. (STALE)`,
      };
    }
    return { ok: true };
  }
}

/**
 * Guard a write or edit to an existing file. Returns a failure result when the
 * file exists but was not read in this session, or changed since it was read.
 * Files that do not exist on disk are always allowed (they are new).
 *
 * When the run context carries no ReadState (for example an isolated unit test
 * or a read-only verifier sub-run) the guard is skipped.
 */
export function guardExistingEdit(ctx: ToolContext, p: string): ToolResult | null {
  const state = ctx.readState;
  if (!state) return null;
  if (!fs.existsSync(p)) return null;
  const result = state.check(p);
  if (result.ok) return null;
  return { ok: false, content: result.message };
}
