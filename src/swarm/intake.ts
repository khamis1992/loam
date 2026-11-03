/**
 * Intake (clarify + assess) and plan approval for company runs
 * (BUILD_SPEC §6.5, proposal 2).
 *
 * Both are durable user gates: the engine pauses the run (status
 * "interrupted" with a pending gate recorded on the snapshot), releases its
 * lane, and resumes from persisted checkpoints when the user answers through
 * the origin-checked swarm endpoints. Nothing here calls a model; the intake
 * stage's model answer is parsed by parseIntake.
 */
import type { AskUserQuestion } from "../tools/askUserStore.js";
import { needsAskUser } from "../tools/askUserGate.js";

export type IntakeVerdict = "proceed" | "clarify" | "stop";
export const MAX_INTAKE_QUESTIONS = 3;
export const MAX_PLAN_REVISIONS = 3;
export const MAX_ANSWER_CHARS = 4000;

export interface IntakeAssessment {
  verdict: IntakeVerdict;
  summary: string;
  questions: AskUserQuestion[];
  risks: string[];
  assumptions: string[];
  /** True when the deterministic vague-request classifier also fired. */
  vague: boolean;
}

export interface IntakeGate {
  status: "pending" | "answered" | "skipped";
  assessment: IntakeAssessment;
  askedAt: string;
  answeredAt?: string;
  answers?: Record<string, string>;
  note?: string;
  decision?: "continue" | "stop";
}

export interface ApprovalGate {
  status: "pending" | "approved";
  round: number;
  revisions: number;
  summary: PlanSummary;
  requestedAt: string;
  decidedAt?: string;
}

export interface PlanSummary {
  effort: string;
  requirements: Array<{ id: string; text: string }>;
  requirementCount: number;
  decisions: string[];
  tasks: Array<{ id: string; title: string; files: string[]; dependsOn: string[] }>;
  verificationCommand: string | null;
  stages: string[];
}

const JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/;

function firstJsonObject(text: string): unknown | null {
  const fenced = JSON_FENCE.exec(text);
  const source = fenced ? fenced[1]! : text;
  const start = source.indexOf("{"); const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(source.slice(start, end + 1)); } catch { return null; }
}

const strings = (value: unknown, max: number, len = 300): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map(v => v.trim().slice(0, len)).slice(0, max) : [];

/**
 * Parses the intake stage answer. An unparseable answer degrades to
 * "proceed" (the run is never blocked by a formatting slip), but the
 * deterministic vague-request classifier can still raise questions.
 */
export function parseIntake(text: string, brief: string): IntakeAssessment {
  const raw = firstJsonObject(text) as Record<string, unknown> | null;
  const verdictRaw = typeof raw?.verdict === "string" ? raw.verdict.trim().toLowerCase() : "proceed";
  let verdict: IntakeVerdict = verdictRaw === "clarify" || verdictRaw === "stop" ? verdictRaw : "proceed";
  const questions: AskUserQuestion[] = [];
  if (Array.isArray(raw?.questions)) {
    for (const item of raw!.questions as unknown[]) {
      if (questions.length >= MAX_INTAKE_QUESTIONS) break;
      const q = typeof item === "string" ? { prompt: item } : (typeof item === "object" && item !== null ? item as Record<string, unknown> : null);
      const prompt = typeof q?.prompt === "string" ? q.prompt.trim().slice(0, 500) : "";
      if (!prompt) continue;
      const options = strings(q?.options, 5, 120);
      questions.push({ id: `q${questions.length + 1}`, prompt, ...(options.length ? { options } : {}) });
    }
  }
  const trigger = needsAskUser(brief);
  if (trigger && verdict === "proceed") {
    verdict = "clarify";
    for (const q of trigger.questions) {
      if (questions.length >= MAX_INTAKE_QUESTIONS) break;
      questions.push({ ...q, id: `q${questions.length + 1}` });
    }
  }
  if (verdict === "clarify" && !questions.length) verdict = "proceed";
  return {
    verdict,
    summary: typeof raw?.summary === "string" ? raw.summary.trim().slice(0, 1200) : "",
    questions,
    risks: strings(raw?.risks, 6),
    assumptions: strings(raw?.assumptions, 8),
    vague: Boolean(trigger),
  };
}

/** Validates the user's answer payload from the clarify endpoint. */
export function parseClarifyAnswer(body: unknown, gate: IntakeGate): { answers: Record<string, string>; note: string; decision: "continue" | "stop" } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "Expected an object" };
  const b = body as Record<string, unknown>;
  const decision = b.decision === "stop" ? "stop" : "continue";
  const note = typeof b.note === "string" ? b.note.trim().slice(0, MAX_ANSWER_CHARS) : "";
  const answers: Record<string, string> = {};
  const rawAnswers = typeof b.answers === "object" && b.answers !== null && !Array.isArray(b.answers) ? b.answers as Record<string, unknown> : {};
  for (const q of gate.assessment.questions) {
    const value = rawAnswers[q.id];
    if (typeof value === "string" && value.trim()) answers[q.id] = value.trim().slice(0, MAX_ANSWER_CHARS);
  }
  if (decision === "continue" && gate.assessment.verdict === "clarify" && !Object.keys(answers).length && !note) return { error: "Answer at least one question or add a note" };
  return { answers, note, decision };
}

/** The clarification block every later stage receives as project data. */
export function clarificationText(gate: IntakeGate): string {
  const lines: string[] = [];
  if (gate.assessment.summary) lines.push(`Intake summary: ${gate.assessment.summary}`);
  for (const q of gate.assessment.questions) {
    const a = gate.answers?.[q.id];
    lines.push(`- ${q.prompt} → ${a ?? "(not answered: state your assumption explicitly)"}`);
  }
  if (gate.note) lines.push(`User note: ${gate.note}`);
  if (gate.assessment.assumptions.length) lines.push(`Assumptions to confirm in the spec: ${gate.assessment.assumptions.join("; ")}`);
  if (gate.assessment.risks.length) lines.push(`Risks raised at intake: ${gate.assessment.risks.join("; ")}`);
  return lines.join("\n");
}

/** Validates the approval endpoint payload. */
export function parseApprovalDecision(body: unknown): { decision: "approve" | "revise" | "cancel"; feedback: string } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "Expected an object" };
  const b = body as Record<string, unknown>;
  if (b.decision !== "approve" && b.decision !== "revise" && b.decision !== "cancel") return { error: "decision must be approve, revise or cancel" };
  const feedback = typeof b.feedback === "string" ? b.feedback.trim().slice(0, MAX_ANSWER_CHARS) : "";
  if (b.decision === "revise" && !feedback) return { error: "A revision needs feedback describing what to change" };
  return { decision: b.decision, feedback };
}

/** Extracts the verification command an architecture answer names, if any. */
export function verificationFromText(text: string): string | null {
  const match = /(?:verification(?: command)?|verify(?: with)?|أمر التحقق)\s*[:：]?\s*`([^`\n]{3,120})`/i.exec(text) ?? /`((?:npm (?:run )?test|node --test|npx vitest|npx jest|pytest)[^`\n]{0,100})`/.exec(text);
  return match ? match[1]!.trim() : null;
}

/** Renders the approval card text (Arabic headings, English identifiers). */
export function renderPlanSummary(plan: PlanSummary): string {
  const lines = [
    `حجم العملية: ${plan.effort}`,
    `المتطلبات: ${plan.requirementCount}`,
    ...plan.requirements.slice(0, 12).map(r => `- ${r.id}: ${r.text}`),
    plan.tasks.length ? `المهام (${plan.tasks.length}):` : "التنفيذ: مرحلة واحدة",
    ...plan.tasks.map(t => `- ${t.id} ${t.title} — ${t.files.join(", ")}${t.dependsOn.length ? ` (بعد ${t.dependsOn.join(", ")})` : ""}`),
    `أمر التحقق: ${plan.verificationCommand ?? "يحدده التنفيذ"}`,
    ...(plan.decisions.length ? ["القرارات:", ...plan.decisions.slice(-8).map(d => `- ${d}`)] : []),
    `المراحل: ${plan.stages.join(" → ")}`,
  ];
  return lines.join("\n");
}
