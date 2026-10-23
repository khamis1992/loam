/**
 * Ask-User-More tool (Neo N9).
 *
 * `ask_user` is the structured clarification step: the agent pauses the run,
 * presents one or more questions (with optional preset options and an optional
 * file upload) on an ask-user card, and resumes only once the user answers,
 * dismisses or lets the request expire. The answer (free text, per-question
 * answers and any uploaded files) is returned as the tool result, so the model
 * continues with the user's answer as context.
 *
 * The request is raised automatically by the orchestrator when the prompt is
 * vague or missing context (`needsAskUser`), and manually whenever the model
 * calls this tool. While a request is pending, every mutating tool call is
 * refused by `applyAskUserGate`.
 */
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import {
  askUserBlockedMessage,
  ASK_USER_TOOL,
  formatAskUserPreview,
  gateToolCallForPendingAsk,
  parseAskUserArgs,
} from "./askUserGate.js";
import { createAskUser, getAskUser, waitForAskUser } from "./askUserStore.js";

/** Build the ask-user tool (one instance per run; the task id comes from ctx). */
export function createAskUserTools(): Tool[] {
  return [
    {
      name: ASK_USER_TOOL,
      description:
        "Ask the user for clarification before acting: one or more questions with optional preset options and an optional file upload. " +
        "The run pauses with an ask-user card until the user answers (or dismisses it); the answer is then returned to you as context, including any uploaded file. " +
        "Use this when the request is vague, the target is missing, or you need a decision only the user can make. " +
        "When NOT to use: do not call it to report progress or to ask something you can answer yourself by reading the workspace, searching files or running a command — use the message tool for progress and the file/shell tools for investigation. " +
        "Do not use it to delay work you could start, and do not re-ask the same question while a request is still pending. " +
        "While a request is pending, mutating tools are refused, so ask BEFORE you start editing.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "questions"],
        properties: {
          title: {
            type: "string",
            maxLength: 200,
            description: "Short headline for the clarification card.",
          },
          reason: {
            type: "string",
            maxLength: 2000,
            description: "Why you are asking; shown under the headline.",
          },
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            description: "The questions to ask, in order.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["prompt"],
              properties: {
                prompt: { type: "string", maxLength: 1000, description: "The question shown to the user." },
                options: {
                  type: "array",
                  maxItems: 6,
                  items: { type: "string" },
                  description: "Optional preset answers the user can pick with one click.",
                },
                allowFile: { type: "boolean", description: "True when the user may upload a file for this question." },
              },
            },
          },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const parsed = parseAskUserArgs(args);
        if ("error" in parsed) return { ok: false, content: parsed.error };
        const taskId = ctx.taskId ?? "";
        if (!taskId) {
          return { ok: false, content: "ask_user requires an active task; no task is attached to this run." };
        }

        const record = createAskUser({ taskId, title: parsed.title, reason: parsed.reason, questions: parsed.questions });
        ctx.emit({
          type: "ask_user_required",
          askUserId: record.id,
          taskId,
          tool: ASK_USER_TOOL,
          title: record.title,
          reason: record.reason,
          questions: record.questions,
        });

        const status = await waitForAskUser(record.id, ctx.signal);
        const final = getAskUser(record.id);
        if (status === "answered" && final?.answer) {
          const answer = final.answer;
          const lines = [`The user answered your clarification request "${record.title}":`];
          if (answer.text.trim()) lines.push("", `Answer: ${answer.text.trim()}`);
          const answered = record.questions.filter((q) => answer.answers[q.id]?.trim());
          for (const q of answered) lines.push(`- ${q.prompt} → ${answer.answers[q.id]!.trim()}`);
          if (answer.files.length > 0) {
            lines.push("", "Attached files:");
            for (const file of answer.files) lines.push(`- ${file.name} (${file.path})`);
          }
          return { ok: true, content: lines.join("\n") };
        }
        const detail =
          status === "dismissed"
            ? "the user dismissed the card without answering"
            : status === "expired"
              ? "the request expired before the user answered"
              : `the request ${status}`;
        return { ok: false, content: `ask_user was not answered (${detail}); continue with what you know and say what you assumed.` };
      },
    },
  ];
}

/** Gate every tool call so a pending ask-user request blocks mutating actions. */
export function applyAskUserGate(registry: AskUserGateRegistry, opts: AskUserGateOptions): void {
  const { taskId, workspaceRoot } = opts;
  for (const name of registry.names()) {
    // `ask_user` itself must stay available: the model needs it to re-ask, and
    // it never mutates anything.
    if (name === ASK_USER_TOOL) continue;
    const original = registry.get(name);
    if (!original) continue;
    registry.replaceTool({
      ...original,
      async run(args, ctx) {
        const decision = gateToolCallForPendingAsk(ctx.taskId ?? taskId, name, args, workspaceRoot);
        if (!decision.allowed) {
          return {
            ok: false,
            content: askUserBlockedMessage(
              decision.pendingRequest ?? { id: "", title: "clarification" },
              decision.reason,
            ),
          };
        }
        return original.run(args, ctx);
      },
    });
  }
}

export { ASK_USER_TOOL, formatAskUserPreview, parseAskUserArgs };
export type { AskUserArgs } from "./askUserGate.js";

/** The registry surface the ask-user gate needs (a `ToolRegistry` or a filtered sub). */
export interface AskUserGateRegistry {
  names(): string[];
  get(name: string): Tool | undefined;
  replaceTool(tool: Tool): void;
}

export interface AskUserGateOptions {
  /** Task the run is executing; the pending store is read per call. */
  taskId: string;
  /** Workspace root used to resolve write paths while classifying a call. */
  workspaceRoot: string;
}

