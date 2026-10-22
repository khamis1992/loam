/**
 * Companion templates + lifecycle bundle (frontier sections 1 & 22): create a
 * companion from a ready template, duplicate its settings, archive it, and
 * export/import its full data bundle (identity + memory + routines + voice
 * transcript) for safe migration between installs.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { log } from "../log.js";

export interface AgentTemplateDef {
  id: string;
  labelAr: string;
  emoji: string;
  description: string;
  instructions: string;
  mode: string;
  workMode: string;
  allowedServices?: string[];
}

export const AGENT_TEMPLATES: AgentTemplateDef[] = [
  { id: "coordinator", labelAr: "منسّق فريق", emoji: "🧭", description: "يوزع العمل على الرفاق المتخصصين ويتابع التسليم", instructions: "أنت منسّق: فكّك الطلب، فوّض الأجزاء لرفيق متخصص عبر companion_delegate، تابع النتائج بـ companion_delegations، وتحقق من تكاملها قبل التسليم للمستخدم.", mode: "build", workMode: "team" },
  { id: "researcher", labelAr: "باحث موثّق", emoji: "🔍", description: "بحث بالمصادر وتقارير موثقة بالروابط", instructions: "أنت باحث: ابحث بـ web_search واقرأ المصادر بـ web_fetch، افصل الحقائق عن الاستنتاجات، ووثّق كل ادعاء برابطه.", mode: "research", workMode: "loam" },
  { id: "developer", labelAr: "مطور تطبيقات", emoji: "🛠", description: "يبني ويختبر التطبيقات ويعمل منفصلًا على جهازه", instructions: "أنت مطور: اكتب الكود واختبره فعليًا، وعند العمل المكثف اطلب جهازك المستقل عبر أدوات device_*، وسلّم النتائج بـ device_pull_file.", mode: "build", workMode: "own_device" },
  { id: "reviewer", labelAr: "مراجع نقدي", emoji: "🧐", description: "مراجعة مستقلة وجودة قبل التسليم", instructions: "أنت مراجع مستقل: ابحث عن الأخطاء والفجوات والادعاءات بلا دليل، وأعد قائمة ملاحظات مرتبة بالخطورة مع الدليل لكل ملاحظة.", mode: "build", workMode: "loam" },
  { id: "ops", labelAr: "مشغّل روتينات", emoji: "⏱", description: "روتينات مجدولة ومشغلات حدثية ومتابعة خلفية", instructions: "أنت مشغّل روتينات: أنشئ الجداول بـ schedule_create والمشغلات بـ watch_create، وراقب نتائجها، وأبلغ المستخدم فقط عند ما يستحق.", mode: "automate", workMode: "continuous" },
];

export function getAgentTemplate(id: string): AgentTemplateDef {
  const t = AGENT_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown companion template: ${id}`);
  return t;
}

/* ---------------- bundle export / import (sections 1 & 22) ---------------- */

export interface CompanionBundle {
  kind: "loam-companion-bundle";
  version: 1;
  exportedAt: string;
  agent: Record<string, unknown>;
  memory: Array<Record<string, unknown>>;
  schedules: Array<Record<string, unknown>>;
  voiceTurns: Array<Record<string, unknown>>;
}

const readJsonSafe = (file: string): unknown => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
};

export function bundleWorkspaceDir(): string {
  return path.join(DATA_DIR, "companion-bundles");
}

export function writeBundleFile(bundle: CompanionBundle, suggestedName: string): string {
  fs.mkdirSync(bundleWorkspaceDir(), { recursive: true });
  const safe = suggestedName.replace(/[^\w\u0600-\u06ff.-]+/g, "_").slice(0, 60) || "companion";
  const file = path.join(bundleWorkspaceDir(), `${Date.now()}-${safe}.json`);
  fs.writeFileSync(file, JSON.stringify(bundle, null, 1), "utf8");
  return file;
}

export function sanitizeBundle(raw: unknown): CompanionBundle | { error: string } {
  const b = raw as Partial<CompanionBundle> & { agent?: Record<string, unknown> };
  if (!b || b.kind !== "loam-companion-bundle" || !b.agent || typeof b.agent.name !== "string") {
    return { error: "الملف ليس حزمة مساعد Loam سليمة" };
  }
  return {
    kind: "loam-companion-bundle",
    version: 1,
    exportedAt: typeof b.exportedAt === "string" ? b.exportedAt : new Date().toISOString(),
    agent: b.agent,
    memory: Array.isArray(b.memory) ? b.memory.slice(0, 500) : [],
    schedules: Array.isArray(b.schedules) ? b.schedules.slice(0, 100) : [],
    voiceTurns: Array.isArray(b.voiceTurns) ? b.voiceTurns.slice(0, 500) : [],
  };
}

export const logBundle = (msg: string): void => log.info(`companion-bundle: ${msg}`);
