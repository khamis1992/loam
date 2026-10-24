import crypto from "node:crypto";
import path from "node:path";
import { putEntity as put, getEntity as get, allEntities as all, transaction } from "./sqliteStore.js";
import { getTask, type Task, type TaskMessage } from "./db.js";
import { redact } from "../log.js";
import { assertReplayClean, buildRunReplay, type RunReplay } from "../graph/export.js";
import { getRunNodes } from "../agent/runGraphAdapter.js";

/**
 * Public read-only task shares (option #11).
 *
 * A share is an unguessable urlsafe token that exposes one task's transcript
 * (messages + artifact names only — never tool arguments, env or secrets) via
 * GET /api/share/:token. Tokens live in the generic entity store so no
 * migration is needed; revocation is a timestamp, never a delete, so a
 * revoked token stays revoked forever.
 */

export interface ShareToken {
  /** Entity id; equals the token so lookups are one keyed read. */
  id: string;
  token: string;
  taskId: string;
  createdAt: string;
  revokedAt?: string | null;
}

export interface SharedMessage {
  role: TaskMessage["role"];
  content: string;
  at: string;
}

export interface SharedTranscript {
  title: string;
  status: Task["status"];
  createdAt: string;
  updatedAt: string;
  messages: SharedMessage[];
  /** Basenames of files the run produced (uploads/attachments); no paths, no tool args. */
  artifacts: string[];
  /**
   * Neo N14: the run graph as a self-contained replay, when the run produced
   * nodes. Omitted when there is no graph to show, so a task that never reached
   * the run-graph agent keeps the same shape it had before.
   */
  replay?: RunReplay;
}

const SHARE_KIND = "share_tokens";
const MAX_ARTIFACTS = 100;

export function generateShareToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function isUrlSafeToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** Active (non-revoked) share for a task, if any. */
export function findActiveShareByTask(taskId: string): ShareToken | undefined {
  return all<ShareToken>(SHARE_KIND).find((s) => s.taskId === taskId && !s.revokedAt);
}

export function getShareRecord(token: string): ShareToken | undefined {
  if (typeof token !== "string" || !isUrlSafeToken(token)) return undefined;
  return get<ShareToken>(SHARE_KIND, token);
}

/** A share usable for reading: exists, well-formed token, never revoked. */
export function getActiveShare(token: string): ShareToken | undefined {
  const record = getShareRecord(token);
  if (!record || record.revokedAt) return undefined;
  return record;
}

export function createShare(taskId: string): ShareToken | undefined {
  if (!getTask(taskId)) return undefined;
  const existing = findActiveShareByTask(taskId);
  if (existing) return existing;
  const token = generateShareToken();
  const share: ShareToken = { id: token, token, taskId, createdAt: new Date().toISOString() };
  put(SHARE_KIND, share);
  return share;
}

export function revokeShare(token: string): boolean {
  return transaction(() => {
    const record = getShareRecord(token);
    if (!record || record.revokedAt) return false;
    record.revokedAt = new Date().toISOString();
    put(SHARE_KIND, record);
    return true;
  });
}

function baseName(name: string): string {
  return name.replace(/\\/g, "/").split("/").pop() ?? name;
}

/**
 * Artifact basenames mentioned in run steps, without any tool arguments.
 * Only the file names of upload/attachment events and file_write/file_edit
 * targets are surfaced; args themselves (which may embed env or secrets) are
 * never included. Every name goes through redact() as defense in depth.
 */
function artifactNames(task: Task): string[] {
  const names = new Set<string>();
  for (const step of task.steps ?? []) {
    const data = (step.data ?? {}) as Record<string, unknown>;
    if (step.type === "attachment" && typeof data.name === "string") {
      names.add(baseName(data.name));
      continue;
    }
    if (step.type === "tool_call" && (data.name === "file_write" || data.name === "file_edit")) {
      const args = (data.args ?? {}) as Record<string, unknown>;
      if (typeof args.path === "string") names.add(baseName(args.path));
    }
  }
  return [...names].slice(0, MAX_ARTIFACTS).map((n) => redact(n));
}

/** Read-only, sanitized transcript: messages + artifact names, nothing else. */
export function sanitizeTranscript(task: Task): SharedTranscript {
  // Neo N14: a public share is also where a static replay belongs, so the graph
  // travels with the transcript. A task with no graph nodes (or a run that failed
  // before the agent emitted anything) keeps its previous shape.
  let replay: RunReplay | undefined;
  try {
    const nodes = getRunNodes(task.id);
    if (nodes.length > 0) {
      replay = buildRunReplay({ runId: task.id, title: task.title, nodes });
      // Fail closed: a share is published by definition, so a bundle that still
      // carries a credential must not leave this function at all.
      assertReplayClean(replay);
    }
  } catch {
    // Never let the replay break the share feed: a broken export degrades to a
    // transcript-only share rather than a 500 on a public page.
    replay = undefined;
  }
  return {
    title: redact(String(task.title ?? "")),
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    messages: (task.messages ?? []).map((m) => ({ role: m.role, content: redact(String(m.content ?? "")), at: m.at })),
    artifacts: artifactNames(task),
    ...(replay !== undefined ? { replay } : {}),
  };
}
