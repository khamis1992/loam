// src/appbuilder/lead.ts — Goal-mode Lead (MISSING §4.2): questions card,
// plan draft with revisions and the 409 stale check, approve/decline/edit,
// task assignment and finish. The row mutations go through store.ts; nothing
// here reimplements a row function. The model-driven turns (clarify, plan)
// accept an injected executor so the engine wave (W3-c) can wire
// chatWithRouting without touching this file's logic.
import { extractJson } from "../agent/planner.js";
import { writeAllFromPlan } from "./contextFiles.js";
import { emitProjectEvent } from "./events.js";
import { LEAD_SYSTEM, planDeclinedMessage, questionsAnsweredMessage } from "./prompts.js";
import { APP_ROLES, assignableRoles } from "./roles.js";
import {
  answerQuestion, getAssignment, getQuestionCard, insertAssignment, insertPlanDraft, insertQuestion,
  latestPlanDraft, decidePlanDraft, newAppRowId, updateAppProjectRow, updateAssignment,
  updatePlanDraftDoc,
} from "./store.js";
import type { AskUserRequestedEvent } from "../protocol/types.js";
import type {
  AppProject, AppRoleId, AppTaskAssignment, PlanDocument, PlanDraft, QuestionAnswer,
  QuestionOption, QuestionSpec, QuestionsCard, TemplateFeatureId,
} from "./types.js";

// ----------------------------------------------------------------------------
// §4.2.1 Questions card: validation + creation
// ----------------------------------------------------------------------------

export interface QuestionValidation {
  ok: boolean;
  problems: string[];
  title: string;
  questions: QuestionSpec[];
}

const OPTION_ID_RE = /^o[1-9][0-9]*$/;
const SCENARIOS = ["web_app", "landing_page", "data_dashboard", "content_site", "game", "tool", "fullstack_app"] as const;
const FEATURES: TemplateFeatureId[] = ["fullstack", "seo-blog"];
const TASK_ID_RE = /^T([1-9]|1[0-9]|20)$/;

function isOption(o: unknown): o is QuestionOption {
  return typeof o === "object" && o !== null && typeof (o as Record<string, unknown>).label === "string";
}

/**
 * Validate the Lead's `{"title", "questions": QuestionSpec[]}` JSON against the
 * §4.2.1 rule table. Ids are normalised (`q1..`, `o1..`) when absent; every
 * violation is collected so the model can be re-asked with the full list.
 * The two "Forbidden" prose rules (no stack questions, no already-answered
 * questions) live in the LEAD_SYSTEM prompt and are not mechanically checkable.
 */
export function validateQuestionSpecs(raw: unknown): QuestionValidation {
  const problems: string[] = [];
  const out: QuestionSpec[] = [];
  const src = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const title = typeof src.title === "string" && src.title.trim() ? src.title.trim() : "A few quick questions";
  const list = Array.isArray(src.questions) ? src.questions : [];
  if (list.length < 1 || list.length > 5) problems.push("a card carries 1 to 5 questions");
  for (let i = 0; i < list.length && i < 5; i++) {
    const q = list[i] as Record<string, unknown>;
    if (typeof q !== "object" || q === null || typeof q.prompt !== "string") {
      problems.push(`question ${i + 1} needs a prompt string`);
      continue;
    }
    const prompt = q.prompt.trim();
    if (prompt.length < 10 || prompt.length > 160) problems.push(`question ${i + 1} prompt must be 10 to 160 characters`);
    if (!prompt.endsWith("?")) problems.push(`question ${i + 1} prompt must end with "?"`);
    const kind = q.kind === "multi" || q.kind === "text" ? q.kind : "single";
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options: QuestionOption[] = [];
    for (let j = 0; j < rawOptions.length; j++) {
      const o = rawOptions[j]!;
      if (!isOption(o)) { problems.push(`question ${i + 1} option ${j + 1} needs a label`); continue; }
      const label = String(o.label).trim();
      if (label.length < 1 || label.length > 40) problems.push(`question ${i + 1} option ${j + 1} label must be 1 to 40 characters`);
      const detail = typeof o.detail === "string" ? o.detail.trim() : undefined;
      if (detail !== undefined && detail.length > 240) problems.push(`question ${i + 1} option ${j + 1} detail must be at most 240 characters`);
      options.push({ id: OPTION_ID_RE.test(String(o.id ?? "")) ? String(o.id) : `o${j + 1}`, label, ...(detail ? { detail } : {}) });
    }
    if (kind !== "text" && options.length < 2) problems.push(`question ${i + 1} (kind ${kind}) needs 2 to 5 options`);
    if (options.length > 5) problems.push(`question ${i + 1} has more than 5 options`);
    if (kind === "text" && options.length > 0) problems.push(`question ${i + 1} is a text question and takes no options`);
    const defaults = Array.isArray(q.defaultOptionIds) ? q.defaultOptionIds.filter((d): d is string => typeof d === "string") : [];
    const known = new Set(options.map((o) => o.id));
    if (defaults.some((d) => !known.has(d))) problems.push(`question ${i + 1} default references an option that does not exist`);
    if (kind === "single" && defaults.length !== 1) problems.push(`question ${i + 1} (single) needs exactly 1 default`);
    if (kind === "multi" && defaults.length > options.length) problems.push(`question ${i + 1} (multi) has more defaults than options`);
    if (kind === "text" && defaults.length > 0) problems.push(`question ${i + 1} (text) takes no default`);
    out.push({
      id: `q${i + 1}`,
      prompt,
      kind,
      options: kind === "text" ? [] : options,
      defaultOptionIds: kind === "text" ? [] : defaults,
      allowOther: q.allowOther === true,
    });
  }
  return { ok: problems.length === 0 && out.length > 0, problems, title, questions: out };
}

/** How lead.ts publishes a questions card. Injectable for tests; default emits the §4.15 askUserRequested event. */
export type QuestionCardEmitter = (project: AppProject, card: QuestionsCard) => void;

const defaultEmitter: QuestionCardEmitter = (project, card) => {
  const questions: AskUserRequestedEvent["questions"] = card.questions.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    ...(q.kind !== "single" ? { kind: q.kind } : {}),
    ...(q.options.length > 0 ? { optionDetails: q.options.map(({ id, label, detail }) => ({ id, label, ...(detail ? { detail } : {}) })) } : {}),
    ...(q.defaultOptionIds.length > 0 ? { defaultOptionIds: q.defaultOptionIds } : {}),
    ...(q.allowOther ? { allowOther: true } : {}),
  }));
  emitProjectEvent(project.id, "askUserRequested", {
    requestId: card.id,
    taskId: project.taskId,
    title: card.title,
    reason: "Goal-mode Lead clarification",
    questions,
    source: "model",
  });
};

/** Store one validated card as `pending` and emit the ask-user event (§4.2.1). */
export function createQuestionsCard(
  input: { project: AppProject; runId: string; title: string; questions: QuestionSpec[] },
  emit: QuestionCardEmitter = defaultEmitter,
): QuestionsCard {
  const card: QuestionsCard = {
    id: newAppRowId("qc_"),
    projectId: input.project.id,
    runId: input.runId,
    title: input.title,
    questions: input.questions,
    status: "pending",
    answers: null,
    createdAt: new Date().toISOString(),
    answeredAt: null,
  };
  insertQuestion(card);
  updateAppProjectRow(input.project.id, { status: "clarifying" });
  emit(input.project, card);
  return card;
}

export type ResolveQuestionsResult =
  | { ok: true; card: QuestionsCard; leadMessage: string }
  | { ok: false; error: string };

/** What the UI submits (§4.15.2): `usedDefault` is computed server-side, never sent. */
export type QuestionAnswerInput = Omit<QuestionAnswer, "usedDefault"> & { usedDefault?: boolean };

/**
 * Answer or skip one pending card (§4.15.2 `POST /questions/:cardId` with
 * `{answers}` or `{skip: true}`). `usedDefault` is computed server-side by
 * comparing the submitted options with the question's defaults.
 */
export function resolveQuestionsCard(
  project: AppProject,
  cardId: string,
  outcome: { answers: QuestionAnswerInput[] } | { skip: true },
): ResolveQuestionsResult {
  void project; // the card row carries the project binding; store.ts enforces it
  const card = getQuestionCard(cardId);
  if (!card) return { ok: false, error: "not_found" };
  if (card.status !== "pending") return { ok: false, error: "already_resolved" };
  if ("skip" in outcome) {
    const stored = answerQuestion(cardId, { skip: true });
    if (!stored || "error" in stored) return { ok: false, error: stored && "error" in stored ? stored.error : "not_found" };
    return {
      ok: true,
      card: stored,
      leadMessage: "The user skipped the questions. Use your defaults and record each one in keyDecisions with source \"default\".",
    };
  }
  for (const a of outcome.answers) {
    const q = card.questions.find((x) => x.id === a.questionId);
    if (!q) return { ok: false, error: `unknown question ${a.questionId}` };
    const known = new Set(q.options.map((o) => o.id));
    if (a.optionIds.some((id: string) => !known.has(id))) return { ok: false, error: `answer for ${a.questionId} names an option that does not exist` };
  }
  const answers: QuestionAnswer[] = outcome.answers.map((a) => {
    const q = card.questions.find((x) => x.id === a.questionId)!;
    const usedDefault =
      a.usedDefault ?? (JSON.stringify([...a.optionIds].sort()) === JSON.stringify([...q.defaultOptionIds].sort()) && !a.otherText);
    return { ...a, usedDefault };
  });
  const stored = answerQuestion(cardId, { answers });
  if (!stored) return { ok: false, error: "not_found" };
  if ("error" in stored) return { ok: false, error: stored.error };
  return { ok: true, card: stored, leadMessage: questionsAnsweredMessage(card, answers) };
}

// ----------------------------------------------------------------------------
// §4.2.2 Plan document validation, drafts, decisions
// ----------------------------------------------------------------------------

export interface PlanValidation {
  ok: boolean;
  problems: string[];
  doc: PlanDocument | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Kahn's-algorithm cycle check over task deps (§4.2.2 rule 1). */
export function planHasCycle(tasks: PlanDocument["tasks"]): boolean {
  const indeg = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const t of tasks) {
    indeg.set(t.id, (indeg.get(t.id) ?? 0) + 0);
    edges.set(t.id, edges.get(t.id) ?? []);
  }
  for (const t of tasks) {
    for (const d of t.deps) {
      if (!indeg.has(d)) continue;
      indeg.set(t.id, (indeg.get(t.id) ?? 0) + 1);
      edges.get(d)!.push(t.id);
    }
  }
  const queue = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    seen += 1;
    for (const next of edges.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  return seen !== tasks.length;
}

/**
 * Validate a PlanDocument (§4.2.2 rule 1): 1 to 20 tasks, every dep exists, no
 * cycles, 1 to 6 acceptance statements per task, every keyDecision source set.
 */
export function validatePlanDocument(raw: unknown): PlanValidation {
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, problems: ["plan must be a JSON object"], doc: null };
  const v = raw as Record<string, unknown>;
  const strList = (x: unknown, what: string): string[] =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : (problems.push(`${what} must be a list of strings`), []);
  const title = typeof v.title === "string" ? v.title.trim() : "";
  if (!title) problems.push("title is required");
  const overview = typeof v.overview === "string" ? v.overview.trim() : "";
  if (!overview) problems.push("overview is required (1 to 4 sentences)");
  const scenario = v.scenario as PlanDocument["scenario"];
  if (!SCENARIOS.includes(scenario)) problems.push(`scenario must be one of ${SCENARIOS.join(", ")}`);
  if (v.templateId !== "web-app") problems.push("templateId must be \"web-app\"");
  const features = strList(v.features, "features").filter((f): f is TemplateFeatureId => FEATURES.includes(f as TemplateFeatureId));
  if (strList(v.features, "features").length !== features.length) problems.push("features may only contain \"fullstack\" and \"seo-blog\"");
  const keyDecisions = Array.isArray(v.keyDecisions) ? v.keyDecisions : [];
  for (const [i, d] of keyDecisions.entries()) {
    const dec = d as Record<string, unknown>;
    if (typeof dec !== "object" || dec === null || typeof dec.decision !== "string" || !dec.decision.trim()) problems.push(`keyDecision ${i + 1} needs a decision`);
    if (typeof dec.rationale !== "string" || !dec.rationale.trim()) problems.push(`keyDecision ${i + 1} needs a rationale`);
    if (dec.source !== "user" && dec.source !== "default" && dec.source !== "inferred") problems.push(`keyDecision ${i + 1} source must be user, default or inferred`);
    if (typeof dec.date !== "string" || !DATE_RE.test(dec.date)) problems.push(`keyDecision ${i + 1} date must be YYYY-MM-DD`);
  }
  const tasksRaw = Array.isArray(v.tasks) ? v.tasks : [];
  if (tasksRaw.length < 1 || tasksRaw.length > 20) problems.push("a plan carries 1 to 20 tasks");
  const ids = new Set<string>();
  const tasks: PlanDocument["tasks"] = [];
  for (const [i, t] of tasksRaw.entries()) {
    const task = t as Record<string, unknown>;
    if (typeof task !== "object" || task === null) { problems.push(`task ${i + 1} must be an object`); continue; }
    const id = typeof task.id === "string" ? task.id : "";
    if (!TASK_ID_RE.test(id)) problems.push(`task ${i + 1} id must look like T1..T20`);
    else if (ids.has(id)) problems.push(`task id ${id} is used twice`);
    else ids.add(id);
    if (typeof task.title !== "string" || !task.title.trim()) problems.push(`task ${id || i + 1} needs a title`);
    const role = task.role as AppRoleId;
    if (!(role in APP_ROLES)) problems.push(`task ${id || i + 1} role must be a Loam role`);
    const acceptance = strList(task.acceptance, `task ${id || i + 1} acceptance`);
    if (acceptance.length < 1 || acceptance.length > 6) problems.push(`task ${id || i + 1} needs 1 to 6 acceptance statements`);
    const deps = strList(task.deps, `task ${id || i + 1} deps`);
    tasks.push({
      id: id || `T${i + 1}`,
      title: typeof task.title === "string" ? task.title : "",
      role,
      deps,
      status: "pending",
      acceptance,
    });
  }
  for (const t of tasks) {
    for (const d of t.deps) if (!ids.has(d)) problems.push(`task ${t.id} depends on unknown task ${d}`);
  }
  if (tasks.length > 0 && ids.size === tasks.length && planHasCycle(tasks)) problems.push("task dependencies contain a cycle");
  if (problems.length > 0) return { ok: false, problems, doc: null };
  const doc: PlanDocument = {
    title,
    overview,
    scenario,
    templateId: "web-app",
    features,
    keyDecisions: keyDecisions.map((d) => {
      const dec = d as PlanDocument["keyDecisions"][number];
      return { date: dec.date, decision: dec.decision, rationale: dec.rationale, source: dec.source };
    }),
    constraints: strList(v.constraints, "constraints"),
    requirements: strList(v.requirements, "requirements"),
    userStories: strList(v.userStories, "userStories"),
    tasks,
  };
  return { ok: true, problems: [], doc };
}

/** Store one validated plan as the next revision (revisions start at 1; a new draft supersedes the previous one — store rule §4.2.2 rule 2). */
export function createPlanDraft(project: AppProject, runId: string, doc: PlanDocument): PlanDraft {
  const draft = insertPlanDraft({ projectId: project.id, runId, doc });
  updateAppProjectRow(project.id, { status: "awaiting_approval" });
  return draft;
}

export type PlanDecisionResult =
  | { ok: true; draft: PlanDraft; resumeInstruction?: string }
  | { ok: false; error: "stale_revision"; latest: number }
  | { ok: false; error: string; latest?: never };

/**
 * Approve a revision (§4.2.2 rule 3): a `revision` that is not the latest draft
 * revision returns the 409 contract `{error: "stale_revision", latest}`. On the
 * latest revision the draft is marked approved and the context phase runs:
 * `writeAllFromPlan` renders PROJECT/PROGRESS/ARCHITECTURE atomically.
 */
export function approvePlanDraft(project: AppProject, revision: number): PlanDecisionResult {
  const latest = latestPlanDraft(project.id);
  if (!latest) return { ok: false, error: "not_found" };
  if (latest.revision !== revision) return { ok: false, error: "stale_revision", latest: latest.revision };
  if (latest.status !== "draft") return { ok: false, error: "already_decided" };
  const decided = decidePlanDraft(latest.id, { kind: "approve" });
  if (!decided) return { ok: false, error: "not_found" };
  if ("error" in decided) return { ok: false, error: decided.error };
  try {
    writeAllFromPlan(project.workspaceDir, decided.doc);
  } catch {
    // §4.2.2 rule 6: a failed context write stops the run with an error card;
    // stopping the run belongs to the engine (W3-c), so surface the error here.
    return { ok: false, error: "context_write_failed" };
  }
  updateAppProjectRow(project.id, { status: "building" });
  return { ok: true, draft: decided };
}

/**
 * Decline the latest draft (§4.2.2 rule 4): mark `declined`, keep the reason
 * (at most 1,000 characters, enforced by the store) and return the resume
 * instruction that carries the user's reason inside fenced markers as
 * untrusted input.
 */
export function declinePlanDraft(project: AppProject, reason: string): PlanDecisionResult {
  const latest = latestPlanDraft(project.id);
  if (!latest) return { ok: false, error: "not_found" };
  if (latest.status !== "draft") return { ok: false, error: "already_decided" };
  const trimmed = reason.trim().slice(0, 1_000);
  const decided = decidePlanDraft(latest.id, { kind: "decline", reason: trimmed });
  if (!decided) return { ok: false, error: "not_found" };
  if ("error" in decided) return { ok: false, error: decided.error };
  return { ok: true, draft: decided, resumeInstruction: planDeclinedMessage(decided.doc, trimmed) };
}

/**
 * User edit path (§4.2.2 rule 5): validate the edited doc, mark every decision
 * that differs from the previous revision `source: "user"`, and store it as the
 * next revision awaiting approval again.
 */
export function editPlanDraft(project: AppProject, runId: string, raw: unknown): PlanDecisionResult & { draft?: PlanDraft } {
  const previous = latestPlanDraft(project.id);
  const validation = validatePlanDocument(raw);
  if (!validation.ok || !validation.doc) return { ok: false, error: validation.problems.join("; ") };
  const doc = validation.doc;
  if (previous) {
    const oldPairs = new Set(previous.doc.keyDecisions.map((d) => `${d.decision}\u0000${d.rationale}`));
    doc.keyDecisions = doc.keyDecisions.map((d) => (oldPairs.has(`${d.decision}\u0000${d.rationale}`) ? d : { ...d, source: "user" as const }));
  } else {
    doc.keyDecisions = doc.keyDecisions.map((d) => ({ ...d, source: "user" as const }));
  }
  const draft = createPlanDraft(project, runId, doc);
  return { ok: true, draft };
}

// ----------------------------------------------------------------------------
// §4.2.4 Assignment + finish
// ----------------------------------------------------------------------------

export type AssignmentResult =
  | { ok: true; assignment: AppTaskAssignment }
  | { ok: false; error: string };

/**
 * app_task_create's logic: only after the plan is approved, only for a role in
 * `assignableRoles()` for this plan, only for task ids the approved plan knows.
 */
export function createAssignmentForPlan(
  project: AppProject,
  input: { role: AppRoleId; planTaskIds: string[]; brief: string },
): AssignmentResult {
  const latest = latestPlanDraft(project.id);
  if (!latest || latest.status !== "approved") return { ok: false, error: "plan not approved" };
  const hasBackend = latest.doc.features.includes("fullstack");
  const allowed = assignableRoles(project.features, latest.doc.tasks.length, hasBackend);
  if (!allowed.includes(input.role)) return { ok: false, error: `role ${input.role} is not assignable for this plan` };
  const known = new Set(latest.doc.tasks.map((t) => t.id));
  for (const id of input.planTaskIds) if (!known.has(id)) return { ok: false, error: `unknown plan task ${id}` };
  const assignment: AppTaskAssignment = {
    id: newAppRowId("as_"),
    projectId: project.id,
    planDraftId: latest.id,
    planTaskIds: [...input.planTaskIds],
    role: input.role,
    brief: input.brief,
    status: "queued",
    report: null,
    startedAt: null,
    finishedAt: null,
  };
  insertAssignment(assignment);
  updateAppProjectRow(project.id, { status: "building" });
  return { ok: true, assignment };
}

/**
 * app_task_finish's logic: mark the assignment done/failed with the summary as
 * its report, and set the covered plan tasks to the same outcome inside the
 * approved draft's doc (the Planner panel reads those statuses).
 */
export function finishAssignmentForPlan(
  project: AppProject,
  input: { assignmentId: string; outcome: "done" | "failed"; summary: string },
): AssignmentResult {
  const a = getAssignment(input.assignmentId);
  if (!a || a.projectId !== project.id) return { ok: false, error: `unknown assignment ${input.assignmentId}` };
  if (a.status !== "queued" && a.status !== "running") return { ok: false, error: `assignment ${input.assignmentId} is already ${a.status}` };
  const updated = updateAssignment(input.assignmentId, { status: input.outcome, report: input.summary });
  if (!updated) return { ok: false, error: `unknown assignment ${input.assignmentId}` };
  if (a.planDraftId) {
    const draft = latestPlanDraft(project.id);
    // Only the approved draft that produced the assignment carries these tasks.
    if (draft && draft.id === a.planDraftId) {
      const doc: PlanDocument = { ...draft.doc, tasks: draft.doc.tasks.map((t) => (a.planTaskIds.includes(t.id) ? { ...t, status: input.outcome } : t)) };
      updatePlanDraftDoc(draft.id, doc);
    }
  }
  return { ok: true, assignment: updated };
}

// ----------------------------------------------------------------------------
// Lead turns: the model-driven steps with an injected executor (W3-c wires the
// real chatWithRouting; routes and tests can drive these directly)
// ----------------------------------------------------------------------------

export interface LeadExecutor {
  /** One Lead model call with LEAD_SYSTEM plus the given messages. */
  call(input: { messages: Array<{ role: "system" | "user" | "assistant"; content: string }> }): Promise<{ text: string }>;
}

export type LeadClarifyOutcome =
  | { kind: "questions_card"; card: QuestionsCard; problems?: string[] }
  | { kind: "no_questions" }
  | { kind: "skip_questions"; problems: string[] };

/**
 * STEP clarify (§4.2.1): ask the Lead for QuestionSpec JSON, validate, re-ask
 * once with the problems, then fall back to "skip questions".
 */
export async function runLeadClarify(deps: {
  project: AppProject;
  runId: string;
  userPrompt: string;
  executor: LeadExecutor;
  emit?: QuestionCardEmitter;
}): Promise<LeadClarifyOutcome> {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: LEAD_SYSTEM },
    { role: "user", content: `${deps.userPrompt}\n\nSTEP clarify: output JSON only.` },
  ];
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await deps.executor.call({ messages });
    const parsed = extractJson(res.text);
    // `{"questions": []}` is the valid "nothing important is missing" reply (§4.2.1).
    const empty =
      typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>).questions)
      && ((parsed as Record<string, unknown>).questions as unknown[]).length === 0;
    if (empty) return { kind: "no_questions" };
    if (parsed !== null) {
      const v = validateQuestionSpecs(parsed);
      if (v.ok) {
        const card = createQuestionsCard({ project: deps.project, runId: deps.runId, title: v.title, questions: v.questions }, deps.emit);
        return { kind: "questions_card", card };
      }
      problems = v.problems;
    } else {
      problems = ["reply was not JSON"];
    }
    messages.push({ role: "assistant", content: res.text });
    messages.push({ role: "user", content: `Your questions JSON is invalid: ${problems.join("; ")}. Reply with the corrected JSON only.` });
  }
  return { kind: "skip_questions", problems };
}

export type LeadPlanOutcome =
  | { kind: "plan_draft"; draft: PlanDraft; problems?: string[] }
  | { kind: "invalid_plan"; problems: string[] };

/** STEP plan (§4.2.2): ask the Lead for a PlanDocument, validate, re-ask once. */
export async function runLeadPlan(deps: {
  project: AppProject;
  runId: string;
  userPrompt: string;
  executor: LeadExecutor;
  /** Extra instruction appended to the first ask (answers, decline reason). */
  contextMessage?: string;
}): Promise<LeadPlanOutcome> {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: LEAD_SYSTEM },
    { role: "user", content: [deps.userPrompt, deps.contextMessage, "STEP plan: output one plan as JSON matching PlanDocument. Keep it as small as the request allows."].filter(Boolean).join("\n\n") },
  ];
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await deps.executor.call({ messages });
    const parsed = extractJson(res.text);
    if (parsed !== null) {
      const v = validatePlanDocument(parsed);
      if (v.ok && v.doc) {
        const draft = createPlanDraft(deps.project, deps.runId, v.doc);
        return { kind: "plan_draft", draft };
      }
      problems = v.problems;
    } else {
      problems = ["reply was not JSON"];
    }
    messages.push({ role: "assistant", content: res.text });
    messages.push({ role: "user", content: `Your plan JSON is invalid: ${problems.join("; ")}. Reply with the corrected plan JSON only.` });
  }
  return { kind: "invalid_plan", problems };
}

export interface RunLeadTurnDeps {
  project: AppProject;
  runId: string;
  userPrompt: string;
  executor: LeadExecutor;
  /** Answers or skip result of this run's questions card, when one was answered. */
  questionsMessage?: string;
  /** Decline-resume instruction when the previous revision was declined. */
  declineMessage?: string;
  emit?: QuestionCardEmitter;
}

export type LeadTurnOutcome = LeadClarifyOutcome | LeadPlanOutcome;

/**
 * One Goal-mode Lead turn over the clarify → plan steps (engine-facing entry
 * point, MISSING §4.2). The W3-c engine calls this after the scaffold phase and
 * drives the remaining phases (approve blocks on the user; assign runs through
 * app_task_create; finish through app_task_finish) with the same executor.
 */
export async function runLeadTurn(deps: RunLeadTurnDeps): Promise<LeadTurnOutcome> {
  const clarify = await runLeadClarify(deps);
  if (clarify.kind !== "no_questions" && clarify.kind !== "skip_questions") return clarify;
  // No card is pending (or the model was told to skip): go straight to planning.
  // A pending card blocks the turn at the engine level; here the answered card's
  // message (or the skip note) is folded into the plan ask.
  return runLeadPlan({
    project: deps.project,
    runId: deps.runId,
    userPrompt: deps.userPrompt,
    executor: deps.executor,
    contextMessage: deps.questionsMessage ?? (clarify.kind === "skip_questions" ? "The user skipped the questions; record your defaults honestly." : undefined),
  });
}
