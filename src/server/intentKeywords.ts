/**
 * Layer 1 of the intent router (UI overhaul W-U2): deterministic keyword
 * scoring over the user's free-text request. No model, no I/O — a pure
 * function so the composer can fall back to it offline and the tests can pin
 * its behavior exactly.
 *
 * Seeds are Arabic + English phrases per mode id, taken from the real catalog
 * (LOAM_MODES). Every distinct seed that occurs in the normalized text adds
 * one point; the strongest mode wins and ties keep the earlier entry in the
 * seed table (deterministic). A score below KEYWORD_MIN_SCORE, or no match at
 * all, routes to "ask" (استكشف) rather than guessing — a single weak word like
 * "app" or "كود" must never steal the route.
 */
import { LOAM_MODES } from "../modes/catalog.js";

/** A request needs at least this many distinct seed hits to leave "ask". */
export const KEYWORD_MIN_SCORE = 2;

/**
 * Arabic + English seeds per mode id. Keys are validated against the catalog
 * at load time (see MODE_IDS below), so a renamed mode id silently drops out
 * instead of producing a decision the engine would refuse.
 *
 * Seeds are written in their normalized spelling (no diacritics, bare alef,
 * ya for alef maqsura) because normalizeText() strips those variants from the
 * input before matching; prefer short stems ("ثغر", "برمج", "اتمت") so word
 * variants match without inflating the score.
 */
const SEEDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["build", [
    "ابن لي", "ابني", "بناء", "طور", "انشئ تطبيق", "انشئ موقع", "انشئ صفحة",
    "تطبيق ويب", "صفحة ويب", "برمج", "كود", "اصلاح", "اصلح",
    "build", "develop", "implement", "website", "web app", "landing page", "refactor", "compile",
  ]],
  ["research", [
    "ابحث", "بحث", "مصادر", "قارن", "دراسة", "استقصاء", "تحقيق",
    "research", "search", "sources", "compare", "investigate", "browse", "look up", "literature",
  ]],
  ["write", [
    "اكتب", "كتابة", "مستند", "مقال", "عرض تقديمي", "عرضا تقديميا", "شرائح", "رسالة", "مسودة", "سيرة ذاتية",
    "write", "document", "presentation", "slides", "pptx", "docx", "essay", "letter", "draft", "memo",
  ]],
  ["data", [
    "حلل", "تحليل بيانات", "بيانات", "جدول", "جداول", "خلايا", "رسم بياني", "مؤشرات",
    "excel", "csv", "spreadsheet", "dataset", "chart", "pivot", "statistics", "analysis",
  ]],
  ["media", [
    "صمم", "تصميم", "مشهد", "مجسم", "ثلاثي الابعاد", "فيديو", "موسيقي", "لوجو", "بوستر",
    "3d", "render", "scene", "video", "music", "logo", "poster", "glb", "thumbnail",
  ]],
  ["security", [
    "ثغر", "اختراق", "فحص امني", "تقرير امني", "فحص ترويسات",
    "pentest", "vulnerability", "security scan", "security audit", "sast", "sarif", "cve", "exploit", "red team",
  ]],
  ["legal", [
    "قانون", "عقد", "دعوي", "دعاوي", "محكمة", "تشريع", "مذكرة", "مرافعة",
    "legal", "statute", "contract review", "litigation", "court", "qatar law",
  ]],
  ["reverse-engineer", [
    "هندسة عكسية", "عكس هندسي", "فك تشفير", "تحليل ثنائي", "تحليل تطبيق",
    "reverse engineer", "reverse engineering", "decompile", "disassemble", "binary analysis", "asar", "apk", "firmware",
  ]],
  ["devflow", [
    "دورة تطوير", "مشكلة github", "pull request", "pull-request", "فرع جديد", "فرعا جديدا", "سرب", "نتريو",
    "github issue", "create a pr", "open a pr", "git branch", "git commit", "ci pipeline", "dev flow",
  ]],
  ["automate", [
    "اتمت", "انجز", "نفذ خطوات", "خطوات متكررة", "متكرر", "في الخلفية", "بالخلفية", "سجل الادلة",
    "automate", "automation", "workflow", "browser flow", "background task", "desktop automation",
  ]],
];

/** The authoritative mode-id set, straight from the catalog. */
export const INTENT_MODE_IDS: ReadonlySet<string> = new Set(LOAM_MODES.map((mode) => mode.id));

/** Normalize case and Arabic orthography variants before matching. */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "") // tashkeel, dagger alef, tatweel
    .replace(/[\u0623\u0625\u0622]/g, "\u0627") // hamza carriers -> bare alef
    .replace(/\u0649/g, "\u064A"); // alef maqsura -> ya
}

interface CompiledSeed {
  /** Plain substring test (Arabic and multi-word phrases). */
  kind: "substring";
  seed: string;
  needle: string;
}

interface CompiledPattern {
  /** ASCII word-boundary test so "pr" never matches "property". */
  kind: "pattern";
  seed: string;
  re: RegExp;
}

type CompiledSeedRule = CompiledSeed | CompiledPattern;

/** Compile once at module load: substring for Arabic, word boundary for ASCII. */
const COMPILED: ReadonlyArray<readonly [string, ReadonlyArray<CompiledSeedRule>]> = SEEDS
  .filter(([id]) => INTENT_MODE_IDS.has(id))
  .map(([id, seeds]) => {
    const rules = seeds.map((seed) => {
      const normalized = normalizeText(seed);
      if (/^[\x20-\x7e]+$/.test(normalized)) {
        const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return { kind: "pattern", seed: normalized, re: new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i") } satisfies CompiledPattern;
      }
      return { kind: "substring", seed: normalized, needle: normalized } satisfies CompiledSeed;
    });
    return [id, rules] as const;
  });

function hit(rule: CompiledSeedRule, normalized: string): boolean {
  return rule.kind === "substring" ? normalized.includes(rule.needle) : rule.re.test(normalized);
}

/** What the keyword layer decided and exactly which seeds it saw. */
export interface KeywordIntent {
  mode: string;
  score: number;
  matched: string[];
}

/** Pure classifier: never touches the network, never throws on any input. */
export function classifyIntentByKeywords(text: string): KeywordIntent {
  const normalized = normalizeText(typeof text === "string" ? text : "");
  let best: KeywordIntent = { mode: "ask", score: 0, matched: [] };
  if (!normalized.trim()) return best;
  for (const [id, rules] of COMPILED) {
    const matched = rules.filter((rule) => hit(rule, normalized)).map((rule) => rule.seed);
    // Strictly greater: ties keep the earlier mode in SEEDS order.
    if (matched.length > best.score) best = { mode: id, score: matched.length, matched };
  }
  if (best.score < KEYWORD_MIN_SCORE) return { mode: "ask", score: best.score, matched: best.matched };
  return best;
}
