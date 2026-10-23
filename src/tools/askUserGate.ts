/**
 * Ask-User-More gate + classifiers (Neo N9).
 *
 * `ask_user` is the agent's structured clarification step: it pauses a run with
 * one or more questions (each with optional preset options), an optional
 * free-text answer and an optional uploaded file, then resumes with the answer
 * attached as context. It is the "Ask User More" node from the Neo programme.
 *
 * This module owns three things:
 *
 *  1. the tool payload type + argument parsing,
 *  2. the pure classifier that decides which tool calls are blocked while an
 *     ask-user request is pending (mirrors `gateToolCallForPendingPlan`),
 *  3. the auto-trigger classifier: a cheap, local, deterministic check that the
 *     request is vague or missing context, so the orchestrator can raise an
 *     ask-user node BEFORE any tool call runs.
 *
 * The blocking store/wait primitives live in `askUserStore.ts`; this file stays
 * a pure classifier over the store's read API so it can be imported at the
 * protocol/UI boundary without pulling the server store in.
 */
import { classifyToolCall, type RiskTier } from "../policy/riskTier.js";
import { pendingAskForTask, type AskUserQuestion } from "./askUserStore.js";

export const ASK_USER_TOOL = "ask_user";

/** Payload accepted by `ask_user`. */
export interface AskUserArgs {
  /** Short headline shown on the card. */
  title: string;
  /** Why the agent is asking. */
  reason?: string;
  /** The questions to ask (1-5). */
  questions: AskUserQuestion[];
}

export type AskUserStatus = "pending" | "answered" | "dismissed" | "expired";

/** Normalise and validate raw `ask_user` arguments. */
export function parseAskUserArgs(args: Record<string, unknown>): AskUserArgs | { error: string } {
  const rawTitle = (args as { title?: unknown }).title;
  const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
  if (!title) return { error: "ask_user requires a non-empty title for the clarification card" };
  if (title.length > 200) return { error: "ask_user title must be 200 characters or fewer" };
  const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 2000) : "";
  if (!Array.isArray(args.questions)) return { error: "ask_user requires a questions array" };
  if (args.questions.length === 0) return { error: "ask_user requires at least one question" };
  if (args.questions.length > 5) return { error: "ask_user accepts at most 5 questions" };
  const questions: AskUserQuestion[] = [];
  for (let i = 0; i < args.questions.length; i++) {
    const raw = args.questions[i];
    if (typeof raw !== "object" || raw === null) return { error: `ask_user question ${i + 1} must be an object` };
    const q = raw as Record<string, unknown>;
    const prompt = typeof q.prompt === "string" ? q.prompt.trim() : "";
    if (!prompt) return { error: `ask_user question ${i + 1} requires a non-empty prompt` };
    if (prompt.length > 1000) return { error: `ask_user question ${i + 1} prompt must be 1000 characters or fewer` };
    const options = Array.isArray(q.options)
      ? q.options.filter((o): o is string => typeof o === "string").map((o) => o.trim()).filter((o) => o.length > 0).slice(0, 6)
      : [];
    questions.push({
      id: `q${i + 1}`,
      prompt,
      ...(options.length > 0 ? { options } : {}),
      ...(q.allowFile === true ? { allowFile: true } : {}),
    });
  }
  return { title, ...(reason ? { reason } : {}), questions };
}

/** Render an ask-user request as a compact preview for the card / tool result. */
export function formatAskUserPreview(args: AskUserArgs): string {
  const lines = [args.title];
  if (args.reason) lines.push("", `Why: ${args.reason}`);
  lines.push("", "Questions:");
  args.questions.forEach((q) => {
    const options = q.options && q.options.length > 0 ? ` [${q.options.join(" | ")}]` : "";
    lines.push(`- ${q.prompt}${options}${q.allowFile ? " (file allowed)" : ""}`);
  });
  return lines.join("\n");
}

// ----------------------------------------------------------------------------
// Gate: which calls are blocked while an ask-user request is pending
// ----------------------------------------------------------------------------

/**
 * Tiers allowed while a request is pending: reads and read-only web research.
 * Everything else (writes, commands, destructive, secret) is blocked, so the
 * user's answer is never guessed around.
 */
const ASK_USER_ALLOWED_TIERS: ReadonlySet<RiskTier> = new Set<RiskTier>(["read", "network-external"]);

export interface AskUserGateDecision {
  allowed: boolean;
  /** The request awaiting an answer, when the call was blocked. */
  pendingRequest?: { id: string; title: string; taskId: string };
  reason?: string;
}

/**
 * Decide whether one tool call may run while a task's ask-user request is
 * pending. Uses the same risk tier as the permission-mode and plan-approval
 * gates, so a pending clarification blocks exactly the mutating surface.
 */
export function gateToolCallForPendingAsk(
  taskId: string,
  toolName: string,
  args?: Record<string, unknown> | null,
  workspaceRoot: string = process.cwd(),
): AskUserGateDecision {
  const pending = pendingAskForTask(taskId);
  if (!pending) return { allowed: true };
  const tier = classifyToolCall(toolName, args, workspaceRoot);
  if (ASK_USER_ALLOWED_TIERS.has(tier)) return { allowed: true };
  return {
    allowed: false,
    pendingRequest: { id: pending.id, title: pending.title, taskId: pending.taskId },
    reason: `the user has not answered the clarification request "${pending.title}" yet`,
  };
}

/** The refusal message shown to the model when a pending request blocks a call. */
export function askUserBlockedMessage(request: { id: string; title: string }, reason?: string): string {
  return (
    `A clarification request is still unanswered (${request.title}): ${reason ?? "waiting for the user"}. ` +
    `Call ask_user only to re-ask; do not guess an answer and do not edit files until the user responds.`
  );
}

// ----------------------------------------------------------------------------
// Auto-trigger: is the request vague or missing context?
// ----------------------------------------------------------------------------

/** Why the orchestrator decided to ask. */
export type AskUserTriggerReason = "vague" | "missing_context" | "ambiguous_target";

/** A decision from the auto-trigger classifier. */
export interface AskUserTrigger {
  reason: AskUserTriggerReason;
  /** The human-readable explanation shown on the card. */
  explanation: string;
  /** Suggested questions for the card (the orchestrator raises these verbatim). */
  questions: AskUserQuestion[];
}

/** Words that point at something the user has not identified. */
const AMBIGUOUS_PRONOUNS = [
  "this", "that", "it", "them", "those", "the thing", "the same", "the previous",
  "the last one", "the other one", "as before", "like before", "as discussed",
  "the same as last time", "the one I sent", "the file I sent", "the previous task",
];

/** Requests that are open-ended edits without a target. */
const OPEN_ENDED_ACTIONS = [
  "fix", "improve", "refactor", "clean up", "cleanup", "optimize", "polish", "tidy",
  "update", "modernize", "enhance", "make it better", "make it nicer", "speed up",
  "simplify", "rework", "revise", "tweak", "adjust", "handle it", "deal with it",
];

/** Domain words that make a request concrete enough to skip the card. */
const CONCRETE_HINTS = [
  ".ts", ".tsx", ".js", ".jsx", ".py", ".css", ".html", ".json", ".md", ".rs", ".go", ".java",
  "src/", "app/", "packages/", "components/", "pages/", "server", "client", "api", "test",
  "https://", "http://", "file:", "path:", "called ", "named ", "in the file", "in this repo",
  "arabic", "rtl", "mobile", "desktop", "landing", "dashboard", "button", "form", "table",
];

/**
 * Decide whether a prompt needs an ask-user clarification before work starts.
 *
 * This is a cheap, local, deterministic heuristic (no model call): it flags a
 * request when it is short AND open-ended, when it refers to something the user
 * never identified, or when it depends on prior context that is not in the
 * transcript. The orchestrator raises an `ask_user` node first so the run never
 * guesses around a missing answer.
 */
export function needsAskUser(prompt: string, history?: Array<{ role?: string; content?: string }>): AskUserTrigger | undefined {
  const text = (prompt ?? "").trim();
  if (!text) return undefined;
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lower = text.toLowerCase();

  const hasConcreteHint = CONCRETE_HINTS.some((hint) => lower.includes(hint));
  const hasAmbiguous = AMBIGUOUS_PRONOUNS.some((phrase) => new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
  const hasOpenEnded = OPEN_ENDED_ACTIONS.some((action) => new RegExp(`\\b${action.replace(/\s+/g, "\\s+")}\\b`, "i").test(text));
  const hasHistoryContext = (history ?? []).some((m) => (m.content ?? "").trim().length > 40);

  // 1. Missing context: the request leans on something not in this transcript.
  if (hasAmbiguous && !hasHistoryContext) {
    const ref = AMBIGUOUS_PRONOUNS.find((phrase) => new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
    return {
      reason: "missing_context",
      explanation: `The request refers to "${ref ?? "something"}" but no earlier task or file in this conversation identifies it.`,
      questions: [
        { id: "q1", prompt: "Which file, task or item does this refer to?", options: ["A file in this workspace", "The previous task", "Something I will attach next"], allowFile: true },
      ],
    };
  }

  // 2. Vague: short, open-ended, and with no concrete target.
  if (words.length <= 12 && hasOpenEnded && !hasConcreteHint) {
    return {
      reason: "vague",
      explanation: "The request is short and open-ended, so the goal and the target are not pinned down.",
      questions: [
        { id: "q1", prompt: "What is the main goal you want from this change?", options: ["Fix a bug", "Add a feature", "Improve the code", "Something else"] },
        { id: "q2", prompt: "Which file or area should I focus on?", allowFile: true },
      ],
    };
  }

  // 3. Ambiguous target: a concrete verb but no identified target.
  if (hasOpenEnded && !hasConcreteHint && words.length <= 20) {
    return {
      reason: "ambiguous_target",
      explanation: "The action is clear but the target is not, so the run could edit the wrong thing.",
      questions: [
        { id: "q1", prompt: "Which file or component should I change?", allowFile: true },
      ],
    };
  }

  return undefined;
}
