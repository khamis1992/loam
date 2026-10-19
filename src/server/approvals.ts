/**
 * Sensitive-action approvals (frontier section 18): host input-injection tools
 * (computer click/type/key...) require an explicit user decision BEFORE the
 * action runs. The tool blocks (cancellable with the run signal) until the
 * user approves or denies — in the companions UI approvals center or via API.
 */
import crypto from "node:crypto";

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
const approvals = new Map<string, ApprovalRecord>();

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
  // Bound memory: drop decided/expired records beyond the recent window.
  if (approvals.size > 100) {
    const cutoff = Date.now() - 60 * 60_000;
    for (const [id, rec] of approvals) {
      if (rec.status !== "pending" && Date.parse(rec.decidedAt ?? rec.createdAt) < cutoff) approvals.delete(id);
    }
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
