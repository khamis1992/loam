/**
 * MF10: shared ticket board HTTP routes (new module, mounted by the supervisor
 * next to the other /api/agents route handlers — see handoff report for the
 * exact 2 lines to add to src/server/http.ts).
 */
import http from "node:http";
import { getAgent } from "../agents.js";
import { createTask } from "../db.js";
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  addTicketComment,
  assignTicket,
  createTicket,
  getTicket,
  listTicketComments,
  listTickets,
  releaseTicket,
  setTicketPriority,
  setTicketStatus,
  type TicketPriority,
  type TicketStatus,
} from "../board.js";

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

const TICKET_MATCH = /^\/api\/board\/tickets(?:\/([^\/]+)(?:\/(comments|assign|release))?)?$/;

export async function handleBoardRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (!p.startsWith("/api/board/")) return false;

  const match = TICKET_MATCH.exec(p);
  if (!match) {
    sendJson(res, 404, { error: "board route not found" });
    return true;
  }
  const ticketId = match[1] ? decodeURIComponent(match[1]) : undefined;
  const action = match[2];

  // GET /api/board/tickets → every ticket on the shared board
  if (req.method === "GET" && !ticketId) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const statusParam = url.searchParams.get("status");
    const status = TICKET_STATUSES.includes(statusParam as TicketStatus) ? (statusParam as TicketStatus) : undefined;
    sendJson(res, 200, { tickets: listTickets({ status }) });
    return true;
  }

  // POST /api/board/tickets → create a ticket
  if (req.method === "POST" && !ticketId) {
    const body = (await readJson(req)) as { title?: unknown; body?: unknown; priority?: unknown; createdBy?: unknown };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      sendJson(res, 400, { error: "title is required" });
      return true;
    }
    const priority = TICKET_PRIORITIES.includes(body.priority as TicketPriority) ? (body.priority as TicketPriority) : undefined;
    try {
      const ticket = createTicket({
        title,
        body: typeof body.body === "string" ? body.body : "",
        priority,
        createdBy: typeof body.createdBy === "string" && body.createdBy.trim() ? body.createdBy.trim() : "user",
      });
      sendJson(res, 200, { ticket });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (!ticketId) return false;

  const ticket = getTicket(ticketId);
  if (!ticket) {
    sendJson(res, 404, { error: "ticket not found" });
    return true;
  }

  // GET /api/board/tickets/:id → ticket plus comment thread (drawer payload)
  if (req.method === "GET" && !action) {
    sendJson(res, 200, { ticket, comments: listTicketComments(ticketId) });
    return true;
  }

  // PATCH /api/board/tickets/:id → status / priority / assign updates
  if (req.method === "PATCH" && !action) {
    const body = (await readJson(req)) as { status?: unknown; priority?: unknown };
    try {
      let updated = ticket;
      if (body.status !== undefined) {
        if (!TICKET_STATUSES.includes(body.status as TicketStatus)) {
          sendJson(res, 400, { error: `invalid status: ${String(body.status)}` });
          return true;
        }
        updated = setTicketStatus(ticketId, body.status as TicketStatus)!;
      }
      if (body.priority !== undefined) {
        if (!TICKET_PRIORITIES.includes(body.priority as TicketPriority)) {
          sendJson(res, 400, { error: `invalid priority: ${String(body.priority)}` });
          return true;
        }
        updated = setTicketPriority(ticketId, body.priority as TicketPriority)!;
      }
      sendJson(res, 200, { ticket: updated });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // POST /api/board/tickets/:id/comments → append a comment
  if (req.method === "POST" && action === "comments") {
    const body = (await readJson(req)) as { author?: unknown; text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      sendJson(res, 400, { error: "text is required" });
      return true;
    }
    const author = typeof body.author === "string" && body.author.trim() ? body.author.trim() : "user";
    try {
      const comment = addTicketComment(ticketId, author, text);
      if (!comment) {
        sendJson(res, 404, { error: "ticket not found" });
        return true;
      }
      sendJson(res, 200, { comment });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // POST /api/board/tickets/:id/assign {agentId} → atomic claim; when it wins,
  // a queued task is created for that agent via the existing db.createTask path
  // with the ticket as prompt.
  if (req.method === "POST" && action === "assign") {
    const body = (await readJson(req)) as { agentId?: unknown };
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    if (!agentId) {
      sendJson(res, 400, { error: "agentId is required" });
      return true;
    }
    const agent = getAgent(agentId);
    if (!agent) {
      sendJson(res, 404, { error: "agent not found" });
      return true;
    }
    if (ticket.status === "done") {
      sendJson(res, 409, { error: "ticket is done and cannot be assigned" });
      return true;
    }
    let claimed;
    try {
      claimed = assignTicket(ticketId, agentId);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    if (!claimed) {
      sendJson(res, 409, { error: "ticket already claimed or done" });
      return true;
    }
    // Existing task creation path: a queued task owned by the agent.
    const prompt = `Shared board ticket ${ticket.id}: ${ticket.title}\n\n${ticket.body || "(no details)"}`.trim();
    const task = createTask(prompt, `Board: ${ticket.title}`.slice(0, 80), null, agentId);
    sendJson(res, 200, { ticket: claimed, taskId: task.id });
    return true;
  }

  // POST /api/board/tickets/:id/release → drop the assignment (kanban drag-out)
  if (req.method === "POST" && action === "release") {
    const released = releaseTicket(ticketId);
    if (!released) {
      sendJson(res, 409, { error: "ticket is not assigned" });
      return true;
    }
    sendJson(res, 200, { ticket: released });
    return true;
  }

  sendJson(res, 405, { error: "method not allowed" });
  return true;
}
