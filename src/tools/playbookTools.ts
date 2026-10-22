/**
 * playbook_create_from_session (D9) — draft a reusable playbook from a
 * finished session transcript.
 *
 * The tool reads one task (its prompt, its messages and its step log), asks the
 * model for the six authored playbook sections as JSON, then persists the
 * result through the playbook store. The model call is injectable
 * (`draft`) so tests never touch a real model.
 */
import { getTask, listTasks } from "../server/db.js";
import type { Task } from "../server/db.js";
import { chatWithFallback } from "../agent/model.js";
import type { OllamaClient } from "../ollama.js";
import { createPlaybook, deriveMacro, getPlaybookByMacro, SECTION_KEYS, type PlaybookSections } from "../server/playbooks.js";
import { num, str, type Tool, type ToolContext, type ToolResult } from "./registry.js";

/** Sections the model must return; anything else is ignored. */
const DRAFT_KEYS = SECTION_KEYS;

/** Ask the model for the playbook sections; injectable so tests use a stub. */
export type PlaybookDraftModel = (prompt: string, ctx: ToolContext) => Promise<string>;

export interface PlaybookToolsOptions {
  ollama: OllamaClient;
  /** Override the model call (tests). Defaults to the run's fallback chain. */
  draft?: PlaybookDraftModel;
}

const TRANSCRIPT_MAX = 24_000;
const MESSAGE_MAX = 4_000;
const MAX_STEPS = 60;
/** Upper bound for the `sessionLimit` argument (how many recent tasks to scan). */
export const SESSION_LIMIT_MAX = 5;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n[...truncated ${value.length - max} chars]` : value;
}

/** A compact, model-readable transcript of one finished task. */
export function buildSessionTranscript(task: Task): string {
  const lines: string[] = [`Task: ${task.title}`, `Status: ${task.status}`, "", "## Prompt", truncate(task.prompt, MESSAGE_MAX)];
  if (task.messages.length > 0) {
    lines.push("", "## Conversation");
    for (const message of task.messages) {
      lines.push(`### ${message.role}`, truncate(message.content, MESSAGE_MAX));
    }
  }
  const steps = task.steps.slice(-MAX_STEPS);
  if (steps.length > 0) {
    lines.push("", "## Steps");
    for (const step of steps) {
      const detail = step.data === undefined ? "" : ` ${truncate(JSON.stringify(step.data), 300)}`;
      lines.push(`- [${step.type}]${detail}`);
    }
  }
  return truncate(lines.join("\n"), TRANSCRIPT_MAX);
}

/** Find a task by id, or the most recent finished task among the last `limit` tasks. */
export function findSessionTask(taskId?: string, limit = 1): Task | undefined {
  if (taskId && taskId.trim()) return getTask(taskId.trim());
  const recent = listTasks();
  const bounded = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), SESSION_LIMIT_MAX) : 1;
  const window = recent.slice(0, bounded);
  return window.find((t) => t.status === "done" || t.status === "error") ?? window[0];
}

const DRAFT_INSTRUCTIONS = `You are drafting a reusable playbook from a finished session.

Return ONLY a JSON object with exactly these string keys:
${DRAFT_KEYS.map((k) => `- "${k}"`).join("\n")}

Rules:
- Ground every section in what actually happened in the transcript. Do not invent tools, files or steps.
- "overview": one short paragraph — what this playbook is for and when to use it.
- "procedure": numbered, concrete steps in the order that worked.
- "specifications": exact tools, paths, formats, constraints and acceptance checks.
- "advice": pitfalls hit during the session and how to avoid them.
- "forbiddenActions": things the session showed must NOT be done.
- "neededFromUser": what the user must supply before this playbook can run.
- Use "" for a section the transcript genuinely does not support.`;

/** Tolerate ```json fences and prose around the JSON object. */
export function parseDraft(raw: string): PlaybookSections {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = (fenced ? fenced[1]! : raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("model did not return a JSON object");
  }
  const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("model did not return a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const out = { overview: "", procedure: "", specifications: "", advice: "", forbiddenActions: "", neededFromUser: "" } satisfies PlaybookSections;
  for (const key of DRAFT_KEYS) {
    const value = record[key];
    out[key] = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  }
  return out;
}

function defaultDraftModel(ollama: OllamaClient): PlaybookDraftModel {
  return async (prompt, ctx) => {
    const result = await chatWithFallback({
      cfg: ctx.cfg,
      ollama,
      messages: [
        { role: "system", content: DRAFT_INSTRUCTIONS },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return result.content;
  };
}

/** `playbook_create_from_session` — draft a playbook from a finished session. */
export function createPlaybookTools(options: PlaybookToolsOptions): Tool[] {
  const draft = options.draft ?? defaultDraftModel(options.ollama);
  return [
    {
      name: "playbook_create_from_session",
      description:
        "Draft a reusable playbook (versioned prompt library entry) from a finished session transcript. Reads the session's prompt, messages and steps, asks the model for the six sections, and saves the playbook so it can be attached later with its !macro.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string", description: "Playbook name, e.g. 'Release checklist'." },
          taskId: { type: "string", description: "Session/task id to learn from. Defaults to the current task, then the latest finished task." },
          macro: { type: "string", description: "Optional !macro (lowercase letters/digits/underscores). Derived from the name when omitted." },
          sessionLimit: { type: "number", description: `How many recent tasks to scan for a finished session when no taskId is given (default 1, max ${SESSION_LIMIT_MAX}).` },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const name = str(args, "name").trim();
        if (!name) return { ok: false, content: "playbook_create_from_session requires a name" };

        const explicitTaskId = str(args, "taskId").trim();
        const limit = Math.min(Math.max(Math.trunc(num(args, "sessionLimit", 1)), 1), SESSION_LIMIT_MAX);
        const task = findSessionTask(explicitTaskId || ctx.taskId, limit);
        if (!task) {
          return { ok: false, content: "no session found to draft a playbook from" };
        }
        if (task.messages.length === 0 && task.steps.length === 0) {
          return { ok: false, content: `session ${task.id} has no transcript to learn from` };
        }

        const requestedMacro = str(args, "macro").trim();
        let macro: string;
        try {
          macro = requestedMacro ? deriveMacro(requestedMacro, (m) => getPlaybookByMacro(m) !== undefined) : deriveMacro(name);
        } catch (err) {
          return { ok: false, content: err instanceof Error ? err.message : String(err) };
        }
        if (requestedMacro && getPlaybookByMacro(requestedMacro)) {
          return { ok: false, content: `macro "${requestedMacro}" already exists` };
        }

        const prompt = `## Session transcript\n\n${buildSessionTranscript(task)}\n\nDraft the playbook JSON now.`;
        ctx.emit({ type: "tool_call", name: "playbook_create_from_session", args: { name, macro, taskId: task.id } });

        let raw: string;
        try {
          raw = await draft(prompt, ctx);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, content: `playbook draft model call failed: ${message}` };
        }

        let sections: PlaybookSections;
        try {
          sections = parseDraft(raw);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, content: `could not parse the drafted playbook: ${message}` };
        }

        if (DRAFT_KEYS.every((key) => sections[key].trim().length === 0)) {
          return { ok: false, content: "the model returned an empty playbook; nothing was saved" };
        }

        try {
          const playbook = createPlaybook({ name, macro, ...sections, createdBy: `session:${task.id}` });
          return {
            ok: true,
            content: JSON.stringify(
              {
                created: true,
                playbook: { id: playbook.id, name: playbook.name, macro: playbook.macro, currentVersion: playbook.currentVersion },
                fromSession: task.id,
                usage: `attach it to a chat message with !${playbook.macro}`,
              },
              null,
              2,
            ),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, content: `could not save the playbook: ${message}` };
        }
      },
    },
  ];
}
