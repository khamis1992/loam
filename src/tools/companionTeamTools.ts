/**
 * Per-run collaboration tools (stage 5, section 15) + learning-from-workflow
 * tool (section 12). Bound to the delegating companion; the delegate task runs
 * under the TARGET companion's identity.
 */
import type { Tool } from "./registry.js";
import { str, bool } from "./registry.js";
import { delegate, delegationRunnerActive } from "../server/companionTeam.js";
import { getAgent, listAgents } from "../server/agents.js";
import { getTask, listTasks } from "../server/db.js";
import { remember } from "../server/companionMemory.js";
import { applySkill, readSkillFile } from "./skills.js";

const resolveAgent = (idOrName: string) => {
  const key = idOrName.trim();
  if (!key) return undefined;
  const agents = listAgents();
  return agents.find((a) => a.id === key) ?? agents.find((a) => a.name === key);
};

const summarizeTask = (id: string): string => {
  const task = getTask(id);
  if (!task) return `المهمة ${id} غير موجودة`;
  const lastAssistant = [...(task.messages ?? [])].reverse().find((m) => m.role === "assistant");
  return `الحالة: ${task.status} • الخطوات: ${(task.steps ?? []).length}${lastAssistant ? ` • آخر رد: ${lastAssistant.content.slice(0, 300)}` : ""}`;
};

export function createCompanionTeamTools(agentId: string): Tool[] {
  return [
    {
      name: "companion_delegate",
      description: "فوّض جزءًا من العمل إلى رفيق آخر بالاسم أو المعرف. تُنشأ مهمة تعمل بهوية الرفيق الآخر (نموذجه وتعليماته وذاكرته) وتظهر في محادثته، وتبقى أنت الواجهة أمام المستخدم. لا تفوّض دون إخبار المستخدم.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "اسم الرفيق أو معرفه" },
          brief: { type: "string", description: "تكليف كامل: الهدف والسياق ومعايير الإنجاز (الرفيق الآخر لا يرى محادثتنا)" },
          title: { type: "string", description: "عنوان قصير للمهمة" },
          mode: { type: "string", enum: ["ask", "research", "build", "write", "data", "media", "automate"], description: "نمط تنفيذ المهمة (افتراضي build)" },
        },
        required: ["to", "brief"],
      },
      async run(args) {
        if (!delegationRunnerActive()) return { ok: false, content: "محرك التفويض غير مهيأ في هذه البيئة" };
        const target = resolveAgent(str(args, "to"));
        if (!target) return { ok: false, content: `لا يوجد رفيق بهذا الاسم/المعرف: ${str(args, "to")}` };
        if (target.id === agentId) return { ok: false, content: "لا يمكن تفويض العمل إلى نفسك" };
        const handle = await delegate({
          fromAgentId: agentId,
          toAgentId: target.id,
          brief: str(args, "brief").slice(0, 8000),
          ...(str(args, "title").trim() ? { title: str(args, "title").trim().slice(0, 120) } : {}),
          ...(str(args, "mode").trim() ? { mode: str(args, "mode") } : {}),
        });
        if ("error" in handle && handle.error) return { ok: false, content: handle.error };
        const okHandle = handle as { taskId: string };
        return {
          ok: true,
          content: `فُوّضت المهمة إلى «${target.name}» (مهمة ${okHandle.taskId}). تابعها بـ companion_delegations ثم لخّص نتيجتها للمستخدم بنفسك.`,
        };
      },
    },
    {
      name: "companion_delegations",
      description: "اعرض المهام المفوّضة منك وإلى رفاق آخرين مع حالتها وآخر رد لكل منها — لتجميع النتائج والتحقق من تكاملها قبل تسليمها للمستخدم.",
      parameters: { type: "object", properties: { mine: { type: "boolean", description: "اقصر على ما فوّضته أنت (يتطلب تسجيلها في ذاكرتك عند التفويض) — الافتراضي: مهام رفاق آخرين النشطة" } } },
      async run(args) {
        const scopeMine = bool(args, "mine", true);
        const rows = listTasks()
          .filter((t) => t.agentId && t.agentId !== agentId && t.delegatedByAgentId === agentId)
          .filter((t) => (scopeMine ? true : (t.steps ?? []).length > 0))
          .slice(0, 15)
          .map((t) => {
            const owner = getAgent(t.agentId!);
            return `- ${t.id} «${t.title}» لدى ${owner?.name ?? t.agentId} — ${summarizeTask(t.id)}`;
          });
        return { ok: true, content: rows.length > 0 ? rows.join("\n") : "لا مهام مفوّضة نشطة الآن" };
      },
    },
    {
      name: "companion_learn_skill",
      description: "حوّل سير عمل متكررًا نفذته للتو إلى مهارة قابلة لإعادة الاستخدام (مع رقم إصدار يزداد عند إعادة التعلم، وسبب قبول النتيجة). استخدمها بعد تأكيد المستخدم نجاح النمط.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "اسم المهارة (حروف إنجليزية وشرطات)" },
          description: { type: "string", description: "متى تُستخدم المهارة" },
          steps: { type: "string", description: "خطوات سير العمل كما نُفذت فعليًا" },
          rationale: { type: "string", description: "لماذا نجح هذا النمط (يُحفظ في ذاكرتك أيضًا)" },
        },
        required: ["name", "steps"],
      },
      async run(args2) {
        const name = str(args2, "name").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
        if (!name) return { ok: false, content: "اسم مهارة صالح مطلوب (حروف إنجليزية وشرطات)" };
        const steps = str(args2, "steps").trim();
        if (steps.length < 20) return { ok: false, content: "الخطوات قصيرة جدًا — صِف سير العمل الفعلي" };
        const existing = readSkillFile(name);
        let version = 1;
        let previousNote = "";
        if (existing) {
          version = (Number(/version:\s*(\d+)/i.exec(existing.body)?.[1]) || 0) + 1;
          previousNote = existing.body;
        }
        const content = [
          `# ${name} — v${version}`,
          `<!-- learned-by: ${agentId} | learned-at: ${new Date().toISOString()} -->`,
          `<!-- version: ${version} -->`,
          "",
          `**متى:** ${str(args2, "description").trim() || "سير عمل متكرر تعلّمه هذا المساعد"}`,
          "",
          "## الخطوات",
          steps,
          ...(previousNote ? ["", `## الإصدار السابق (v${version - 1})`, previousNote.slice(0, 2000)] : []),
        ].join("\n");
        const result = applySkill(existing ? "skill_patch" : "skill_create", existing ? { name, content } : { name, description: str(args2, "description").trim() || `سير عمل تعلّمه ${getAgent(agentId)?.name ?? agentId}`, content });
        if (!result.ok) return { ok: false, content: `فشل حفظ المهارة: ${result.content}` };
        const rationale = str(args2, "rationale").trim();
        if (rationale) {
          remember(agentId, { text: `مهارة «${name}» v${version} — سبق نجاحها: ${rationale}`, kind: "instruction", source: "companion", confidence: 0.9 });
        }
        return { ok: true, content: `حُفظت المهارة «${name}» كإصدار v${version}${existing ? " (مع أرشفة الإصدار السابق داخلها)" : ""}${rationale ? " ووُثّق سبب نجاحها في ذاكرتك" : ""}. اختبرها قبل تشغيلها تلقائيًا.` };
      },
    },
  ];
}

export const COMPANION_TEAM_TOOL_NAMES = ["companion_delegate", "companion_delegations", "companion_learn_skill"];
