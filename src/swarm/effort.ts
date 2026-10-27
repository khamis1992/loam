/**
 * Effort routing for company runs (BUILD_SPEC §6.1, proposal 1).
 *
 * A deterministic, model-free classifier that sizes a brief before any stage
 * runs, so a small, fully specified request takes the single-agent path and
 * only genuinely large work pays for the specialist pipeline. The score is a
 * transparent sum of named signals; every decision records its reasons so the
 * effort_profile event explains exactly why a tier was chosen.
 */

/** The three pipeline sizes the engine can build. */
export type SwarmEffort = "solo" | "lite" | "full";
/** What a caller may request: an explicit tier or engine routing. */
export type EffortRequest = "auto" | SwarmEffort;

export const EFFORT_REQUESTS: readonly EffortRequest[] = ["auto", "solo", "lite", "full"];

/** Score at or below which a brief routes to the single-agent path. */
export const SOLO_MAX_SCORE = 3.5;
/** Score at or below which a brief routes to the lite pipeline. */
export const LITE_MAX_SCORE = 7;

/** Product domains whose presence signals cross-cutting work (each adds weight). */
const DOMAIN_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["auth", ["login", "sign in", "signup", "sign up", "authentication", "auth", "password", "roles", "permissions", "تسجيل الدخول", "مصادقة", "كلمة المرور", "صلاحيات", "أدوار"]],
  ["payments", ["payment", "checkout", "stripe", "invoice", "billing", "subscription", "دفع", "فاتورة", "اشتراك"]],
  ["database", ["database", "postgres", "mysql", "sqlite", "mongodb", "supabase", "prisma", "قاعدة بيانات", "قاعدة البيانات"]],
  ["realtime", ["websocket", "real-time", "realtime", "live updates", "push notifications", "تحديث مباشر", "لحظي"]],
  // "reports" alone is excluded: briefs often say "keep reports short" (the compare brief did, and scored lite).
  ["admin", ["admin", "dashboard", "back office", "analytics", "reporting", "reports page", "لوحة تحكم", "لوحة التحكم", "إحصائيات"]],
  ["integrations", ["webhook", "third-party", "oauth", "integration", "external api", "تكامل", "واجهة خارجية"]],
  ["files", ["upload", "file storage", "attachments", "csv export", "pdf export", "رفع ملفات", "مرفقات", "تصدير"]],
  ["messaging", ["email", "sms", "notification", "chat", "بريد إلكتروني", "إشعارات", "رسائل"]],
  ["multitenant", ["multi-tenant", "tenants", "organizations", "teams", "مؤسسات", "فرق العمل"]],
];

const SCREEN_RE = /\b(?:page|screen|view)s?\b|صفحة|صفحات|شاشة|شاشات/gi;
const FILE_RE = /\b[\w./-]+\.(?:c?js|mjs|ts|tsx|jsx|html|css|py|json|go|rs)\b/gi;
const VERIFY_RE = /node\s+--test|npm\s+(?:run\s+)?test|pytest|vitest|jest|go\s+test|cargo\s+test/i;
const FEATURE_RE = /\bplus\b|\balso\b|\bas well as\b|[;؛]|^\s*(?:[-*•]|\d+[.)])\s+|إضافة إلى|بالإضافة/gim;

/** Raw, explainable measurements of one brief. */
export interface EffortSignals {
  chars: number;
  features: number;
  domains: string[];
  screens: number;
  namedFiles: number;
  explicitVerification: boolean;
  seeded: boolean;
  baseRun: boolean;
}

/** The routing outcome recorded on the run snapshot and in the effort_profile event. */
export interface EffortDecision {
  effort: SwarmEffort;
  requested: EffortRequest;
  score: number;
  signals: EffortSignals;
  reasons: string[];
}

/** Measures the brief without any model call. Pure and deterministic. */
export function measureBrief(brief: string, ctx: { seeded?: boolean; baseRun?: boolean } = {}): EffortSignals {
  const text = brief.trim();
  const lower = text.toLowerCase();
  const domains = DOMAIN_KEYWORDS.filter(([, words]) => words.some(word => lower.includes(word))).map(([name]) => name);
  const features = 1 + (text.match(FEATURE_RE)?.length ?? 0);
  const screens = (text.match(SCREEN_RE) ?? []).length;
  const namedFiles = new Set((text.match(FILE_RE) ?? []).map(match => match.toLowerCase())).size;
  return {
    chars: text.length,
    features: Math.min(features, 20),
    domains,
    screens: Math.min(screens, 10),
    namedFiles,
    explicitVerification: VERIFY_RE.test(text),
    seeded: ctx.seeded === true,
    baseRun: ctx.baseRun === true,
  };
}

/** Converts signals into a score. Every weight is named in the reasons list. */
export function scoreSignals(signals: EffortSignals): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const length = signals.chars / 400;
  score += length; reasons.push(`length ${signals.chars} chars → +${length.toFixed(2)}`);
  const features = signals.features * 0.5;
  score += features; reasons.push(`${signals.features} feature clauses → +${features.toFixed(2)}`);
  if (signals.domains.length) {
    const domains = signals.domains.length * 2;
    score += domains; reasons.push(`domains [${signals.domains.join(", ")}] → +${domains}`);
  }
  if (signals.screens > 1) {
    const screens = signals.screens - 1;
    score += screens; reasons.push(`${signals.screens} screens/pages → +${screens}`);
  }
  if (signals.namedFiles > 0 && signals.explicitVerification) {
    score -= 1.5; reasons.push("fully specified (named files and an explicit verification command) → -1.5");
  }
  if (signals.baseRun) reasons.push("continues a delivered run (baseRun): no extra weight, the living spec carries context");
  if (signals.seeded) reasons.push("seeded repository: no extra weight, the repo stage analyses it when present");
  return { score: Math.round(score * 100) / 100, reasons };
}

/** Routes a brief to a pipeline size. An explicit request always wins. */
export function classifyEffort(brief: string, ctx: { requested?: EffortRequest; seeded?: boolean; baseRun?: boolean } = {}): EffortDecision {
  const requested: EffortRequest = ctx.requested ?? "auto";
  const signals = measureBrief(brief, ctx);
  const { score, reasons } = scoreSignals(signals);
  if (requested !== "auto") return { effort: requested, requested, score, signals, reasons: [`explicit request: ${requested}`, ...reasons] };
  const effort: SwarmEffort = score <= SOLO_MAX_SCORE ? "solo" : score <= LITE_MAX_SCORE ? "lite" : "full";
  reasons.push(`score ${score} → ${effort} (solo ≤ ${SOLO_MAX_SCORE}, lite ≤ ${LITE_MAX_SCORE}, else full)`);
  return { effort, requested, score, signals, reasons };
}

/** Validates an untrusted effort value from the HTTP body or a tool call. */
export function parseEffortRequest(value: unknown): EffortRequest | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (EFFORT_REQUESTS as readonly string[]).includes(value)) return value as EffortRequest;
  throw new Error(`Invalid effort: expected one of ${EFFORT_REQUESTS.join(", ")}`);
}
