/**
 * Group chats between agents (MF9).
 *
 * A group is a named set of companion agents. The user posts into the group;
 * the message is routed to an addressed agent (an `@name` mention) or to the
 * first member. That agent runs as a normal Loam task, and its reply flows back
 * into the group transcript. While replying, an agent can call the always-on
 * `handoff_to_agent` tool to pass the conversation to another member; once the
 * current task finishes, the handoff target receives a new task with the group
 * transcript as context.
 *
 * Persistence uses dedicated SQLite tables created idempotently here (the rest
 * of the app stores entities in the shared `entities` table, but a group has
 * relational membership rows that are clearer as real tables).
 */
import crypto from "node:crypto";
import { database, transaction } from "./sqliteStore.js";
import { createTask, getTask } from "./db.js";
import { getAgent } from "./agents.js";
import { log } from "../log.js";

export interface GroupChat {
  id: string;
  name: string;
  createdAt: string;
  memberIds: string[];
}

export interface GroupMemberInfo {
  id: string;
  name: string;
  emoji: string;
}

export interface GroupMessage {
  id: string;
  groupId: string;
  /** "user" for the human, otherwise the authoring agent id. */
  author: string;
  text: string;
  createdAt: string;
  handoffTo: string | null;
  handoffNote: string | null;
}

export interface GroupRunInput {
  groupId: string;
  agentId: string;
  prompt: string;
  title?: string;
}

export type GroupRunStarter = (input: GroupRunInput) => { taskId: string } | Promise<{ taskId: string }>;

export interface PostToGroupResult {
  message: GroupMessage;
  targetAgentId: string | null;
  taskId: string | null;
}

export interface GroupMemberResolution {
  ok: boolean;
  reason?: string;
  group?: GroupChat;
  agent?: GroupMemberInfo;
}

let ready = false;

function ensureTables(): void {
  if (ready) return;
  database().exec(`
    CREATE TABLE IF NOT EXISTS group_chats (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      PRIMARY KEY (group_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS group_messages (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      handoff_to TEXT,
      handoff_note TEXT
    );
    CREATE TABLE IF NOT EXISTS group_tasks (
      task_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      handoff_to TEXT,
      handoff_note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_group_tasks_group ON group_tasks(group_id);
  `);
  ready = true;
}

function newGroupId(): string {
  return `grp_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
}

function newMessageId(): string {
  return `gmsg_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
}

function memberIds(groupId: string): string[] {
  const rows = database().prepare("SELECT agent_id FROM group_members WHERE group_id=? ORDER BY rowid").all(groupId);
  return rows.map((r) => String(r.agent_id));
}

function toGroup(row: Record<string, unknown>): GroupChat {
  const id = String(row.id);
  return {
    id,
    name: String(row.name),
    createdAt: String(row.created_at),
    memberIds: memberIds(id),
  };
}

export function memberInfo(agentId: string): GroupMemberInfo {
  const agent = getAgent(agentId);
  return {
    id: agentId,
    name: agent?.name ?? agentId,
    emoji: agent?.emoji ?? "👥",
  };
}

export function groupWithMembers(group: GroupChat): GroupChat & { members: GroupMemberInfo[] } {
  return { ...group, members: group.memberIds.map(memberInfo) };
}

export function createGroup(name: string, members: string[] = []): GroupChat {
  ensureTables();
  const cleanName = name.trim().slice(0, 120);
  if (!cleanName) throw new Error("group name is required");
  const id = newGroupId();
  const createdAt = new Date().toISOString();
  const unique = [...new Set(members.map((m) => m.trim()).filter(Boolean))];
  transaction(() => {
    database().prepare("INSERT INTO group_chats(id,name,created_at) VALUES(?,?,?)").run(id, cleanName, createdAt);
    const insert = database().prepare("INSERT OR IGNORE INTO group_members(group_id,agent_id) VALUES(?,?)");
    for (const agentId of unique) insert.run(id, agentId);
  });
  return getGroup(id)!;
}

export function listGroups(): GroupChat[] {
  ensureTables();
  return database().prepare("SELECT * FROM group_chats ORDER BY rowid DESC").all().map((r) => toGroup(r as Record<string, unknown>));
}

export function getGroup(id: string): GroupChat | undefined {
  ensureTables();
  const row = database().prepare("SELECT * FROM group_chats WHERE id=?").get(id);
  return row ? toGroup(row as Record<string, unknown>) : undefined;
}

export function addGroupMember(groupId: string, agentId: string): GroupChat | undefined {
  ensureTables();
  if (!getGroup(groupId)) return undefined;
  database().prepare("INSERT OR IGNORE INTO group_members(group_id,agent_id) VALUES(?,?)").run(groupId, agentId);
  return getGroup(groupId);
}

export function removeGroupMember(groupId: string, agentId: string): GroupChat | undefined {
  ensureTables();
  if (!getGroup(groupId)) return undefined;
  database().prepare("DELETE FROM group_members WHERE group_id=? AND agent_id=?").run(groupId, agentId);
  return getGroup(groupId);
}

function toMessage(row: Record<string, unknown>): GroupMessage {
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    author: String(row.author),
    text: String(row.text),
    createdAt: String(row.created_at),
    handoffTo: row.handoff_to == null ? null : String(row.handoff_to),
    handoffNote: row.handoff_note == null ? null : String(row.handoff_note),
  };
}

export function listGroupMessages(groupId: string, limit = 500): GroupMessage[] {
  ensureTables();
  return database()
    .prepare("SELECT * FROM group_messages WHERE group_id=? ORDER BY rowid ASC LIMIT ?")
    .all(groupId, limit)
    .map((r) => toMessage(r as Record<string, unknown>));
}

export function appendGroupMessage(
  groupId: string,
  author: string,
  text: string,
  handoffTo?: string | null,
  handoffNote?: string | null,
): GroupMessage {
  ensureTables();
  const message: GroupMessage = {
    id: newMessageId(),
    groupId,
    author,
    text: text.slice(0, 40_000),
    createdAt: new Date().toISOString(),
    handoffTo: handoffTo ?? null,
    handoffNote: handoffNote ?? null,
  };
  database()
    .prepare("INSERT INTO group_messages(id,group_id,author,text,created_at,handoff_to,handoff_note) VALUES(?,?,?,?,?,?,?)")
    .run(message.id, message.groupId, message.author, message.text, message.createdAt, message.handoffTo, message.handoffNote);
  return message;
}

/**
 * Resolve the addressed agent. Explicit `@name` / `@agentId` mentions win
 * (longest alias first, so "Alice Smith" beats "Alice"); otherwise the first
 * member receives the message.
 */
export function resolveGroupTarget(groupId: string, text: string): GroupMemberInfo | null {
  const members = memberIds(groupId);
  if (members.length === 0) return null;
  const lower = text.toLowerCase();
  let best: { info: GroupMemberInfo; length: number } | null = null;
  for (const id of members) {
    const info = memberInfo(id);
    const aliases = [id.toLowerCase(), info.name.toLowerCase(), info.name.toLowerCase().split(/\s+/)[0] ?? ""]
      .filter((a) => a.length > 0);
    for (const alias of aliases) {
      if (!lower.includes(`@${alias}`)) continue;
      if (!best || alias.length > best.length) best = { info, length: alias.length };
    }
  }
  if (best) return best.info;
  return memberInfo(members[0]!);
}

function transcript(group: GroupChat, messages: GroupMessage[]): string {
  const lines = messages.slice(-30).map((m) => {
    const who = m.author === "user" ? "user" : memberInfo(m.author).name;
    return `${who}: ${m.text}`;
  });
  return [
    `[Group chat: ${group.name}]`,
    `Members: ${group.memberIds.map((id) => memberInfo(id).name).join(", ")}`,
    "",
    ...lines,
  ].join("\n");
}

function buildGroupPrompt(group: GroupChat, messages: GroupMessage[], target: GroupMemberInfo, handoffNote?: string | null): string {
  const handoff = handoffNote ? `\nThe previous agent handed this to you with the note: ${handoffNote}` : "";
  return [
    transcript(group, messages),
    "",
    `You are ${target.name} in this group chat. Reply to the latest message as ${target.name}, addressing the group.`,
    "Do not repeat other members' replies. If another member should continue, call handoff_to_agent with their exact name and a short note.",
    handoff,
  ].join("\n").trim();
}

function recordPendingTask(groupId: string, taskId: string, agentId: string): void {
  ensureTables();
  database()
    .prepare("INSERT OR IGNORE INTO group_tasks(task_id,group_id,agent_id,handoff_to,handoff_note,created_at) VALUES(?,?,?,NULL,NULL,?)")
    .run(taskId, groupId, agentId, new Date().toISOString());
}

/**
 * Producer used by the HTTP layer: create the task, register it with the group
 * *before* the run starts, then queue the normal agent run asynchronously.
 */
export function createGroupRunStarter(runTask: (opts: {
  taskId: string;
  prompt: string;
  agentId: string;
  emit: () => void;
}) => Promise<{ taskId: string; text: string }>): GroupRunStarter {
  return (input) => {
    const title = input.title ?? `Group: ${input.groupId}`;
    const task = createTask(input.prompt, title, null, input.agentId);
    recordPendingTask(input.groupId, task.id, input.agentId);
    void runTask({ taskId: task.id, prompt: input.prompt, agentId: input.agentId, emit: () => {} })
      .catch((error) => log.warn(`group run ${task.id}: ${String(error)}`));
    return { taskId: task.id };
  };
}

/**
 * Post a message. `author` is "user" or an agent id. A user message starts an
 * agent run; an agent-authored message is stored as-is (task replies normally
 * arrive through collectGroupReplies).
 */
export async function postToGroup(
  groupId: string,
  text: string,
  author: string,
  startRun?: GroupRunStarter,
): Promise<PostToGroupResult> {
  const group = getGroup(groupId);
  if (!group) throw new Error("group not found");
  const body = text.trim();
  if (!body) throw new Error("text is required");
  if (group.memberIds.length === 0) throw new Error("group has no members");

  const message = appendGroupMessage(groupId, author, body);
  if (author !== "user") return { message, targetAgentId: null, taskId: null };

  const target = resolveGroupTarget(groupId, body);
  if (!target) return { message, targetAgentId: null, taskId: null };
  if (!startRun) return { message, targetAgentId: target.id, taskId: null };

  const prompt = buildGroupPrompt(group, listGroupMessages(groupId), target, null);
  const { taskId } = await startRun({
    groupId,
    agentId: target.id,
    prompt,
    title: `${group.name} — ${target.name}`,
  });
  recordPendingTask(groupId, taskId, target.id);
  return { message, targetAgentId: target.id, taskId };
}

/**
 * Record a handoff requested by an agent's `handoff_to_agent` tool call. The
 * target must be a member of the group that owns this task.
 */
export function recordHandoffForTask(taskId: string, agentName: string, note?: string): GroupMemberResolution {
  ensureTables();
  const row = database().prepare("SELECT * FROM group_tasks WHERE task_id=?").get(taskId);
  if (!row) return { ok: false, reason: "handoff_to_agent is only available inside a group task." };
  const group = getGroup(String(row.group_id));
  if (!group) return { ok: false, reason: "group not found for this task." };

  const wanted = agentName.trim().toLowerCase();
  const match = group.memberIds
    .map((id) => memberInfo(id))
    .find((m) => m.id.toLowerCase() === wanted || m.name.toLowerCase() === wanted);
  if (!match) {
    return { ok: false, reason: `"${agentName}" is not a member of this group. Members: ${group.memberIds.map((id) => memberInfo(id).name).join(", ")}` };
  }
  const cleaned = (note ?? "").trim().slice(0, 2000);
  database()
    .prepare("UPDATE group_tasks SET handoff_to=?, handoff_note=? WHERE task_id=?")
    .run(match.id, cleaned || null, taskId);
  return { ok: true, group, agent: match };
}

function pendingTasks(): Array<{ task_id: string; group_id: string; agent_id: string; handoff_to: string | null; handoff_note: string | null }> {
  ensureTables();
  return database().prepare("SELECT * FROM group_tasks ORDER BY rowid ASC").all().map((r) => {
    const row = r as Record<string, unknown>;
    return {
      task_id: String(row.task_id),
      group_id: String(row.group_id),
      agent_id: String(row.agent_id),
      handoff_to: row.handoff_to == null ? null : String(row.handoff_to),
      handoff_note: row.handoff_note == null ? null : String(row.handoff_note),
    };
  });
}

/** Atomically claim a finished task so concurrent polls append one reply only. */
function claimFinishedTask(taskId: string): boolean {
  return transaction(() => {
    const row = database().prepare("SELECT task_id FROM group_tasks WHERE task_id=?").get(taskId);
    if (!row) return false;
    database().prepare("DELETE FROM group_tasks WHERE task_id=?").run(taskId);
    return true;
  });
}

function replyText(task: ReturnType<typeof getTask>): string {
  if (!task) return "(task no longer exists)";
  if (task.status === "error") return task.error ? `(error) ${task.error}` : "(error)";
  if (task.status === "cancelled") return "(cancelled)";
  if (task.status === "interrupted") return "(interrupted)";
  const last = [...(task.messages ?? [])].reverse().find((m) => m.role === "assistant");
  return last?.content?.trim() || "(no reply)";
}

/**
 * Poll the tasks started by groups and copy finished replies into the
 * transcript. When a finished agent requested a handoff, start the next agent's
 * task with the updated transcript. Safe to call from any GET handler.
 */
export async function collectGroupReplies(startRun?: GroupRunStarter): Promise<number> {
  ensureTables();
  let collected = 0;
  for (const pending of pendingTasks()) {
    const task = getTask(pending.task_id);
    if (!task) {
      claimFinishedTask(pending.task_id);
      continue;
    }
    if (task.status !== "done" && task.status !== "error" && task.status !== "cancelled" && task.status !== "interrupted") continue;
    if (!claimFinishedTask(pending.task_id)) continue;

    const group = getGroup(pending.group_id);
    if (!group) continue;

    const handoff = pending.handoff_to && group.memberIds.includes(pending.handoff_to) ? pending.handoff_to : null;
    appendGroupMessage(group.id, pending.agent_id, replyText(task), handoff, handoff ? pending.handoff_note : null);
    collected++;

    if (handoff && startRun) {
      const target = memberInfo(handoff);
      const prompt = buildGroupPrompt(group, listGroupMessages(group.id), target, pending.handoff_note);
      const { taskId } = await startRun({
        groupId: group.id,
        agentId: handoff,
        prompt,
        title: `${group.name} — ${target.name}`,
      });
      recordPendingTask(group.id, taskId, handoff);
    }
  }
  return collected;
}

/** Test/inspection helper: pending group tasks. */
export function listPendingGroupTasks(): Array<{ taskId: string; groupId: string; agentId: string; handoffTo: string | null; handoffNote: string | null }> {
  return pendingTasks().map((p) => ({
    taskId: p.task_id,
    groupId: p.group_id,
    agentId: p.agent_id,
    handoffTo: p.handoff_to,
    handoffNote: p.handoff_note,
  }));
}
