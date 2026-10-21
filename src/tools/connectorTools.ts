/**
 * Agent tools for OAuth connectors (GitHub / Gmail / Google Calendar).
 *
 * These tools are only added to a run's allowlist while the matching connector
 * is connected (see connectedConnectorToolNames in src/server/connectors).
 * Read tools call the public REST APIs directly with the sealed bearer token.
 * Write tools go through the existing approvals layer (src/server/approvals.ts)
 * and never execute until the user approves. gmail_create_draft only creates
 * drafts — Loam never sends email.
 */
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";
import { createApproval, waitForDecision } from "../server/approvals.js";
import { getAccessToken } from "../server/connectors/oauth.js";
import { githubConnector } from "../server/connectors/providers/github.js";
import { gmailConnector, calendarConnector } from "../server/connectors/providers/google.js";
import type { ConnectorDef } from "../server/connectors/oauth.js";

const GITHUB_API = "https://api.github.com";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars/primary";

async function tokenFor(def: ConnectorDef): Promise<string> {
  return getAccessToken(def);
}

async function getJson(url: string, def: ConnectorDef, extraHeaders: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const token = await tokenFor(def);
  const res = await fetch(url, { headers: { accept: "application/json", authorization: `Bearer ${token}`, ...extraHeaders } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 400)}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function postJson(
  url: string,
  def: ConnectorDef,
  payload: unknown,
  method: "POST" | "PATCH" = "POST",
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const token = await tokenFor(def);
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}`, ...extraHeaders },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 400)}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** Route a risky connector write through the approvals layer before executing. */
async function withApproval(
  ctx: ToolContext,
  name: string,
  summary: string,
  args: Record<string, unknown>,
  action: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const approval = createApproval({ taskId: ctx.taskId ?? "", tool: name, summary, argsPreview: JSON.stringify(args ?? {}) });
  ctx.emit({ type: "approval_required", approvalId: approval.id, tool: name, summary });
  const decision = await waitForDecision(approval.id, ctx.signal);
  if (decision !== "approved") {
    return { ok: false, content: `${name} was ${decision} by the user; nothing was changed.` };
  }
  return action();
}

function fail(err: unknown, name: string): ToolResult {
  return { ok: false, content: `${name} failed: ${err instanceof Error ? err.message : String(err)}` };
}

function decodeGmailData(data: unknown): string {
  if (typeof data !== "string") return "";
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function gmailMessageText(msg: Record<string, unknown>): string {
  const payload = (msg.payload ?? {}) as { parts?: unknown[]; body?: { data?: string }; headers?: Array<{ name: string; value: string }> };
  const headers = new Map<string, string>();
  for (const h of payload.headers ?? []) {
    if (typeof h.name === "string" && typeof h.value === "string") headers.set(h.name.toLowerCase(), h.value);
  }
  const chunks: string[] = [];
  const collect = (parts: unknown[]): void => {
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as { mimeType?: string; body?: { data?: string }; parts?: unknown[] };
      if (Array.isArray(p.parts)) collect(p.parts);
      else if (p.mimeType === "text/plain" && p.body?.data) chunks.push(decodeGmailData(p.body.data));
    }
  };
  collect(payload.parts ?? []);
  if (chunks.length === 0 && payload.body?.data) chunks.push(decodeGmailData(payload.body.data));
  const meta = ["from", "to", "subject"].map((h) => `${h}: ${headers.get(h) ?? ""}`).join("\n");
  return `${meta}\n\n${chunks.join("\n").trim()}`.trim();
}

function buildRawEmail(from: string, to: string, subject: string, body: string): string {
  return [`To: ${to}`, from ? `From: ${from}` : "", `Subject: ${subject}`, "", body].filter(Boolean).join("\r\n");
}

function githubRepoSummary(repo: unknown): string {
  const r = repo as { full_name?: string; private?: boolean; description?: string; updated_at?: string };
  return `${r.full_name ?? "?"} ${r.private ? "(private)" : "(public)"} — ${r.description ?? ""} [updated ${r.updated_at ?? "?"}]`.trim();
}

function githubIssueSummary(issue: unknown): string {
  const i = issue as { number?: number; state?: string; title?: string; user?: { login?: string } };
  return `#${i.number ?? "?"} [${i.state ?? "?"}] ${i.title ?? ""} (@${i.user?.login ?? "?"})`.trim();
}

function calendarEventSummary(event: unknown): string {
  const e = event as { id?: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; htmlLink?: string };
  return `${e.summary ?? "(no title)"} — ${e.start?.dateTime ?? e.start?.date ?? "?"} to ${e.end?.dateTime ?? e.end?.date ?? "?"} (id ${e.id ?? "?"})`.trim();
}

export function createConnectorTools(): Tool[] {
  return [
    {
      name: "github_list_repos",
      description: "List GitHub repositories for the connected account (newest updated first).",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "Max repositories (1-100, default 30)" } },
      },
      async run(args, ctx): Promise<ToolResult> {
        try {
          const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 30), 1), 100);
          const repos = await getJson(`${GITHUB_API}/user/repos?per_page=${limit}&sort=updated`, githubConnector);
          if (!Array.isArray(repos)) return { ok: true, content: "(no repositories)" };
          if (repos.length === 0) return { ok: true, content: "(no repositories)" };
          return { ok: true, content: repos.map(githubRepoSummary).join("\n") };
        } catch (err) {
          return fail(err, "github_list_repos");
        }
      },
    },
    {
      name: "github_list_issues",
      description: "List open issues in a GitHub repository, e.g. owner/repo.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Repository as owner/repo" },
          limit: { type: "number", description: "Max issues (1-100, default 30)" },
        },
        required: ["repo"],
      },
      async run(args, ctx): Promise<ToolResult> {
        try {
          const repo = str(args, "repo").trim();
          if (!repo || !repo.includes("/")) return { ok: false, content: "github_list_issues requires repo as owner/repo" };
          const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 30), 1), 100);
          const issues = await getJson(`${GITHUB_API}/repos/${repo}/issues?state=open&per_page=${limit}`, githubConnector);
          if (!Array.isArray(issues) || issues.length === 0) return { ok: true, content: "(no open issues)" };
          return { ok: true, content: issues.map(githubIssueSummary).join("\n") };
        } catch (err) {
          return fail(err, "github_list_issues");
        }
      },
    },
    {
      name: "github_create_issue",
      description: "Create an issue in a GitHub repository. Requires user approval before it runs.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Repository as owner/repo" },
          title: { type: "string", description: "Issue title" },
          body: { type: "string", description: "Issue body (markdown)" },
        },
        required: ["repo", "title"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const repo = str(args, "repo").trim();
        const title = str(args, "title").trim();
        if (!repo || !repo.includes("/")) return { ok: false, content: "github_create_issue requires repo as owner/repo" };
        if (!title) return { ok: false, content: "github_create_issue requires title" };
        return withApproval(ctx, "github_create_issue", `Create GitHub issue "${title}" in ${repo}`, args, async () => {
          try {
            const issue = await postJson(`${GITHUB_API}/repos/${repo}/issues`, githubConnector, { title, body: str(args, "body") });
            return { ok: true, content: `created issue #${issue.number ?? "?"}: ${issue.html_url ?? ""}` };
          } catch (err) {
            return fail(err, "github_create_issue");
          }
        });
      },
    },
    {
      name: "gmail_search",
      description: "Search the connected Gmail mailbox (same query syntax as Gmail). Returns matching messages with ids and subjects.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query, e.g. 'from:boss subject:invoice newer_than:7d'" },
          limit: { type: "number", description: "Max results (1-25, default 10)" },
        },
        required: ["query"],
      },
      async run(args, ctx): Promise<ToolResult> {
        try {
          const query = str(args, "query").trim();
          if (!query) return { ok: false, content: "gmail_search requires query" };
          const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 10), 1), 25);
          const data = await getJson(`${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=${limit}`, gmailConnector);
          const messages = Array.isArray(data.messages) ? data.messages as Array<Record<string, unknown>> : [];
          if (messages.length === 0) return { ok: true, content: "(no matching messages)" };
          const lines: string[] = [];
          for (const m of messages) {
            const id = String(m.id ?? "");
            const threadId = String(m.threadId ?? "");
            const snippet = String(m.snippet ?? "");
            try {
              const full = await getJson(`${GMAIL_API}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, gmailConnector);
              const headers = ((full.payload ?? {}) as { headers?: Array<{ name: string; value: string }> }).headers ?? [];
              const subject = headers.find((h) => h.name === "Subject")?.value ?? "";
              const from = headers.find((h) => h.name === "From")?.value ?? "";
              lines.push(`${id} (thread ${threadId}) from: ${from} subject: ${subject}${snippet ? ` — ${snippet.slice(0, 120)}` : ""}`);
            } catch {
              lines.push(`${id} (thread ${threadId}) ${snippet}`.trim());
            }
          }
          return { ok: true, content: lines.join("\n") };
        } catch (err) {
          return fail(err, "gmail_search");
        }
      },
    },
    {
      name: "gmail_read",
      description: "Read a Gmail message by id and return its headers and plain-text body.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Gmail message id (from gmail_search)" } },
        required: ["id"],
      },
      async run(args, ctx): Promise<ToolResult> {
        try {
          const id = str(args, "id").trim();
          if (!id) return { ok: false, content: "gmail_read requires id" };
          const msg = await getJson(`${GMAIL_API}/messages/${id}?format=full`, gmailConnector);
          const text = gmailMessageText(msg);
          return { ok: true, content: text || "(empty message)" };
        } catch (err) {
          return fail(err, "gmail_read");
        }
      },
    },
    {
      name: "gmail_create_draft",
      description: "Create a Gmail draft (never sends). Requires user approval before it runs.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient address" },
          subject: { type: "string", description: "Subject line" },
          body: { type: "string", description: "Plain-text body" },
        },
        required: ["to", "subject", "body"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const to = str(args, "to").trim();
        const subject = str(args, "subject").trim();
        const body = str(args, "body");
        if (!to || !subject) return { ok: false, content: "gmail_create_draft requires to and subject" };
        return withApproval(ctx, "gmail_create_draft", `Create Gmail draft to ${to}: "${subject}"`, args, async () => {
          try {
            const me = await getJson(`${GMAIL_API}`, gmailConnector).catch(() => ({} as Record<string, unknown>));
            const from = String((me as { emailAddress?: string }).emailAddress ?? "");
            const raw = Buffer.from(buildRawEmail(from, to, subject, body), "utf8").toString("base64url");
            const draft = await postJson(`${GMAIL_API}/drafts`, gmailConnector, { message: { raw } });
            return { ok: true, content: `created draft ${draft.id ?? "?"} (not sent)` };
          } catch (err) {
            return fail(err, "gmail_create_draft");
          }
        });
      },
    },
    {
      name: "calendar_list_events",
      description: "List upcoming events in the connected Google Calendar primary calendar.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Window in days from now (1-90, default 7)" },
          limit: { type: "number", description: "Max events (1-50, default 20)" },
        },
      },
      async run(args, ctx): Promise<ToolResult> {
        try {
          const days = Math.min(Math.max(Math.trunc(Number(args.days) || 7), 1), 90);
          const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 20), 1), 50);
          const timeMin = new Date().toISOString();
          const timeMax = new Date(Date.now() + days * 86_400_000).toISOString();
          const data = await getJson(
            `${CALENDAR_API}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&maxResults=${limit}&orderBy=startTime`,
            calendarConnector,
          );
          const events = Array.isArray(data.items) ? data.items : [];
          if (events.length === 0) return { ok: true, content: "(no upcoming events)" };
          return { ok: true, content: events.map(calendarEventSummary).join("\n") };
        } catch (err) {
          return fail(err, "calendar_list_events");
        }
      },
    },
    {
      name: "calendar_create_event",
      description: "Create an event in the connected Google Calendar. Requires user approval before it runs.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Event title" },
          start: { type: "string", description: "Start time RFC3339, e.g. 2026-01-05T10:00:00Z" },
          end: { type: "string", description: "End time RFC3339" },
          location: { type: "string", description: "Optional location" },
          description: { type: "string", description: "Optional notes" },
          attendees: { type: "array", items: { type: "string" }, description: "Optional attendee emails" },
        },
        required: ["summary", "start", "end"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const summary = str(args, "summary").trim();
        const start = str(args, "start").trim();
        const end = str(args, "end").trim();
        if (!summary || !start || !end) return { ok: false, content: "calendar_create_event requires summary, start and end" };
        return withApproval(ctx, "calendar_create_event", `Create calendar event "${summary}" ${start} → ${end}`, args, async () => {
          try {
            const attendees = Array.isArray(args.attendees)
              ? (args.attendees as unknown[]).filter((a): a is string => typeof a === "string").map((email) => ({ email }))
              : [];
            const payload: Record<string, unknown> = {
              summary,
              start: { dateTime: start },
              end: { dateTime: end },
              ...(str(args, "location") ? { location: str(args, "location") } : {}),
              ...(str(args, "description") ? { description: str(args, "description") } : {}),
              ...(attendees.length > 0 ? { attendees } : {}),
            };
            const event = await postJson(`${CALENDAR_API}/events`, calendarConnector, payload);
            return { ok: true, content: `created event ${event.id ?? "?"}: ${event.htmlLink ?? ""}` };
          } catch (err) {
            return fail(err, "calendar_create_event");
          }
        });
      },
    },
  ];
}
