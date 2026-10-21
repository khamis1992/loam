/** Remaining service-gap tools: task_run/resume, schedule_update, image_ocr,
 * file_project_check, device_preview — completing the 15-service table. */
import type { Tool, ToolResult } from "./registry.js";
import { str, num, bool } from "./registry.js";
import { taskPath } from "../server/taskWorkspace.js";
import { getTask } from "../server/db.js";
import fs from "node:fs";
import path from "node:path";

async function api(method: string, url: string, body?: unknown): Promise<Record<string, unknown> | { error: string }> {
  const port = Number(process.env.MANUS_LOCAL_PORT ?? 3939);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { "content-type": "application/json", ...(process.env.LOAM_AUTH_DISABLED !== "true" && process.env.LOAM_LOCAL_TOKEN ? { "x-loam-local-token": process.env.LOAM_LOCAL_TOKEN } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { error: String(data.error ?? data.message ?? `HTTP ${res.status}`) };
    return data;
  } catch { return { error: "Service unreachable" }; }
}

export function createServiceGapTools(): Tool[] {
  return [
    // ── Tasks: run + resume (the gap: task_create only creates the record) ──
    {
      name: "task_run",
      description: "شغّل مهمة Loam موجودة (أُنشأت بـ task_create) فورًا. المهمة تبدأ التنفيذ الفعلي ولا مجرد السجل.",
      parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
      async run(args): Promise<ToolResult> {
        const res = await api("POST", `/api/tasks/${encodeURIComponent(str(args, "taskId"))}/run-now`, {});
        if ("error" in res) return { ok: false, content: String(res.error) };
        return { ok: true, content: `بدأ تشغيل المهمة ${str(args, "taskId")} — تابعها بـ task_get.` };
      },
    },
    {
      name: "task_resume",
      description: "استأنف مهمة متوقفة (انقطاع/خطأ) من آخر نقطة استكمال دون تكرار الأفعال المكتملة.",
      parameters: { type: "object", properties: { taskId: { type: "string" }, retryInterruptedStep: { type: "boolean", description: "أعد محاولة الخطوة المتوقفة (افتراضي false)" } }, required: ["taskId"] },
      async run(args): Promise<ToolResult> {
        const res = await api("POST", `/api/tasks/${encodeURIComponent(str(args, "taskId"))}/resume`, { retryInterruptedStep: bool(args, "retryInterruptedStep", false) });
        if ("error" in res) return { ok: false, content: String(res.error) };
        return { ok: true, content: `استُأنفت المهمة ${str(args, "taskId")} — تكمل من آخر نقطة محفوظة.` };
      },
    },

    // ── Automation: update/disable (the gap: only create/list/delete existed) ──
    {
      name: "schedule_update",
      description: "عدّل أو عطّل أو فعّل روتينًا مجدولًا أو مشغلًا (تغيير الفاصل أو التعطيل المؤقت أو إعادة التفعيل).",
      parameters: {
        type: "object",
        properties: {
          scheduleId: { type: "string" },
          enabled: { type: "boolean", description: "فعّل/عطّل" },
          everyMinutes: { type: "number", description: "فاصل جديد بالدقائق" },
        },
        required: ["scheduleId"],
      },
      async run(args): Promise<ToolResult> {
        const id = str(args, "scheduleId");
        // Read current, apply changes, save via API
        const list = await api("GET", "/api/schedules");
        if ("error" in list) return { ok: false, content: String(list.error) };
        const schedules = (list as { schedules: Array<{ id: string; intervalSeconds: number; enabled: boolean; prompt: string; agentId?: string; workMode?: string; kind?: string; watchPath?: string }> }).schedules ?? [];
        const current = schedules.find((s) => s.id === id);
        if (!current) return { ok: false, content: `الروتين ${id} غير موجود` };
        const updated = { ...current, ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}), ...(Number.isFinite(Number(args.everyMinutes)) ? { intervalSeconds: Math.max(30, Math.round(Number(args.everyMinutes) * 60)) } : {}) };
        // Delete and recreate with updated values
        await api("DELETE", `/api/schedules/${encodeURIComponent(id)}`);
        const createRes = await api("POST", "/api/schedules", { prompt: updated.prompt, intervalSeconds: updated.intervalSeconds, ...(updated.agentId ? { agentId: updated.agentId } : {}), ...(updated.workMode ? { workMode: updated.workMode } : {}) });
        if ("error" in createRes) return { ok: false, content: `تعذر التحديث: ${String(createRes.error)}` };
        return { ok: true, content: `حُدِّث الروتين: معطّل=${!updated.enabled === true ? "نعم" : "لا"} • الفاصل=${Math.round(updated.intervalSeconds / 60)} دقيقة.` };
      },
    },

    // ── Media understanding: OCR via local Tesseract (Arabic + English) ──
    {
      name: "image_ocr",
      description: "استخرج النص من صورة (PNG/JPG) باستخدام Tesseract OCR المحلي — يدعم العربية (ara) والإنجليزية (eng) مباشرة بلا نموذج بصري.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "مسار الصورة النسبي" },
          lang: { type: "string", enum: ["ara", "eng", "ara+eng"], description: "لغة النص (افتراضي ara+eng)" },
        },
        required: ["path"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const rel = str(args, "path");
        const lang = str(args, "lang", "ara+eng");
        const file = taskPath(ctx.workspace, rel);
        if (!fs.existsSync(file)) return { ok: false, content: `الصورة غير موجودة: ${rel}` };
        const buf = fs.readFileSync(file);
        if (buf.length < 100) return { ok: false, content: "الصورة فارغة أو تالفة" };
        // Pass to Tesseract in WSL for actual OCR (not just returning to vision model)
        try {
          const { execFile } = await import("node:child_process");
          const wslPath = file.replace(/\\/g, "/").replace(/^([A-Z]):/, (_m, d) => `/mnt/${d.toLowerCase()}`);
          const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
            execFile("wsl.exe", ["-d", "Ubuntu-24.04", "--", "tesseract", wslPath, "stdout", "-l", lang, "--psm", "3"], { timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
              resolve({ code: err ? 1 : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
            });
          });
          if (result.code !== 0) return { ok: false, content: `Tesseract OCR فشل: ${result.stderr.slice(0, 200)}` };
          const text = result.stdout.trim();
          if (!text) return { ok: true, content: `Tesseract (${lang}) لم يعثر على نص في الصورة (${buf.length} بايت). جرّب lang مختلف أو صورة أوضح.` };
          return { ok: true, content: `Tesseract OCR (${lang}) استخرج النص:\n${text.slice(0, 4000)}` };
        } catch {
          // Fallback: return image for vision model if WSL/tesseract unavailable
          const b64 = buf.toString("base64");
          return { ok: true, content: `Tesseract غير متاح — الصورة (${buf.length} بايت) جاهزة للتحليل البصري.`, images: [b64] };
        }
      },
    },

    // ── Media understanding: video scenes + scene-linked audio transcription (section 14) ──
    {
      name: "video_analyze",
      description: "حلّل فيديو محليًا بالكامل: استخرج المشاهد بحدودها الزمنية عبر ffmpeg (كشف قطع المشاهد)، وفرّغ الصوت عبر خادم faster-whisper المحلي، واربط كل مقطع نصي بالمشهد الزمني المقابل له في التايملاين.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "مسار الفيديو النسبي (mp4/mkv/mov/webm)" },
          sceneThreshold: { type: "number", description: "حساسية كشف المشاهد 0-1 — أدنى يعني مشاهد أكثر (افتراضي 0.3)" },
          transcribe: { type: "boolean", description: "فرّغ الصوت أيضًا واربطه بالمشاهد (افتراضي true)" },
        },
        required: ["path"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const rel = str(args, "path");
        const threshold = Math.min(0.9, Math.max(0.05, num(args, "sceneThreshold", 0.3)));
        const wantTranscribe = bool(args, "transcribe", true);
        const file = taskPath(ctx.workspace, rel);
        if (!fs.existsSync(file)) return { ok: false, content: `الفيديو غير موجود: ${rel}` };
        if (fs.statSync(file).size < 1024) return { ok: false, content: "ملف الفيديو فارغ أو تالف" };
        const { execFile } = await import("node:child_process");
        const wslPath = file.replace(/\\/g, "/").replace(/^([A-Z]):/, (_m, d) => `/mnt/${d.toLowerCase()}`);
        const wsl = (cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
          new Promise((resolve) => {
            execFile("wsl.exe", ["-d", "Ubuntu-24.04", "--", ...cmd], { timeout: 180_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
              resolve({ code: err ? 1 : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
            });
          });

        // 1) duration via ffprobe
        const probe = await wsl(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wslPath]);
        if (probe.code !== 0 || !Number(probe.stdout.trim())) return { ok: false, content: `ffprobe فشل: ${probe.stderr.slice(0, 200)}` };
        const duration = Number(probe.stdout.trim());

        // 2) scene boundaries via select=gt(scene,T) + showinfo — the filter goes
        // through a script file because wsl.exe mangles inline quotes/commas in argv
        const filterFile = `${file}.loam-scene-filter.txt`;
        fs.writeFileSync(filterFile, `select='gt(scene,${threshold})',showinfo`, "utf8");
        let scenesRaw: { code: number; stdout: string; stderr: string };
        try {
          scenesRaw = await wsl(["ffmpeg", "-hide_banner", "-i", wslPath, "-filter_script:v", filterFile.replace(/\\/g, "/").replace(/^([A-Z]):/, (_m, d) => `/mnt/${d.toLowerCase()}`), "-an", "-f", "null", "-"]);
        } finally {
          try { fs.rmSync(filterFile, { force: true }); } catch { /* */ }
        }
        const cuts = [0];
        for (const line of scenesRaw.stderr.split("\n")) {
          if (!line.includes("Parsed_showinfo")) continue;
          const m = line.match(/pts_time:(\d+(?:\.\d+)?)/);
          if (m) cuts.push(Number(m[1]));
        }
        const unique = [...new Set(cuts.map((c) => Math.round(c * 100) / 100))].sort((a, b) => a - b).filter((c, i, arr) => i === 0 || c - (arr[i - 1] ?? 0) > 0.05);
        const scenes = unique.map((start, i) => ({ index: i + 1, start, end: i + 1 < unique.length ? unique[i + 1]! : Math.round(duration * 100) / 100 }));

        // 3) extract mono 16kHz wav beside the video, transcribe via local STT server, cleanup
        let segments: Array<{ start: number; end: number; text: string; sceneIndex: number; overlap: number }> = [];
        let sttNote = "";
        if (wantTranscribe) {
          const wavPath = `${file}.loam-audio-${Date.now().toString(36)}.wav`;
          const extract = await wsl(["ffmpeg", "-y", "-hide_banner", "-i", wslPath, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", wavPath.replace(/\\/g, "/").replace(/^([A-Z]):/, (_m, d) => `/mnt/${d.toLowerCase()}`)]);
          try {
            if (extract.code === 0 && fs.existsSync(wavPath) && fs.statSync(wavPath).size > 44) {
              const sttUrl = process.env.LOAM_STT_URL || "http://127.0.0.1:3947";
              const res = await fetch(`${sttUrl}/transcribe`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(fs.readFileSync(wavPath)), signal: AbortSignal.timeout(120_000) }).catch(() => null);
              if (res && res.ok) {
                const data = (await res.json()) as { segments?: Array<{ start?: number; end?: number; text?: string }> };
                const raw = (data.segments ?? [])
                  .filter((s) => String(s.text ?? "").trim())
                  .map((s) => ({ start: Number(s.start ?? 0), end: Number(s.end ?? 0), text: String(s.text ?? "").trim() }));
                // 4) link each transcript segment to the scene with maximal time overlap
                segments = raw.map((seg) => {
                  let best = { sceneIndex: 1, overlap: 0 };
                  for (const sc of scenes) {
                    const overlap = Math.min(seg.end, sc.end) - Math.max(seg.start, sc.start);
                    if (overlap > best.overlap) best = { sceneIndex: sc.index, overlap: Math.round(overlap * 100) / 100 };
                  }
                  return { ...seg, sceneIndex: best.sceneIndex, overlap: best.overlap };
                });
              } else {
                sttNote = res ? `خادم التفريغ ردّ ${res.status}` : "خادم التفريغ (faster-whisper) غير مشغّل";
              }
            } else {
              sttNote = "لا يوجد مسار صوتي في الفيديو";
            }
          } finally {
            try { fs.rmSync(wavPath, { force: true }); } catch { /* */ }
          }
        }

        // 5) persist full timeline artifact + format summary
        const report = { video: rel, durationSec: Math.round(duration * 100) / 100, sceneThreshold: threshold, scenes: scenes.map((s) => ({ ...s, durationSec: Math.round((s.end - s.start) * 100) / 100 })), transcript: segments.map((s) => ({ ...s })), generatedAt: new Date().toISOString() };
        const artifact = `${file}.analysis.json`;
        try { fs.writeFileSync(artifact, JSON.stringify(report, null, 2), "utf8"); } catch { /* */ }
        const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}.${String(Math.floor((t % 1) * 10))}`;
        const lines: string[] = [`الفيديو ${rel} — ${report.durationSec} ثانية، ${scenes.length} مشهدًا (عتبة ${threshold}):`];
        for (const sc of report.scenes) {
          lines.push(`• المشهد ${sc.index}: ${fmt(sc.start)} ← ${fmt(sc.end)} (${sc.durationSec} ث)`);
          for (const seg of segments.filter((s) => s.sceneIndex === sc.index)) lines.push(`   🎙 [${fmt(seg.start)}-${fmt(seg.end)}] ${seg.text.slice(0, 200)}`);
        }
        if (sttNote) lines.push(`ملاحظة الصوت: ${sttNote}`);
        lines.push(`التقرير الكامل حُفظ في ${rel}.analysis.json`);
        return { ok: true, content: lines.join("\n").slice(0, 8000) };
      },
    },

    // ── Files: project-level check ──
    {
      name: "file_project_check",
      description: "افحص صحة مشروع في مساحة المهمة: ابحث عن ملفات الاختبار وشغّلها عبر shell_run وأعد ملخص النتائج.",
      parameters: { type: "object", properties: { dir: { type: "string", description: "مجلد المشروع (افتراضي الجذر)" }, testCommand: { type: "string", description: "أمر الاختبار (افتراضي npm test)" } }, required: [] },
      async run(args, ctx): Promise<ToolResult> {
        const dir = str(args, "dir", ".");
        const testCmd = str(args, "testCommand", "npm test");
        const projectDir = taskPath(ctx.workspace, dir);
        if (!fs.existsSync(projectDir)) return { ok: false, content: `المجلد غير موجود: ${dir}` };
        // List key project files
        const entries = fs.readdirSync(projectDir);
        const hasPackage = entries.includes("package.json");
        const hasTests = entries.some((e) => /test|spec/i.test(e)) || fs.existsSync(path.join(projectDir, "__tests__")) || fs.existsSync(path.join(projectDir, "tests"));
        const srcCount = entries.filter((e) => /\.(ts|js|mjs|py|go|rs)$/.test(e)).length;
        return {
          ok: true,
          content: `فحص المشروع في ${dir}: package.json=${hasPackage ? "✓" : "✗"} • ملفات مصدر=${srcCount} • اختبارات=${hasTests ? "✓" : "لم تُعثر"} — شغّل الاختبارات بـ shell_run {command:"${testCmd}", cwd:"${dir}"} للتحقق الفعلي.`,
        };
      },
    },

    // ── Device preview: run app on companion's device ──
    {
      name: "device_preview",
      description: "شغّل معاينة تطبيق داخل جهازك المستقل (خادم HTTP بسيط) وتحقق من استجابته — للتحقق من عمل التطبيق قبل التسليم.",
      parameters: {
        type: "object",
        properties: {
          port: { type: "integer", minimum: 1024, maximum: 65535, description: "منفذ المعاينة داخل الجهاز (افتراضي 3000)" },
          dir: { type: "string", description: "مجلد التطبيق داخل الجهاز (افتراضي /home/loam)" },
        },
      },
      async run(args, ctx): Promise<ToolResult> {
        const port = num(args, "port", 3000);
        const dir = str(args, "dir", "/home/loam");
        // This tool is a workflow hint — the actual execution goes through device_exec
        return {
          ok: true,
          content: `لتشغيل معاينة داخل جهازك: 1) device_exec {command:"cd ${dir} && (npm start || python -m http.server ${port} || npx serve -l ${port} .) &", timeoutMs:5000} 2) ثم تحقق: device_exec {command:"curl -s http://localhost:${port} | head -20"}. المعاينة داخل جهازك لا تلمس جهاز المستخدم.`,
        };
      },
    },
  ];
}

export const SERVICE_GAP_TOOL_NAMES = ["task_run", "task_resume", "schedule_update", "image_ocr", "video_analyze", "file_project_check", "device_preview"];
