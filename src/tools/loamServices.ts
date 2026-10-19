/**
 * Loam services as gateway tools (frontier stage 3): the two services the
 * companion gateway cataloged but had no model-facing tools — المهام/المشاريع
 * (tasks) and الأتمتة (automation/schedules). These run against the app's real
 * task + schedule stores, so a companion can create, follow, cancel, deliver
 * into tasks and set up routines — with verification evidence per service in
 * check:companions.
 */
import type { Tool } from "./registry.js";
import { str, num, bool } from "./registry.js";
import { createTask, getTask, listTasks, setTaskStatus } from "../server/db.js";
import { addSchedule, listSchedules, deleteSchedule } from "../server/db.js";
import { cancelRunSignal } from "../server/runControl.js";
import { createWatchRoutine, watchSchedules } from "../server/fileWatchers.js";

const json = (value: unknown): string => JSON.stringify(value, null, 1);

export function createLoamServiceTools(): Tool[] {
  return [
    {
      name: "task_create",
      description: "أنشئ مهمة Loam جديدة (مساحة عمل + سجل) — تُربط تلقائيًا بمساعد هذه الجولة إن وجد. أعد معرفها للمستخدم ليفتحها ويتابع نتائجها. لا تشغّلها تلقائيًا؛ اذكر ذلك بوضوح.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "عنوان المهمة (مختصر وواضح)" },
          prompt: { type: "string", description: "وصف الهدف ومعايير الإنجاز (اختياري — يُحفظ مع المهمة)" },
          agentId: { type: "string", description: "إسناد المهمة لمساعد محدد (افتراضيًا: مساعد هذه الجولة)" },
        },
        required: ["title"],
      },
      async run(args, ctx) {
        const title = str(args, "title").trim().slice(0, 200);
        if (!title) return { ok: false, content: "title مطلوب" };
        const prompt = str(args, "prompt").trim().slice(0, 8000) || title;
        const agentId = str(args, "agentId").trim() || (ctx.taskId ? (getTask(ctx.taskId)?.agentId ?? "") : "") || null;
        const task = createTask(prompt, title, null, agentId);
        return { ok: true, content: `أُنشئت المهمة «${task.title}» (الحالة: ${task.status}) — المعرف: ${task.id}. افتحها من صفحة المهام في Loam؛ لن تُشغَّل تلقائيًا.` };
      },
    },
    {
      name: "task_list",
      description: "اعرض مهام Loam الأخيرة مع حالتها (queued/running/done/error/cancelled) وتاريخ آخر تحديث.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50, description: "افتراضي 10" },
          mineOnly: { type: "boolean", description: "اقصر القائمة على مهام هذا المساعد (يتطلب تعريف المهمة بمعرف المساعد)" },
        },
      },
      async run(args, ctx) {
        const limit = Math.min(50, Math.max(1, Math.floor(num(args, "limit", 10))));
        const mine = bool(args, "mineOnly", false);
        // mineOnly = THIS companion's tasks only (from the run's task owner)
        const myAgentId = mine ? (ctx.taskId ? (getTask(ctx.taskId)?.agentId ?? "") : (str(args, "agentId") || "")) : "";
        const rows = listTasks()
          .filter((t) => (mine && myAgentId ? t.agentId === myAgentId : true))
          .slice(0, limit)
          .map((t) => ({ id: t.id, title: t.title, status: t.status, agentId: t.agentId ?? null, updatedAt: t.updatedAt }));
        return { ok: true, content: rows.length > 0 ? json(rows) : "لا مهام بعد" };
      },
    },
    {
      name: "task_get",
      description: "اقرأ حالة مهمة Loam وتقدمها: عدد الخطوات، آخر رسالة مساعد، وآخر خطوة موقوفة — لمتابعة التنفيذ أو تسليمه.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async run(args) {
        const task = getTask(str(args, "id").trim());
        if (!task) return { ok: false, content: "المهمة غير موجودة" };
        const lastAssistant = [...(task.messages ?? [])].reverse().find((m) => m.role === "assistant");
        const lastStep = (task.steps ?? []).at(-1) as { at?: string; data?: { type?: string } } | undefined;
        return {
          ok: true,
          content: json({
            id: task.id, title: task.title, status: task.status, agentId: task.agentId ?? null,
            steps: (task.steps ?? []).length, messages: (task.messages ?? []).length,
            lastAssistantMessage: (lastAssistant?.content ?? "").slice(0, 600),
            lastStep: lastStep ? { type: lastStep.data?.type, at: lastStep.at } : null,
          }),
        };
      },
    },
    {
      name: "task_cancel",
      description: "أوقف مهمة Loam جارية (إيقاف بين الخطوات) وضعها في حالة cancelled. للإلغاء عند طلب المستخدم أو انحراف المهمة.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async run(args) {
        const id = str(args, "id").trim();
        const task = getTask(id);
        if (!task) return { ok: false, content: "المهمة غير موجودة" };
        if (task.status === "done" || task.status === "cancelled") return { ok: false, content: `المهمة «${task.title}» حالتها ${task.status} أصلًا — لا شيء لإلغائه` };
        const signaled = cancelRunSignal(id);
        setTaskStatus(id, "cancelled", { error: "cancelled by companion" });
        return { ok: true, content: `أُوقفت المهمة «${task.title}» وحُفظ ما نُفّذ منها${signaled ? " (أُرسلت إشارة الإيقاف لتشغيل جارٍ)" : ""}.` };
      },
    },
    {
      name: "schedule_create",
      description: "أنشئ روتينًا مجدولًا (الأتمتة): يُشغّل أمرًا دوريًا على أحدث نموذج. يُربط الروتين تلقائيًا بهذا المساعد إن كانت الجولة لمساعد. اعرض دائمًا الفاصل ومعرّف الروتين للمستخدم.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "الأمر الذي يُنفّذ كل مرة (وصف مهمة كامل)" },
          everyMinutes: { type: "number", minimum: 1, description: "الفاصل بالدقائق (الحد الأدنى الفعلي 30 ثانية)" },
          agentId: { type: "string", description: "إسناد الروتين لمساعد محدد (افتراضيًا: مساعد هذه الجولة)" },
          workMode: { type: "string", enum: ["loam", "own_device"], description: "أين يُنفّذ الروتين: داخل التطبيق أو على جهاز المساعد المستقل (يتطلب جهازًا جاهزًا)" },
        },
        required: ["prompt", "everyMinutes"],
      },
      async run(args, ctx) {
        const prompt = str(args, "prompt").trim().slice(0, 4000);
        const everyMinutes = num(args, "everyMinutes", 0);
        if (!prompt) return { ok: false, content: "prompt مطلوب" };
        if (!(everyMinutes > 0)) return { ok: false, content: "everyMinutes يجب أن يكون رقمًا موجبًا" };
        const owner = str(args, "agentId").trim() || (ctx.taskId ? (getTask(ctx.taskId)?.agentId ?? "") : "");
        const workMode = str(args, "workMode").trim() || undefined;
        const s = addSchedule(prompt, Math.round(everyMinutes * 60), owner || undefined, workMode === "own_device" || workMode === "loam" ? workMode : undefined);
        return { ok: true, content: `أُنشئ الروتين (المعرف ${s.id}) — يُنفّذ كل ${everyMinutes} دقيقة بدءًا من ${s.nextRunAt}${s.agentId ? ` ويعمل باسم هذا المساعد (${s.agentId}) — تظهر نتائجه في محادثته` : ""}${s.workMode === "own_device" ? " على جهازه المستقل" : ""}. أوقفه بـ schedule_delete بنفس المعرف.` };
      },
    },
    {
      name: "schedule_list",
      description: "اعرض روتينات الأتمتة المجدولة: المعرف، الفاصل، حالة التمكين، آخر تشغيل.",
      parameters: { type: "object", properties: {} },
      async run() {
        const rows = listSchedules().map((s) => ({ id: s.id, everyMinutes: Math.round(s.intervalSeconds / 60), enabled: s.enabled, prompt: s.prompt.slice(0, 120), agentId: s.agentId ?? null, lastRunAt: s.lastRunAt ?? null, lastTaskId: s.lastTaskId ?? null }));
        return { ok: true, content: rows.length > 0 ? json(rows) : "لا روتينات مجدولة" };
      },
    },
    {
      name: "watch_create",
      description: "أنشئ مشغلًا حدثيًا: راقب مجلدًا عند المستخدم ونفّذ أمرًا لمساعدك عند أي تغيير فيه (بعد مهلة تهدئة). مثال: عالج الفواتير الجديدة في مجلد الفواتير تلقائيًا.",
      parameters: {
        type: "object",
        properties: {
          watchPath: { type: "string", description: "المجلد المراقب (مسار مطلق عند المستخدم)" },
          prompt: { type: "string", description: "الأمر الذي يُنفّذ عند كل تغيير (وصف مهمة كامل)" },
        },
        required: ["watchPath", "prompt"],
      },
      async run(args, ctx) {
        const watchPath = str(args, "watchPath").trim();
        const prompt = str(args, "prompt").trim().slice(0, 4000);
        if (!watchPath || !prompt) return { ok: false, content: "watchPath وprompt مطلوبان" };
        const owner = str(args, "agentId").trim() || (ctx.taskId ? (getTask(ctx.taskId)?.agentId ?? "") : "");
        const run = (globalThis as unknown as { __loamScheduledRun?: (o: { prompt: string; scheduleId: string; agentId?: string; workMode?: string }) => Promise<string> }).__loamScheduledRun;
        if (!run) return { ok: false, content: "محرك المشغلات غير مهيأ في هذه البيئة" };
        const created = createWatchRoutine({ prompt, watchPath, ...(owner ? { agentId: owner } : {}), run });
        if ("error" in created) return { ok: false, content: created.error };
        return { ok: true, content: `رُكّب المشغل (${created.scheduleId}) على ${created.dir} — أي تغيير في المجلد يشغّل أمرك باسمك. أوقفه بـ schedule_delete.` };
      },
    },
    {
      name: "watch_list",
      description: "اعرض المشغلات الحدثية المركبة (مجلدات مراقبة).",
      parameters: { type: "object", properties: {} },
      async run() {
        const rows = watchSchedules();
        return { ok: true, content: rows.length > 0 ? json(rows) : "لا مشغلات مركبة" };
      },
    },
    {
      name: "schedule_delete",
      description: "أوقف روتين أتمتة واحذفه بمعرّفه (من schedule_list).",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async run(args) {
        const ok = deleteSchedule(str(args, "id").trim());
        return { ok, content: ok ? "حُذف الروتين ولن يُشغّل مجددًا" : "الروتين غير موجود" };
      },
    },
  ];
}
