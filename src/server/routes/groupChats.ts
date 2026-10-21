import http from "node:http";
import { getAgent } from "../agents.js";
import type { RunTaskOptions } from "../http.js";
import {
  addGroupMember,
  collectGroupReplies,
  createGroup,
  createGroupRunStarter,
  getGroup,
  groupWithMembers,
  listGroupMessages,
  listGroups,
  postToGroup,
  removeGroupMember,
} from "../groupChats.js";

type RunTask = (opts: RunTaskOptions) => Promise<{ taskId: string; text: string }>;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 64_000): Promise<unknown> {
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

function runTaskFrom(ctx?: Record<string, unknown>): RunTask | undefined {
  const candidate = ctx?.runTask;
  return typeof candidate === "function" ? (candidate as RunTask) : undefined;
}

/**
 * Group chat routes (MF9).
 *
 *   GET    /api/groups
 *   POST   /api/groups                       { name, memberIds? }
 *   GET    /api/groups/:id                   -> { group, messages }
 *   POST   /api/groups/:id/members           { agentId }
 *   DELETE /api/groups/:id/members/:agentId
 *   GET    /api/groups/:id/messages
 *   POST   /api/groups/:id/messages          { text, author? }
 *
 * Dispatch before the generic /api/agents handlers.
 */
export async function handleGroupChatsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (p !== "/api/groups" && !p.startsWith("/api/groups/")) return false;
  const runTask = runTaskFrom(ctx);
  const startRun = runTask ? createGroupRunStarter(runTask) : undefined;

  if (p === "/api/groups") {
    if (req.method === "GET") {
      if (runTask) await collectGroupReplies(startRun).catch(() => 0);
      sendJson(res, 200, { groups: listGroups().map(groupWithMembers) });
      return true;
    }
    if (req.method === "POST") {
      const body = (await readJson(req)) as { name?: unknown; memberIds?: unknown; members?: unknown };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        sendJson(res, 400, { error: "name is required" });
        return true;
      }
      const raw = Array.isArray(body.memberIds) ? body.memberIds : Array.isArray(body.members) ? body.members : [];
      const memberIds = raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
      const unknown = memberIds.find((id) => !getAgent(id));
      if (unknown) {
        sendJson(res, 400, { error: `agent not found: ${unknown}` });
        return true;
      }
      try {
        const group = createGroup(name, memberIds);
        sendJson(res, 200, { group: groupWithMembers(group) });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  const memberMatch = /^\/api\/groups\/([^/]+)\/members(?:\/([^/]+))?$/.exec(p);
  if (memberMatch) {
    const groupId = decodeURIComponent(memberMatch[1]!);
    const bodyAgentId = memberMatch[2] ? decodeURIComponent(memberMatch[2]) : null;
    if (!getGroup(groupId)) {
      sendJson(res, 404, { error: "group not found" });
      return true;
    }
    if (req.method === "POST" && !bodyAgentId) {
      const body = (await readJson(req)) as { agentId?: unknown };
      const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
      if (!agentId || !getAgent(agentId)) {
        sendJson(res, 400, { error: "valid agentId is required" });
        return true;
      }
      const group = addGroupMember(groupId, agentId);
      sendJson(res, 200, { group: group ? groupWithMembers(group) : null });
      return true;
    }
    if (req.method === "DELETE" && bodyAgentId) {
      const group = removeGroupMember(groupId, bodyAgentId);
      sendJson(res, 200, { group: group ? groupWithMembers(group) : null });
      return true;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  const messagesMatch = /^\/api\/groups\/([^/]+)\/messages$/.exec(p);
  if (messagesMatch) {
    const groupId = decodeURIComponent(messagesMatch[1]!);
    const group = getGroup(groupId);
    if (!group) {
      sendJson(res, 404, { error: "group not found" });
      return true;
    }
    if (req.method === "GET") {
      if (runTask) await collectGroupReplies(startRun).catch(() => 0);
      sendJson(res, 200, { group: groupWithMembers(group), messages: listGroupMessages(groupId) });
      return true;
    }
    if (req.method === "POST") {
      const body = (await readJson(req)) as { text?: unknown; author?: unknown };
      const text = typeof body.text === "string" ? body.text : "";
      if (!text.trim()) {
        sendJson(res, 400, { error: "text is required" });
        return true;
      }
      const author = typeof body.author === "string" && body.author.trim() ? body.author.trim() : "user";
      if (author !== "user" && !group.memberIds.includes(author)) {
        sendJson(res, 400, { error: "author must be the user or a group member" });
        return true;
      }
      try {
        const result = await postToGroup(groupId, text, author, startRun);
        sendJson(res, 200, {
          message: result.message,
          targetAgentId: result.targetAgentId,
          taskId: result.taskId,
          messages: listGroupMessages(groupId),
        });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  const groupMatch = /^\/api\/groups\/([^/]+)$/.exec(p);
  if (groupMatch) {
    const groupId = decodeURIComponent(groupMatch[1]!);
    const group = getGroup(groupId);
    if (!group) {
      sendJson(res, 404, { error: "group not found" });
      return true;
    }
    if (req.method === "GET") {
      if (runTask) await collectGroupReplies(startRun).catch(() => 0);
      sendJson(res, 200, { group: groupWithMembers(group), messages: listGroupMessages(groupId) });
      return true;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  sendJson(res, 404, { error: "not found" });
  return true;
}
