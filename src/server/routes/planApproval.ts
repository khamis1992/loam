/**
 * Plan-approval HTTP surface (D4). Mounted as a standalone route module next to
 * the other /api/ handlers. Routes:
 *   GET    /api/plan-approvals                 → { plans }       (?pending=0 → all)
 *   GET    /api/plan-approvals/:id             → { plan }
 *   POST   /api/plan-approvals/:id             → { plan }        (approve | reject | edit)
 *
 * `edit` carries the user's revised plan in the body (`summary`, `steps`,
 * `files_to_edit`, `trivial`); the pending state clears and the waiting agent is
 * resumed so it can re-present the revised plan with `suggest_plan`.
 */
import http from "node:http";
import {
  getPlanApproval,
  decidePlanApproval,
  listPlanApprovals,
  serializePlanApproval,
} from "../../tools/planApprovalStore.js";
import type { SuggestPlanArgs } from "../../tools/planApprovalGate.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 64_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

/** Plan-approval routes. Dispatch before generic handlers; scoped to /api/plan-approvals. */
export async function handlePlanApprovalRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (!p.startsWith("/api/plan-approvals")) return false;

  if (req.method === "GET" && p === "/api/plan-approvals") {
    const pendingOnly = new URL(req.url ?? p, "http://localhost").searchParams.get("pending") !== "0";
    sendJson(res, 200, { plans: listPlanApprovals(pendingOnly).map(serializePlanApproval) });
    return true;
  }

  const idMatch = p.match(/^\/api\/plan-approvals\/(.+)$/);
  if (!idMatch) return true;

  const id = decodeURIComponent(idMatch[1]!);

  if (req.method === "GET") {
    const plan = getPlanApproval(id);
    if (!plan) {
      sendJson(res, 404, { error: "الخطة غير موجودة" });
      return true;
    }
    sendJson(res, 200, { plan: serializePlanApproval(plan) });
    return true;
  }

  if (req.method === "POST") {
    const body = (await readJson(req)) as { decision?: unknown; plan?: Record<string, unknown> };
    if (body.decision !== "approve" && body.decision !== "reject" && body.decision !== "edit") {
      sendJson(res, 400, { error: "decision يجب أن يكون approve أو reject أو edit" });
      return true;
    }
    // Decide-then-check would always look decided, so confirm the plan is still
    // awaiting a decision before applying it (a double click is a 409).
    const existing = getPlanApproval(id);
    if (!existing) {
      sendJson(res, 404, { error: "الخطة غير موجودة" });
      return true;
    }
    if (existing.status !== "pending") {
      sendJson(res, 409, { error: "بُتّ في الخطة مسبقًا", plan: serializePlanApproval(existing) });
      return true;
    }
    const plan = body.decision === "edit" ? (body.plan ?? {}) : undefined;
    const editedPlan: Partial<SuggestPlanArgs> | undefined =
      plan === undefined
        ? undefined
        : {
            ...(typeof plan.summary === "string" ? { summary: plan.summary } : {}),
            ...(Array.isArray(plan.steps) ? { steps: plan.steps } : {}),
            ...(Array.isArray(plan.files_to_edit) ? { files_to_edit: plan.files_to_edit } : {}),
            ...(typeof plan.trivial === "boolean" ? { trivial: plan.trivial } : {}),
          };
    const record = decidePlanApproval(id, { decision: body.decision, ...(editedPlan ? { plan: editedPlan } : {}) })!;
    sendJson(res, 200, { plan: serializePlanApproval(record) });
    return true;
  }

  return true;
}
