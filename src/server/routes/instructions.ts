import http from "node:http";
import { getAgent } from "../agents.js";
import {
  approveProposal,
  listProposals,
  listVersions,
  proposeInstructions,
  recordUserEdit,
  rejectProposal,
} from "../instructionHistory.js";

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

/** Agent instruction-version routes. Dispatched before generic /api/agents/:id handlers. */
export async function handleInstructionsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (!p.startsWith("/api/agents/")) return false;
  const versionMatch = /^\/api\/agents\/([^\/]+)\/instructions\/versions$/.exec(p);
  const proposalMatch = /^\/api\/agents\/([^\/]+)\/instructions\/proposals(?:\/([^\/]+)(?:\/(approve|reject))?)?$/.exec(p);
  if (!versionMatch && !proposalMatch) return false;
  const agentId = decodeURIComponent(versionMatch ? versionMatch[1]! : proposalMatch![1]!);

  if (!getAgent(agentId)) {
    sendJson(res, 404, { error: "agent not found" });
    return true;
  }

  if (req.method === "GET" && versionMatch) {
    sendJson(res, 200, { versions: listVersions(agentId) });
    return true;
  }

  if (req.method === "POST" && versionMatch) {
    const body = (await readJson(req)) as { old?: unknown; new?: unknown };
    const oldText = typeof body.old === "string" ? body.old : "";
    const newText = typeof body.new === "string" ? body.new : "";
    if (!newText.trim()) {
      sendJson(res, 400, { error: "new is required" });
      return true;
    }
    const version = recordUserEdit(agentId, oldText, newText);
    sendJson(res, 200, { version });
    return true;
  }

  if (req.method === "GET" && proposalMatch && !proposalMatch[2]) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const status = url.searchParams.get("status");
    if (status && status !== "proposed") {
      sendJson(res, 400, { error: "unsupported status filter; only 'proposed' is available" });
      return true;
    }
    sendJson(res, 200, { proposals: listProposals(agentId, "proposed") });
    return true;
  }

  if (req.method === "POST" && proposalMatch && proposalMatch[2] && proposalMatch[3]) {
    const proposalId = decodeURIComponent(proposalMatch[2]!);
    const action = proposalMatch[3];
    const updated = action === "approve" ? approveProposal(proposalId) : rejectProposal(proposalId);
    if (!updated) {
      sendJson(res, 404, { error: `proposal not found or already decided` });
      return true;
    }
    sendJson(res, 200, { proposal: updated });
    return true;
  }

  if (req.method === "POST" && proposalMatch && !proposalMatch[2]) {
    const body = (await readJson(req)) as { instructions?: unknown; reason?: unknown };
    const instructions = typeof body.instructions === "string" ? body.instructions : "";
    if (!instructions.trim()) {
      sendJson(res, 400, { error: "instructions is required" });
      return true;
    }
    const reason = typeof body.reason === "string" ? body.reason : "";
    const proposal = proposeInstructions(agentId, instructions, reason);
    sendJson(res, 200, { proposal });
    return true;
  }

  sendJson(res, 405, { error: "method not allowed" });
  return true;
}
