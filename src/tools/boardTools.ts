/**
 * MF10: always-on ticket board tools. Agents coordinate through the shared
 * board: create tickets, list them, claim unowned ones atomically, and keep
 * their status (todo → doing → review → done) plus comments up to date.
 */
import { getTask } from "../server/db.js";
import {
  TICKET_PRIORITIES,
  addTicketComment,
  claimTicket,
  createTicket,
  getTicket,
  listTickets,
  setTicketStatus,
} from "../server/board.js";
import type { TicketPriority, TicketStatus } from "../server/board.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";

const DEFAULT_ACTOR = "user";

function actorFromContext(ctx: ToolContext): string {
  if (!ctx.taskId) return DEFAULT_ACTOR;
  const task = getTask(ctx.taskId);
  return task?.agentId ?? DEFAULT_ACTOR;
}

function ticketLine(ticket: { id: string; title: string; status: string; priority: string; assigneeAgentId: string | null }): string {
  const assignee = ticket.assigneeAgentId ? ` (assigned to ${ticket.assigneeAgentId})` : " (unassigned)";
  return `[${ticket.id}] ${ticket.title} — status ${ticket.status}, priority ${ticket.priority}${assignee}`;
}

export function createBoardTools(): Tool[] {
  return [
    {
      name: "ticket_create",
      description:
        "Create a ticket on the shared multi-agent board. Use it to hand work between agents or track a work item across this run.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short ticket title" },
          body: { type: "string", description: "Details, acceptance criteria, context" },
          priority: { type: "string", enum: [...TICKET_PRIORITIES], description: "Optional priority (default normal)" },
        },
        required: ["title", "body"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const title = str(args, "title").trim();
        if (!title) return { ok: false, content: "ticket_create requires a non-empty title" };
        const actor = actorFromContext(ctx);
        const rawPriority = str(args, "priority").trim();
        const normalizedPriority = rawPriority === "medium" || rawPriority === "" ? "normal" : rawPriority;
        try {
          const ticket = createTicket({ title, body: str(args, "body"), priority: normalizedPriority as TicketPriority, createdBy: actor });
          return { ok: true, content: `created ticket ${ticket.id}: ${ticket.title} (status ${ticket.status}, priority ${ticket.priority})` };
        } catch (err) {
          return { ok: false, content: `ticket_create failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "ticket_list",
      description:
        "List tickets on the shared board. Filter by status (todo|doing|review|done); pass mine=true to see only the tickets assigned to this agent.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["todo", "doing", "review", "done"], description: "Optional status filter" },
          mine: { type: "boolean", description: "Only tickets assigned to this agent" },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const actor = actorFromContext(ctx);
        const statusArg = str(args, "status").trim() as TicketStatus | "";
        const status = ["todo", "doing", "review", "done"].includes(statusArg) ? (statusArg as TicketStatus) : undefined;
        let tickets = listTickets({ status });
        if (str(args, "mine").toLowerCase() === "true" || (args as { mine?: unknown }).mine === true) {
          tickets = tickets.filter((t) => t.assigneeAgentId === actor);
        }
        if (tickets.length === 0) return { ok: true, content: "(no matching tickets)" };
        return { ok: true, content: tickets.map(ticketLine).join("\n") };
      },
    },
    {
      name: "ticket_claim",
      description:
        "Claim an unassigned board ticket for this agent. The claim is atomic — the tool reports failure when another agent got there first, and done tickets cannot be claimed.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Ticket id from ticket_list" } },
        required: ["id"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const id = str(args, "id").trim();
        if (!id) return { ok: false, content: "ticket_claim requires id" };
        const actor = actorFromContext(ctx);
        try {
          const ticket = claimTicket(id, actor);
          if (!ticket) {
            return { ok: false, content: `ticket ${id} was not claimable: not found, already assigned, or done` };
          }
          return { ok: true, content: `claimed ticket ${ticket.id}: ${ticket.title}` };
        } catch (err) {
          return { ok: false, content: `ticket_claim failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "ticket_update",
      description:
        "Update one of your board tickets: move its status (todo|doing|review|done) and/or leave a progress comment for the team.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Ticket id from ticket_list" },
          status: { type: "string", enum: ["todo", "doing", "review", "done"], description: "New status" },
          comment: { type: "string", description: "Comment text appended to the ticket thread" },
        },
        required: ["id"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const id = str(args, "id").trim();
        if (!id) return { ok: false, content: "ticket_update requires id" };
        const actor = actorFromContext(ctx);
        const ticket = getTicket(id);
        if (!ticket) return { ok: false, content: `ticket ${id} not found` };
        const statusArg = str(args, "status").trim() as TicketStatus | "";
        const commentText = str(args, "comment").trim();
        try {
          if (["todo", "doing", "review", "done"].includes(statusArg)) {
            const updated = setTicketStatus(id, statusArg as TicketStatus);
            if (!updated) return { ok: false, content: `ticket ${id} not found` };
          }
          if (commentText) {
            const comment = addTicketComment(id, actor, commentText);
            if (!comment) return { ok: false, content: `ticket ${id} not found` };
          }
          if (!statusArg && !commentText) {
            return { ok: false, content: "ticket_update needs status and/or comment" };
          }
          const final = getTicket(id)!;
          return { ok: true, content: `updated ticket ${final.id}: status ${final.status}, priority ${final.priority}${commentText ? " (comment added)" : ""}` };
        } catch (err) {
          return { ok: false, content: `ticket_update failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
  ];
}
