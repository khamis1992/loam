import { after, headSeq, type LogEvent } from "../protocol/eventLog.js";
import { writePage } from "./store.js";
import type { Page } from "./types.js";

const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
const MAX_TOOLS_LISTED = 12;
const MAX_FILES_LISTED = 15;

interface Loose { [key: string]: unknown }
const obj = (v: unknown): Loose => (v && typeof v === "object" ? (v as Loose) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function readEvents(sessionId: string): LogEvent[] {
  const out: LogEvent[] = [];
  let seq = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const batch = after(sessionId, seq, PAGE_SIZE);
    if (!batch.length) break;
    out.push(...batch);
    seq = batch[batch.length - 1]!.seq;
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

export interface SessionDigest {
  sessionId: string;
  title: string;
  goal: string;
  outcome: string;
  userMessages: number;
  toolCounts: Record<string, number>;
  files: string[];
  failed: boolean;
  startedAt: number;
  endedAt: number;
}

/** Pure digest of one session's event log. No model call: only what the log already recorded. */
export function digestSession(sessionId: string, events: LogEvent[] = readEvents(sessionId)): SessionDigest | undefined {
  if (!events.length) return undefined;
  let title = "";
  let goal = "";
  let outcome = "";
  let userMessages = 0;
  let failed = false;
  const tools: Record<string, number> = {};
  const files = new Set<string>();
  for (const ev of events) {
    const p = obj(ev.payload);
    if (ev.kind === "status") {
      title = title || str(p.title);
      if (str(p.status).toLowerCase().includes("fail")) failed = true;
      continue;
    }
    if (ev.kind !== "chat_event") continue;
    const event = obj(p.event);
    const type = str(event.type);
    if (type === "chat") {
      const text = str(event.content);
      if (event.sender === "user") {
        userMessages++;
        goal = goal || text;
      } else if (text && event.deliveryKind !== "provisional") {
        outcome = text;
      }
    } else if (type === "toolUsed") {
      const name = str(event.tool) || "tool";
      tools[name] = (tools[name] ?? 0) + 1;
      const param = str(obj(event.message).param);
      if (param && /[\\/]|\.\w{1,6}$/.test(param) && param.length < 260) files.add(param);
    }
  }
  return {
    sessionId,
    title: title || oneLine(goal, 80) || sessionId,
    goal,
    outcome,
    userMessages,
    toolCounts: tools,
    files: [...files],
    failed,
    startedAt: events[0]!.createdAt,
    endedAt: events[events.length - 1]!.createdAt,
  };
}

export function renderSessionPage(d: SessionDigest): string {
  const tools = Object.entries(d.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOOLS_LISTED)
    .map(([name, n]) => `${name} x${n}`);
  const lines = [
    `# ${d.title}`,
    "",
    `- Result: ${d.failed ? "failed or stopped" : "finished"}`,
    `- Started: ${new Date(d.startedAt).toISOString()}`,
    `- Ended: ${new Date(d.endedAt).toISOString()}`,
    `- User messages: ${d.userMessages}`,
    "",
    "## Goal",
    "",
    oneLine(d.goal, 1500) || "(not recorded)",
    "",
    "## Outcome",
    "",
    oneLine(d.outcome, 2500) || "(no final message recorded)",
    "",
  ];
  if (tools.length) lines.push("## Tools used", "", ...tools.map((t) => `- ${t}`), "");
  if (d.files.length) lines.push("## Files touched", "", ...d.files.slice(0, MAX_FILES_LISTED).map((f) => `- ${f}`), "");
  return lines.join("\n");
}

/** Write (or refresh) the session page for `sessionId`. Returns undefined when the log has nothing for it. */
export function writeSessionPage(root: string, sessionId: string): Page | undefined {
  if (headSeq(sessionId) === 0) return undefined;
  const digest = digestSession(sessionId);
  if (!digest) return undefined;
  const id = `s-${sessionId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "unknown"}`;
  return writePage(root, {
    kind: "session",
    id,
    title: oneLine(digest.title, 120),
    body: renderSessionPage(digest),
    tags: ["session", digest.failed ? "failed" : "done"],
    sessionId,
  });
}
