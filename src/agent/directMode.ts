/**
 * Direct-mode route.
 *
 * The orchestrator (plan → steps → critique → verify) adds quality for complex
 * work but costs several model round-trips before the user sees anything. A
 * simple task — a question, a greeting, a one-step request — does not need that
 * machinery: the plain agent loop answers it directly and starts streaming in
 * seconds.
 *
 * This module decides, from the prompt and the session history, whether a run
 * should bypass the orchestrator. The decision is deliberately conservative:
 * when the evidence is ambiguous it keeps the orchestrator, because a wrong
 * "direct" decision costs quality while a wrong "orchestrated" decision only
 * costs a little startup latency.
 */

export interface DirectModeDecision {
  /** True when the run should use the plain agent loop. */
  bypass: boolean;
  /** Short, human-readable reason (safe to log). */
  reason: string;
}

/**
 * The minimal toolset for a simple task. A question or a chat reply needs a
 * handful of tools, not the full catalog: the control surface (think, finish,
 * message, ask_user), the read tools, a docs lookup and a semantic search.
 * Sending 90+ tool schemas costs ~75 KB of prompt per call, which is the
 * dominant latency for a short reply.
 */
export const CONCISE_TOOLS: string[] = [
  "think",
  "finish",
  "message",
  "ask_user",
  "file_read",
  "file_list",
  "file_search",
  "grep",
  "glob",
  "docs_lookup",
  "semantic_search",
];

export function shouldUseConciseTools(bypass: boolean, activePackId?: string): boolean {
  return bypass && !activePackId;
}

/** Questions that a single answer satisfies. */
const QUESTION_PATTERN =
  /^(?:what|who|whom|whose|where|when|why|how|which|is|are|am|was|were|can|could|do|does|did|should|would|will|shall|may|might|have|has|had)\b/i;

/** Arabic question prefixes and particles. */
const QUESTION_PATTERN_AR =
  /^(?:ما|ماذا|من|أين|اين|متى|لماذا|كيف|كم|هل|أ|ا|يمكن|يستطيع|يجب|هل يمكن|ما هو|ما هي|من هو|من هي|أليس|ألست|أليس)/;

/** Greetings and pleasantries. */
const GREETING_PATTERN =
  /^(?:hi|hello|hey|yo|sup|good\s+(?:morning|afternoon|evening)|مرحبا|السلام|اهلا|أهلا|صباح|مساء|هاي)/i;

/** Explicitly multi-step / deliverable verbs. */
const COMPLEX_PATTERN =
  /\b(?:build|create|implement|develop|design|architect|refactor|redesign|restructure|migrat\w*|deploy|publish|analyze|analyse|research|investigate|audit|review|report|plan|pipeline|workflow|scaffold|generate)\b|new\s+(?:page|route|component|feature|file|module|screen|endpoint|app|website|project)/i;

/** Arabic complex-deliverable verbs. */
const COMPLEX_PATTERN_AR =
  /(?:بناء|أنشئ|انشئ|إنشاء|تنفيذ|نفّذ|نفذ|تطوير|طوّر|تصميم|صمّم|تحليل|حلّل|بحث|ابحث|دراسة|درس|تدقيق|مراجعة|راجع|تقرير|أعد تقرير|خطة|مخطط|مسار|سير عمل|نشر|انشر|ترحيل|هجرة|بنية|معمارية)/;

/** Requests that only read or explain. */
const READ_ONLY_PATTERN =
  /\b(?:explain|describe|summarize|summarise|translate|convert|what does|what is|how does|how do|tell me|show me|list|find|search|read|open|preview)\b/i;

const READ_ONLY_PATTERN_AR =
  /(?:اشرح|شرح|وضّح|وضح|لخص|تلخيص|ترجم|ترجمة|حوّل|حول|ما معنى|ما هو|ما هي|كيف|أخبرني|اخبرني|اعرض|عرض|اقرأ|قراءة|افتح|معاينة|بحث عن|ابحث عن)/;

/** Word count above which a prompt is never treated as trivial. */
const MAX_TRIVIAL_WORDS = 14;

/** Character count above which a prompt is never treated as trivial. */
const MAX_TRIVIAL_CHARS = 160;

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Decide whether a run should bypass the orchestrator.
 *
 * Rules, in order:
 * 1. A session with history keeps the orchestrator (a follow-up belongs to a
 *    plan already in flight).
 * 2. A long prompt keeps the orchestrator.
 * 3. An explicitly complex deliverable keeps the orchestrator.
 * 4. A greeting, a question, or a short read-only request goes direct.
 * 5. Anything else keeps the orchestrator.
 */
export function shouldBypassOrchestrator(
  prompt: string,
  history?: Array<{ role?: string; content?: string }>,
): DirectModeDecision {
  if (history && history.length > 0) {
    return { bypass: false, reason: "session has history" };
  }

  const text = (prompt ?? "").trim();
  if (!text) return { bypass: false, reason: "empty prompt" };

  const words = wordsOf(text);
  if (words.length > MAX_TRIVIAL_WORDS || text.length > MAX_TRIVIAL_CHARS) {
    return { bypass: false, reason: "prompt is too long for direct mode" };
  }

  if (COMPLEX_PATTERN.test(text) || COMPLEX_PATTERN_AR.test(text)) {
    return { bypass: false, reason: "prompt asks for a complex deliverable" };
  }

  if (GREETING_PATTERN.test(text)) {
    return { bypass: true, reason: "greeting" };
  }

  const hasQuestionMark = /[؟?]\s*$/.test(text);
  if (QUESTION_PATTERN.test(text) || QUESTION_PATTERN_AR.test(text) || (hasQuestionMark && words.length <= MAX_TRIVIAL_WORDS)) {
    return { bypass: true, reason: "question" };
  }

  if (READ_ONLY_PATTERN.test(text) || READ_ONLY_PATTERN_AR.test(text)) {
    return { bypass: true, reason: "read-only request" };
  }

  return { bypass: false, reason: "no direct-mode signal" };
}
