/**
 * Per-run companion-memory tools (frontier stage 4a). Bound to ONE agent at run
 * start — a companion can only read/write its own memory, never another's.
 */
import type { Tool } from "./registry.js";
import { str, num, bool } from "./registry.js";
import { remember, rememberShared, listMemory, searchMemory, type MemoryEntry, type MemorySearchHit } from "../server/companionMemory.js";

const describe = (e: MemoryEntry): string =>
  `[${e.kind} | ${e.source === "user" ? "قالها المستخدم" : "استنتاج المساعد"} | ثقة ${e.confidence.toFixed(2)} | ${e.at.slice(0, 10)}${e.expiresAt ? ` | تنتهي ${e.expiresAt.slice(0, 10)}` : ""}] ${e.text}`;

const describeHit = (h: MemorySearchHit): string =>
  `${h.scope === "team" ? "[مشترك — فريق] " : ""}${describe(h.entry)}${h.score !== undefined ? ` (شبه ${h.score.toFixed(2)})` : ""}`;

export function createCompanionMemoryTools(agentId: string): Tool[] {
  return [
    {
      name: "companion_memory_save",
      description: "احفظ ذكرى في ذاكرتك الشخصية الدائمة (تفضيل المستخدم، حقيقة، تعليم، أو استنتاجك). ميّز دائمًا: ما قاله المستخدم source=user وما استنتجته أنت kind=inference. الذكريات تُعرض للمستخدم لمراجعتها. استخدم shared=true فقط لمعرفة تهم الفريق كله.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "الذكرى (جملة واحدة دقيقة)" },
          kind: { type: "string", enum: ["preference", "fact", "instruction", "inference"] },
          source: { type: "string", enum: ["user", "companion"], description: "من قالها: المستخدم أم أنت" },
          confidence: { type: "number", minimum: 0, maximum: 1, description: "درجة الثقة 0..1 (افتراضي 0.8)" },
          ttlDays: { type: "number", minimum: 1, description: "صلاحية بالأيام للمعلومات المتغيرة (اختياري)" },
          shared: { type: "boolean", description: "احفظها في ذاكرة الفريق المشتركة بدل ذاكرتك الخاصة" },
        },
        required: ["text"],
      },
      async run(args, ctx) {
        const input = {
          text: str(args, "text"),
          kind: str(args, "kind") || undefined,
          confidence: num(args, "confidence", 0.8),
          ...(num(args, "ttlDays", 0) > 0 ? { ttlDays: num(args, "ttlDays", 0) } : {}),
          ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
        };
        if (bool(args, "shared", false)) {
          const created = rememberShared(agentId, input);
          if ("error" in created) return { ok: false, content: created.error };
          return { ok: true, content: `حُفظت في ذاكرة الفريق المشتركة (${created.id}) باسمك كمالكها: ${describe(created)}` };
        }
        const created = remember(agentId, { ...input, source: str(args, "source") || undefined });
        if ("error" in created) return { ok: false, content: created.error };
        return { ok: true, content: `حُفظت الذكرى (${created.id}): ${describe(created)}` };
      },
    },
    {
      name: "companion_memory_search",
      description: "ابحث في ذاكرتك الشخصية وفي ذاكرة الفريق المشتركة. يبحث نصيًا، ودلاليًا أيضًا عندما تكون نماذج التضمين مفعلة (تظهر النتائج الدلالية مع درجة شبه).",
      parameters: {
        type: "object",
        properties: { q: { type: "string", description: "نص البحث (فارغ = الأحدث)" }, kind: { type: "string", enum: ["preference", "fact", "instruction", "inference"] }, semantic: { type: "boolean", description: "فعّل البحث الدلالي عند توفر التضمينات (افتراضيًا مفعّل)" }, limit: { type: "integer", minimum: 1, maximum: 30 } },
      },
      async run(args) {
        const { mode, hits } = await searchMemory(agentId, { q: str(args, "q"), kind: str(args, "kind") || undefined, semantic: bool(args, "semantic", true) });
        const rows = hits.slice(0, Math.min(30, Math.max(1, Math.floor(num(args, "limit", 10)))));
        const modeNote = mode === "semantic" ? "" : " (بحث نصي — التضمينات غير مفعلة)";
        return { ok: true, content: rows.length > 0 ? `${rows.map(describeHit).join("\n")}${modeNote}` : `لا نتائج${modeNote}` };
      },
    },
    {
      name: "companion_memory_list",
      description: "اعرض أحدث ذكرياتك الشخصية وذكرايات الفريق المشتركة مع مصدرها وثقتها وتاريخها (للمراجعة أمام المستخدم).",
      parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 30 } } },
      async run(args) {
        const limit = Math.min(30, Math.max(1, Math.floor(num(args, "limit", 10))));
        const own = listMemory(agentId).slice(0, limit).map((entry) => ({ entry, scope: "own" as const }));
        const team = listMemory("team").slice(0, limit).map((entry) => ({ entry, scope: "team" as const }));
        const rows = [...own, ...team];
        return { ok: true, content: rows.length > 0 ? rows.map(describeHit).join("\n") : "ذاكرتك الشخصية فارغة بعد" };
      },
    },
  ];
}

export const COMPANION_MEMORY_TOOL_NAMES = ["companion_memory_save", "companion_memory_search", "companion_memory_list"];
