/**
 * MF10: Shared ticket board for multi-agent work (server domain layer).
 *
 * Default-productboard (single board created idempotently) with tickets in the
 * fixed statuses todo|doing|review|done and optional agent assignment.
 * Claiming is atomic: the assignment UPDATE only matches tickets whose
 * assignee is still NULL, inside one transaction, so concurrent agents cannot
 * double-claim the same ticket.
 */
import crypto from "node:crypto";
import { database, transaction } from "./sqliteStore.js";

export type TicketStatus = "todo" | "doing" | "review" | "done";
export const TICKET_STATUSES: readonly TicketStatus[] = ["todo", "doing", "review", "done"];

export type TicketPriority = "low" | "normal" | "high" | "urgent";
export const TICKET_PRIORITIES: readonly TicketPriority[] = ["low", "normal", "high", "urgent"];

export interface Board {
  id: string;
  name: string;
}

export interface Ticket {
  id: string;
  boardId: string;
  title: string;
  body: string;
  status: TicketStatus;
  assigneeAgentId: string | null;
  /** "user" or the creating agent's id. */
  createdBy: string;
  priority: TicketPriority;
  createdAt: string;
  updatedAt: string;
}

export interface TicketComment {
  id: string;
  ticketId: string;
  /** "user" or the commenting agent id (create path uses "user"/agentId). */
  author: string;
  text: string;
  createdAt: string;
}

export const DEFAULT_BOARD_NAME = "main";

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function ensureTables(): void {
  const db = database();
  db.exec(`CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('todo','doing','review','done')),
    assignee_agent_id TEXT,
    created_by TEXT NOT NULL,
    priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tickets_board_status ON tickets(board_id, status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee_agent_id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS ticket_comments (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id),
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket ON ticket_comments(ticket_id, created_at);`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_boards_name ON boards(name);`);
}

ensureTables();

/** Single shared board for now; created on first use, idempotently. */
export function ensureDefaultBoard(name = DEFAULT_BOARD_NAME): Board {
  const db = database();
  const existing = db.prepare("SELECT id, name FROM boards WHERE name = ?").get(name) as
    | Record<string, unknown>
    | undefined;
  if (existing) return boardFromRow(existing);
  const board: Board = { id: newId("board"), name };
  db.prepare("INSERT OR IGNORE INTO boards (id, name) VALUES (?, ?)").run(board.id, name);
  const row = db.prepare("SELECT id, name FROM boards WHERE name = ?").get(name) as Record<string, unknown>;
  return boardFromRow(row);
}

export function listBoards(): Board[] {
  return (database().prepare("SELECT id, name FROM boards ORDER BY id").all() as Record<string, unknown>[]).map(
    boardFromRow,
  );
}

function boardFromRow(row: Record<string, unknown>): Board {
  return { id: String(row.id), name: String(row.name) };
}

function ticketFromRow(row: Record<string, unknown>): Ticket {
  return {
    id: String(row.id),
    boardId: String(row.board_id),
    title: String(row.title),
    body: String(row.body ?? ""),
    status: String(row.status) as TicketStatus,
    assigneeAgentId: row.assignee_agent_id ? String(row.assignee_agent_id) : null,
    createdBy: String(row.created_by),
    priority: String(row.priority) as TicketPriority,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createTicket(
  input: { title: string; body?: string; priority?: TicketPriority; createdBy?: string; boardId?: string },
): Ticket {
  const title = input.title.trim();
  if (!title) throw new Error("ticket title is required");
  const priority = input.priority ?? "normal";
  if (!TICKET_PRIORITIES.includes(priority)) throw new Error(`invalid priority: ${priority}`);
  const board = ensureDefaultBoard();
  const now = new Date().toISOString();
  const ticket: Ticket = {
    id: newId("ticket"),
    boardId: input.boardId ?? board.id,
    title: title.slice(0, 200),
    body: (input.body ?? "").trim().slice(0, 8000),
    status: "todo",
    assigneeAgentId: null,
    createdBy: input.createdBy?.trim() && input.createdBy.trim() !== "" ? input.createdBy.trim().slice(0, 64) : "user",
    priority,
    createdAt: now,
    updatedAt: now,
  };
  database()
    .prepare(
      "INSERT INTO tickets (id, board_id, title, body, status, assignee_agent_id, created_by, priority, created_at, updated_at) VALUES (?, ?, ?, ?, 'todo', NULL, ?, ?, ?, ?)",
    )
    .run(ticket.id, ticket.boardId, ticket.title, ticket.body, ticket.createdBy, ticket.priority, ticket.createdAt, ticket.updatedAt);
  return ticket;
}

const TICKET_COLUMNS =
  "id, board_id, title, body, status, assignee_agent_id, created_by, priority, created_at, updated_at";

export function getTicket(id: string): Ticket | undefined {
  const row = database()
    .prepare(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? ticketFromRow(row) : undefined;
}

export function listTickets(opts: { boardId?: string; status?: TicketStatus } = {}): Ticket[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  clauses.push("board_id = ?");
  params.push(opts.boardId ?? ensureDefaultBoard().id);
  if (opts.status) {
    clauses.push("status = ?");
    params.push(opts.status);
  }
  const rows = database()
    .prepare(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC`)
    .all(...params) as Record<string, unknown>[];
  return rows.map(ticketFromRow);
}

/**
 * Atomic claim: assign the ticket to `agentId` only when it is currently
 * unassigned AND still in the same status (task-like flows stop working once
 * done). Returns the updated ticket when the claim won, else undefined.
 */
export function claimTicket(id: string, agentId: string): Ticket | undefined {
  const claimant = agentId.trim();
  if (!claimant) throw new Error("claimant agent id is required");
  return transaction(() => {
    const db = database();
    db.prepare("UPDATE tickets SET assignee_agent_id = ?, updated_at = ? WHERE id = ? AND assignee_agent_id IS NULL AND status <> 'done'")
      .run(claimant, new Date().toISOString(), id);
    const row = db.prepare(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    const ticket = ticketFromRow(row);
    return ticket.assigneeAgentId === claimant ? ticket : undefined;
  });
}

/** Explicit assignment endpoint (same atomic guard as claim). */
export const assignTicket = claimTicket;

export function releaseTicket(id: string): Ticket | undefined {
  return transaction(() => {
    const db = database();
    db.prepare("UPDATE tickets SET assignee_agent_id = NULL, updated_at = ? WHERE id = ? AND assignee_agent_id IS NOT NULL").run(
      new Date().toISOString(),
      id,
    );
    const row = db.prepare(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? ticketFromRow(row) : undefined;
  });
}

export function setTicketStatus(id: string, status: TicketStatus): Ticket | undefined {
  if (!TICKET_STATUSES.includes(status)) throw new Error(`invalid ticket status: ${status}`);
  return transaction(() => {
    const db = database();
    const existing = db.prepare(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) return undefined;
    if (String(existing.status) === status) return ticketFromRow(existing);
    db.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
    const row = db.prepare(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = ?`).get(id) as Record<string, unknown>;
    return ticketFromRow(row);
  });
}

export function setTicketPriority(id: string, priority: TicketPriority): Ticket | undefined {
  if (!TICKET_PRIORITIES.includes(priority)) throw new Error(`invalid ticket priority: ${priority}`);
  return transaction(() => {
    const db = database();
    const result = db
      .prepare("UPDATE tickets SET priority = ?, updated_at = ? WHERE id = ?")
      .run(priority, new Date().toISOString(), id);
    if (Number(result.changes) === 0) return undefined;
    const row = db.prepare(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = ?`).get(id) as Record<string, unknown>;
    return ticketFromRow(row);
  });
}

export function addTicketComment(ticketId: string, author: string, text: string): TicketComment | undefined {
  const clean = text.trim();
  if (!clean) throw new Error("comment text is required");
  return transaction(() => {
    const db = database();
    const exists = db.prepare("SELECT id FROM tickets WHERE id = ?").get(ticketId);
    if (!exists) return undefined;
    const comment: TicketComment = {
      id: newId("tcom"),
      ticketId,
      author: author.trim() && author.trim() !== "" ? author.trim().slice(0, 64) : "user",
      text: clean.slice(0, 4000),
      createdAt: new Date().toISOString(),
    };
    db.prepare("INSERT INTO ticket_comments (id, ticket_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)").run(
      comment.id,
      comment.ticketId,
      comment.author,
      comment.text,
      comment.createdAt,
    );
    db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(comment.createdAt, ticketId);
    return comment;
  });
}

export function listTicketComments(ticketId: string): TicketComment[] {
  const rows = database()
    .prepare("SELECT id, ticket_id, author, text, created_at FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at ASC")
    .all(ticketId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    ticketId: String(row.ticket_id),
    author: String(row.author),
    text: String(row.text),
    createdAt: String(row.created_at),
  }));
}

export function deleteTicket(id: string): boolean {
  return transaction(() => {
    const db = database();
    db.prepare("DELETE FROM ticket_comments WHERE ticket_id = ?").run(id);
    return Number(db.prepare("DELETE FROM tickets WHERE id = ?").run(id).changes) > 0;
  });
}
