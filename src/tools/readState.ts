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

/** Path of a file this session has read plus the exact content it saw. */
export interface ReadSnapshot {
  path: string;
  content: string;
}

export type ReadGuardResult = { ok: true } | { ok: false; code: ReadGuardCode; message: string };

/** Cross-session file-touch observer (jcode J8). `read` fires after a read is
 *  recorded, `write` after a write/edit refreshed the snapshot. Optional so a
 *  read-only verifier or an isolated unit test runs without a registry. */
export interface ReadTouchHooks {
  read?: (abs: string, content?: string) => void;
  write?: (abs: string, content?: string) => void;
  /** Fired when a file is deleted or moved away, so readers can be told. */
  remove?: (abs: string) => void;
}

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
  hooks?: ReadTouchHooks;

  private key(p: string): string {
    return path.resolve(p);
  }

  /** Snapshot the file on disk and remember it. Returns the absolute path and
   *  the exact content stored, or undefined when the file cannot be read. */
  private store(p: string, content?: string): { abs: string; content: string } | undefined {
    const abs = this.key(p);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return undefined;
    }
    let text: string;
    if (content !== undefined) {
      text = content;
    } else {
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        return undefined;
      }
    }
    this.records.set(abs, { mtimeMs: st.mtimeMs, size: st.size, hash: hashContent(text) });
    return { abs, content: text };
  }

  /** Record a file as read. Pass the content when the caller already read it. */
  record(p: string, content?: string): ReadSnapshot | undefined {
    const stored = this.store(p, content);
    if (!stored) return undefined;
    const snapshot: ReadSnapshot = { path: stored.abs, content: stored.content };
    this.hooks?.read?.(snapshot.path, snapshot.content);
    return snapshot;
  }

  /** Record a file this session just wrote or edited. The new content is
   *  published to the cross-session touch observer so other live sessions are
   *  told exactly what changed (jcode J8). */
  recordWrite(p: string, content?: string): void {
    const stored = this.store(p, content);
    if (stored) this.hooks?.write?.(stored.abs, stored.content);
  }

  /** Forget a file (for example after it was deleted or moved). */
  forget(p: string): void {
    const abs = this.key(p);
    this.records.delete(abs);
    this.hooks?.remove?.(abs);
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
