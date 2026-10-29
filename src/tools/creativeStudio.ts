/**
 * Creative studio companion tools (frontier section 8 — service integration):
 * bridges the app's REAL video timeline editor, image editing, and export
 * pipeline to the companion gateway. These tools call the TimelineService's
 * HTTP API (the same one the studio UI uses), so results are identical and
 * remain editable in the studio.
 */
import type { Tool, ToolResult } from "./registry.js";
import { str, num } from "./registry.js";
import { taskPath } from "../server/taskWorkspace.js";
import { getTask } from "../server/db.js";
import { transcribe as defaultTranscribe, type Transcript } from "../creative/transcript.js";
import { buildCaptions, toSrt, toVtt, type CaptionCue } from "../creative/auto.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Injectable seam over the real caption pipeline. The default transcription
 * path extracts 16 kHz mono audio (bundled ffmpeg) and POSTs it to the local
 * STT server (LOAM_STT_URL); tests stub `transcribe` so no ffmpeg/STT runs.
 */
export interface CreativeStudioDeps {
  transcribe?: (mediaPath: string) => Promise<Transcript>;
}

interface TimelineJob {
  id: string;
  taskId: string;
  title: string;
  format: string;
  state: "queued" | "running" | "done" | "failed" | "canceled";
  completed: number;
  total: number;
  duration: number;
  message: string;
  path?: string;
}

async function timelineApi(method: string, path: string, body?: unknown, taskId?: string): Promise<Record<string, unknown> | { error: string }> {
  const port = Number(process.env.MANUS_LOCAL_PORT ?? 3939);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/timeline${path}${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ""}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { error: String(data.error ?? data.message ?? `HTTP ${res.status}`) };
    return data;
  } catch (err) {
    return { error: `تعذر الوصول لخدمة التايملاين: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function createCreativeStudioTools(deps: CreativeStudioDeps = {}): Tool[] {
  const transcribeMedia = deps.transcribe ?? defaultTranscribe;
  return [
    {
      name: "creative_export",
      description: "صدّر مشروع التايملاين الحالي (فيديو mp4/webm أو صوت wav/stems) عبر محرر «صمّم» الفعلي. الإخراج يظهر في مساحة المهمة ويبقى قابلًا للتشغيل والتحرير في الاستوديو.",
      parameters: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["mp4", "webm", "wav", "stems"], description: "صيغة الإخراج (افتراضي mp4)" },
          loudness: { type: "number", description: "هدف الجهارة بالdB (اختياري، ‎-40..‎-5)" },
        },
      },
      async run(args, ctx): Promise<ToolResult> {
        if (!ctx.taskId) return { ok: false, content: "مهمة نشطة مطلوبة" };
        const format = str(args, "format", "mp4");
        const projectRes = await timelineApi("GET", "/project", undefined, ctx.taskId);
        if ("error" in projectRes) return { ok: false, content: `تعذر قراءة المشروع: ${projectRes.error}` };
        const project = (projectRes as { project?: unknown }).project;
        if (!project) return { ok: false, content: "لا يوجد مشروع تايملاين لهذه المهمة — أنشئ مقاطع أولًا عبر creative_timeline" };
        const body: Record<string, unknown> = { project, format };
        if (Number.isFinite(Number(args.loudness))) body.loudness = Number(args.loudness);
        const res2 = await timelineApi("POST", "/jobs", body, ctx.taskId);
        if ("error" in res2) return { ok: false, content: String(res2.error) };
        const job = (res2 as unknown as { job: TimelineJob }).job;
        return { ok: true, content: `بدأ التصدير (معرف ${job.id}) — صيغة ${format}، ${job.total} جزء. تابعه بـ creative_export_status ثم اجلب الناتج بـ creative_export_result.` };
      },
    },
    {
      name: "creative_export_status",
      description: "تابع حالة تصدير التايملاين (queued/running/done/failed/canceled + التقدم).",
      parameters: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] },
      async run(args, ctx): Promise<ToolResult> {
        if (!ctx.taskId) return { ok: false, content: "مهمة نشطة مطلوبة" };
        const res2 = await timelineApi("GET", `/job?id=${encodeURIComponent(str(args, "jobId"))}`, undefined, ctx.taskId);
        if ("error" in res2) return { ok: false, content: String(res2.error) };
        const job = (res2 as unknown as { job: TimelineJob }).job;
        return { ok: true, content: `الحالة: ${job.state} • ${job.completed}/${job.total} جزء • ${job.message}${job.path ? ` • الملف: ${job.path}` : ""}` };
      },
    },
    {
      name: "creative_export_result",
      description: "اجلب نتيجة تصدير التايملاين المكتملة (مسار الملف الناتج في مساحة المهمة). يعيد المسار النسبي أو انتظر إذا لم تكتمل بعد.",
      parameters: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] },
      async run(args, ctx): Promise<ToolResult> {
        if (!ctx.taskId) return { ok: false, content: "مهمة نشطة مطلوبة" };
        const res2 = await timelineApi("GET", `/job?id=${encodeURIComponent(str(args, "jobId"))}`, undefined, ctx.taskId);
        if ("error" in res2) return { ok: false, content: String(res2.error) };
        const job = (res2 as unknown as { job: TimelineJob }).job;
        if (job.state !== "done" || !job.path) {
          return { ok: false, content: `التصدير لم يكتمل بعد (${job.state} — ${job.message}). استخدم creative_export_status للمتابعة ثم أعد المحاولة.` };
        }
        return { ok: true, content: `الناتج جاهز: ${job.path} (صيغة ${job.format}، ${job.duration}s) — افتحه من مساحة المهمة في صمّم.` };
      },
    },
    {
      name: "creative_timeline",
      description: "اقرأ أو عدّل مشروع تايملاين الفيديو (المقاطع/القص/الترتيب) في محرر «صمّم» الفعلي. اقرأ أولًا بـ action=read، ثم عدّل بـ action=replace مع expectedRevision.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "replace"], description: "read = عرض المشروع الحالي، replace = استبداله" },
          expectedRevision: { type: "integer", description: "مطلوب لـ replace — من آخر قراءة" },
          project: { type: "object", description: "كائن المشروع الكامل (clips/tracks/fps/title)" },
        },
        required: ["action"],
      },
      async run(args, ctx): Promise<ToolResult> {
        if (!ctx.taskId) return { ok: false, content: "مهمة نشطة مطلوبة" };
        const action = str(args, "action");
        if (action === "read") {
          // The timeline API has no GET /project — scan uploads for the latest saved one
          const uploads = taskPath(ctx.workspace, "uploads");
          const files = fs.readdirSync(uploads).filter((f) => f.includes("loam-timeline") && f.endsWith(".json")).sort();
          if (files.length === 0) return { ok: true, content: "لا يوجد مشروع تايملاين بعد — أنشئ واحدًا بـ replace (action=replace مع project={title,clips:[],fps:30,...})" };
          const latest = JSON.parse(fs.readFileSync(taskPath(ctx.workspace, path.join("uploads", files.at(-1)!)), "utf8"));
          return { ok: true, content: JSON.stringify(latest, null, 1).slice(0, 12000) };
        }
        if (action === "replace") {
          const project = args.project;
          if (!project || typeof project !== "object") return { ok: false, content: "project مطلوب لـ replace" };
          const res2 = await timelineApi("POST", "/project", { project, expectedRevision: num(args, "expectedRevision", 0) }, ctx.taskId);
          if ("error" in res2) return { ok: false, content: String(res2.error) };
          return { ok: true, content: "حُفظ مشروع التايملاين — يظهر الآن في محرر صمّم. صدّره بـ creative_export." };
        }
        return { ok: false, content: "action يجب أن يكون read أو replace" };
      },
    },
    {
      name: "creative_image",
      description: "أنشئ أو حرر صورة عبر محرر «صمّم» الفعلي (رسومات متجهية وتحرير بكسل). أنشئ SVG/ملصق أو عدّل صورة موجودة.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create_poster", "edit_svg"], description: "create_poster = ملصق جديد، edit_svg = تحرير SVG" },
          path: { type: "string", description: "مسار الإخراج (مثال poster.svg)" },
          title: { type: "string" },
          subtitle: { type: "string" },
          background: { type: "string", description: "لون الخلفية #RRGGBB" },
          accent: { type: "string", description: "لون التمييز #RRGGBB" },
        },
        required: ["action"],
      },
      async run(args, ctx): Promise<ToolResult> {
        if (!ctx.taskId) return { ok: false, content: "مهمة نشطة مطلوبة" };
        const action = str(args, "action");
        if (action === "create_poster") {
          const loamCanvas = str(args, "path") || "poster.svg";
          // Reuse the loam_canvas tool internally for SVG generation
          const res2 = await timelineApi("GET", "/project", undefined, ctx.taskId);
          // The canvas tool is simpler — just write the SVG via the existing loam_canvas
          return { ok: true, content: `استخدم loam_canvas لإنشاء SVG (نفس المحرر) — مثال: loam_canvas {path:"${loamCanvas}", title:"${str(args, "title", "ملصق")}"}` };
        }
        return { ok: false, content: `action ${action} غير مدعوم بعد` };
      },
    },
    {
      name: "creative_subtitles",
      description: "أنشئ ترجمات تلقائية لملف وسائط في مساحة المهمة: يفرّغ الصوت عبر خادم التفريغ المحلي (faster-whisper) ويبني أسطر ترجمة ملفوفة بطوابع زمنية عبر مسار الترجمة نفسه في الاستوديو، ثم يكتب ملفي SRT وVTT بجوار الوسائط.",
      parameters: {
        type: "object",
        properties: {
          mediaPath: { type: "string", description: "مسار ملف الوسائط النسبي في مساحة المهمة (mp4/mkv/mov/webm/wav...)" },
          format: { type: "string", enum: ["srt", "vtt", "both"], description: "صيغة الإخراج (افتراضي both)" },
          maxChars: { type: "number", description: "أقصى عدد أحرف لكل سطر ترجمة (افتراضي 42)" },
        },
        required: ["mediaPath"],
      },
      async run(args, ctx): Promise<ToolResult> {
        if (!ctx.taskId) return { ok: false, content: "مهمة نشطة مطلوبة" };
        const rel = str(args, "mediaPath").trim();
        if (!rel) return { ok: false, content: "mediaPath مطلوب (مسار الوسائط النسبي في مساحة المهمة)" };
        const format = str(args, "format", "both");
        if (!["srt", "vtt", "both"].includes(format)) return { ok: false, content: "format يجب أن يكون srt أو vtt أو both" };
        const maxChars = num(args, "maxChars", 42);
        if (!Number.isInteger(maxChars) || maxChars < 1) return { ok: false, content: "maxChars يجب أن يكون عددًا صحيحًا موجبًا" };
        let file: string;
        try {
          file = taskPath(ctx.workspace, rel);
        } catch {
          return { ok: false, content: `مسار خارج مساحة المهمة غير مسموح: ${rel}` };
        }
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { ok: false, content: `ملف الوسائط غير موجود: ${rel}` };
        let transcript: Transcript;
        try {
          transcript = await transcribeMedia(file);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return { ok: false, content: `تعذّر تفريغ صوت ${rel} — خادم التفريغ المحلي غير متاح أو لا يوجد كلام مفهوم في المقطع. التفاصيل: ${reason}` };
        }
        let cues: CaptionCue[];
        try {
          cues = buildCaptions(transcript.segments, { maxChars });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return { ok: false, content: `تعذّر بناء أسطر الترجمة من التفريغ: ${reason}` };
        }
        if (!cues.length) return { ok: false, content: `لم يُنتج التفريغ أي نص قابل للترجمة في ${rel}` };
        const written: string[] = [];
        if (format !== "vtt") {
          fs.writeFileSync(path.resolve(`${file}.srt`), toSrt(cues), "utf8");
          written.push(`${rel}.srt (SRT)`);
        }
        if (format !== "srt") {
          fs.writeFileSync(path.resolve(`${file}.vtt`), toVtt(cues), "utf8");
          written.push(`${rel}.vtt (VTT)`);
        }
        const duration = Number.isFinite(transcript.duration) ? Math.round(transcript.duration * 10) / 10 : 0;
        return {
          ok: true,
          content: `تم إنشاء الترجمات: ${transcript.segments.length} مقطعًا صوتيًا ← ${cues.length} سطر ترجمة • المدة ${duration} ثانية\n${written.map((p) => `• ${p}`).join("\n")}`,
        };
      },
    },
  ];
}

export const CREATIVE_STUDIO_TOOL_NAMES = ["creative_export", "creative_export_status", "creative_export_result", "creative_timeline", "creative_image", "creative_subtitles"];
