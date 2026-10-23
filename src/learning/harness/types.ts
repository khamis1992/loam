// Harness2 (correction & experience learning) shared types.
// Reference: BUILD_SPEC .h2-ref/BUILD_SPEC.md section 6.1 (H1). No code is copied
// from the upstream Harness2 project; the idea is re-implemented independently.
export type LessonSource = "correction" | "critic" | "selfplay";
export type Confidence = "low" | "medium" | "high";

export interface CorrectionEvent {
  id: string;               // "cor_<base36>"
  agentId: string | null;
  taskId: string;
  domain: string;           // see domainOf()
  priorAssistant: string;   // last assistant text before correction (<= 4000 chars)
  userText: string;         // the correcting message (<= 4000 chars)
  at: string;               // ISO
}

export interface Lesson {
  id: string;               // "les_<base36>"
  agentId: string | null;   // null = global
  domain: string;
  source: LessonSource;
  cue: string;              // WHEN this applies (1 sentence)
  lesson: string;           // WHAT to do (1-2 sentences, imperative)
  evidence: string;         // WHY we believe it (quote/paraphrase of episode)
  confidence: Confidence;
  sourceRef: string;        // correction id / task id
  uses: number;
  createdAt: string;
  lastUsedAt?: string;
  disabled?: boolean;
  dim?: number;
  vector?: string;          // base64 normalized Float32 (same codec as memory/embeddings.ts)
}

export interface DistillResult { cue: string; lesson: string; evidence: string; confidence: Confidence }

/** Mirror of Harness2 rule [O library.py::has_experience]: all three fields must be non-empty. */
export function isCompleteLesson(d: Partial<DistillResult> | null | undefined): d is DistillResult {
  return !!d && [d.cue, d.lesson, d.evidence].every((s) => typeof s === "string" && s.trim().length > 0);
}

/** Domain key: one token, never a path (analogue of library.py::domain_dir). */
export function domainOf(raw: string | undefined | null): string {
  const s = (raw ?? "").trim().toLowerCase().replace(/\s*[\/\\]\s*/g, "__").replace(/\s+/g, "-");
  return s || "general";
}
