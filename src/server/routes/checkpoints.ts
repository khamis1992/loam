import http from "node:http";
import { listCheckpoints, forksOf, planFork } from "../../orchestration/durable/checkpoints.js";
import { after } from "../../protocol/eventLog.js";
import type { ExecutionCheckpoint } from "../../agent/checkpoint.js";
import type { PlanStepInfo } from "../../agent/events.js";

export type StartForkedRun = (forkTaskId: string, sourceTaskId: string, checkpoint: ExecutionCheckpoint) => Promise<void>;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, max = 64_000): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error("body_too_large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/** C2 §4.2.3: GET /api/runs/:taskId/checkpoints and POST /api/runs/:taskId/fork. */
export async function handleCheckpointRoutes(req: http.IncomingMessage, res: http.ServerResponse, p: string, startForkedRun: StartForkedRun): Promise<boolean> {
  const m = /^\/api\/runs\/([^/]+)\/(checkpoints|fork)$/.exec(p);
  if (!m) return false;
  const taskId = decodeURIComponent(m[1] ?? "");
  if (m[2] === "checkpoints" && req.method === "GET") {
    sendJson(res, 200, { checkpoints: listCheckpoints(taskId), forks: forksOf(taskId) });
    return true;
  }
  if (m[2] === "fork" && req.method === "POST") {
    let body: { checkpointId?: unknown; note?: unknown; planEdit?: { steps?: unknown } };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: "invalid body" });
      return true;
    }
    if (typeof body.checkpointId !== "string") {
      sendJson(res, 400, { error: "checkpointId required" });
      return true;
    }
    const steps = Array.isArray(body.planEdit?.steps) ? body.planEdit.steps.filter((s): s is string => typeof s === "string").slice(0, 30) : undefined;
    try {
      const plan = planFork<ExecutionCheckpoint>(body.checkpointId, (s, seq) => after(s, seq - 1, 1)[0]?.payload, {
        note: typeof body.note === "string" ? body.note : undefined,
        // Completed steps stay; the remaining steps are replaced by the edited list.
        edit: steps
          ? (cp) => ({
              ...cp,
              plan: {
                ...cp.plan,
                steps: [
                  ...cp.plan.steps.slice(0, cp.nextStep),
                  ...steps.map((text, i): PlanStepInfo => ({
                    id: `fork-${cp.nextStep + i + 1}`,
                    title: text.slice(0, 80),
                    instruction: text,
                    successCriteria: "The instruction of this step is done and its result is reported.",
                  })),
                ],
              },
            })
          : undefined,
      });
      if (plan.from.taskId !== taskId) {
        sendJson(res, 400, { error: "checkpoint belongs to another task" });
        return true;
      }
      await startForkedRun(plan.forkTaskId, taskId, plan.checkpoint);
      sendJson(res, 200, { forkTaskId: plan.forkTaskId });
    } catch (err) {
      sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
  sendJson(res, 405, { error: "method not allowed" });
  return true;
}
