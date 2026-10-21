import http from "node:http";
import { createApprovalRule, deleteApprovalRule, listApprovalRules, setTaskApprovalAuto, taskApprovalAuto, type ApprovalDecision, type ApprovalRule } from "../approvalRules.js";
import { getTask } from "../db.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 32_000): Promise<unknown> {
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
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Approval-rule routes (MF4 option 14):
 *  - GET    /api/approval-rules?agentId=      → rules for one agent (+ global) or all rules
 *  - POST   /api/approval-rules               → {agentId?, tool, pattern?, decision} create/update
 *  - DELETE /api/approval-rules/:id           → remove a rule
 *  - GET    /api/approval-tasks/:taskId       → { auto } per-task "Approve for me" state
 *  - PUT    /api/approval-tasks/:taskId       → { auto } set per-task auto-approve
 */
export async function handleApprovalRuleRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  url?: URL,
): Promise<boolean> {
  try {
    if (p === "/api/approval-rules") {
      if (req.method === "GET") {
        const agentId = url?.searchParams.get("agentId") ?? undefined;
        const rules = listApprovalRules(agentId && agentId.trim() ? agentId.trim() : undefined);
        sendJson(res, 200, { rules });
        return true;
      }
      if (req.method === "POST") {
        const body = (await readJson(req)) as { agentId?: unknown; tool?: unknown; pattern?: unknown; decision?: unknown };
        if (typeof body.tool !== "string" || !body.tool.trim()) {
          sendJson(res, 400, { error: "tool is required" });
          return true;
        }
        if (body.decision !== "allow" && body.decision !== "deny") {
          sendJson(res, 400, { error: "decision must be allow or deny" });
          return true;
        }
        try {
          const rule = createApprovalRule({
            agentId: typeof body.agentId === "string" && body.agentId.trim() ? body.agentId.trim() : null,
            tool: body.tool,
            pattern: typeof body.pattern === "string" ? body.pattern : null,
            decision: body.decision as ApprovalDecision,
          });
          sendJson(res, 200, { rule });
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return true;
      }
      return false;
    }

    if (p.startsWith("/api/approval-rules/")) {
      if (req.method === "DELETE") {
        const id = decodeURIComponent(p.slice("/api/approval-rules/".length));
        const deleted = deleteApprovalRule(id);
        if (!deleted) {
          sendJson(res, 404, { error: "rule not found" });
          return true;
        }
        sendJson(res, 200, { deleted });
        return true;
      }
      return false;
    }

    if (p.startsWith("/api/approval-tasks/")) {
      const taskId = decodeURIComponent(p.slice("/api/approval-tasks/".length));
      const task = getTask(taskId);
      if (!task) {
        sendJson(res, 404, { error: "task not found" });
        return true;
      }
      if (req.method === "GET") {
        sendJson(res, 200, { taskId, auto: taskApprovalAuto(taskId) });
        return true;
      }
      if (req.method === "PUT" || req.method === "POST") {
        const body = (await readJson(req)) as { auto?: unknown };
        if (typeof body.auto !== "boolean") {
          sendJson(res, 400, { error: "auto must be a boolean" });
          return true;
        }
        setTaskApprovalAuto(taskId, body.auto);
        sendJson(res, 200, { taskId, auto: body.auto });
        return true;
      }
      return false;
    }

    return false;
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}

export type { ApprovalRule };
