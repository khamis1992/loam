/**
 * Sensitive-action approvals (frontier section 18): host input-injection tools
 * (computer click/type/key...) require an explicit user decision BEFORE the
 * action runs. The tool blocks (cancellable with the run signal) until the
 * user approves or denies — in the companions UI approvals center or via API.
 */
import crypto from "node:crypto";
import { notifyApprovalPending } from "./notifications.js";
import { BoundedMap } from "../memory/cache.js";
import { registerCacheStats } from "../memory/stats.js";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRecord {
  id: string;
  taskId: string;
  tool: string;
  summary: string;
  argsPreview: string;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: "user";
}

const TTL_MS = 15 * 60_000;
/**
 * Approval records (J6). Previously an unbounded `Map`: a long-lived server
 * accumulated every decided record forever. Bounded LRU — the oldest record is
 * dropped first, and decided/expired records past the one-hour window are
 * pruned on each create so the live window stays well under the cap.
 */
const approvals = new BoundedMap<string, ApprovalRecord>(256, "server-approvals");
registerCacheStats("server-approvals", () => approvals.stats());

export function createApproval(input: { taskId: string; tool: string; summary: string; argsPreview: string }): ApprovalRecord {
  const record: ApprovalRecord = {
    id: `appr_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`,
    taskId: input.taskId,
    tool: input.tool,
    summary: input.summary,
    argsPreview: input.argsPreview.slice(0, 300),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  approvals.set(record.id, record);
  // Notification feed hook (option #20): a pending sensitive action is one
  // unread notification; deciding it does not auto-clear the feed entry.
  notifyApprovalPending({ id: record.id, taskId: record.taskId, tool: record.tool, summary: record.summary });
  // Bound memory: drop decided/expired records beyond the recent window.
  const cutoff = Date.now() - 60 * 60_000;
  for (const [id, rec] of approvals.entries()) {
    if (rec.status !== "pending" && Date.parse(rec.decidedAt ?? rec.createdAt) < cutoff) approvals.delete(id);
  }
  return record;
}

export function decideApproval(id: string, decision: "approve" | "deny"): ApprovalRecord | undefined {
  const rec = approvals.get(id);
  if (!rec || rec.status !== "pending") return rec;
  rec.status = decision === "approve" ? "approved" : "denied";
  rec.decidedAt = new Date().toISOString();
  rec.decidedBy = "user";
  return rec;
}

export function getApproval(id: string): ApprovalRecord | undefined {
  return approvals.get(id);
}

export function listApprovals(pendingOnly = true): ApprovalRecord[] {
  const now = Date.now();
  const rows = [...approvals.values()].filter((r) => {
    if (r.status === "pending" && Date.parse(r.createdAt) + TTL_MS < now) r.status = "expired";
    return pendingOnly ? r.status === "pending" : true;
  });
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Wait until decided, expired, or the run is cancelled. Polling keeps it simple
 *  and honest (no hidden channels). */
export async function waitForDecision(id: string, signal: AbortSignal | undefined, timeoutMs = TTL_MS): Promise<ApprovalStatus> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (signal?.aborted) return "denied";
    const rec = approvals.get(id);
    if (!rec) return "denied";
    if (rec.status !== "pending") return rec.status;
    if (Date.parse(rec.createdAt) + TTL_MS < Date.now()) {
      rec.status = "expired";
      return "expired";
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return "expired";
}
