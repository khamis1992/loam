/**
 * Per-run companion-device tools (frontier stage 2). Bound at run start to the
 * agent's OWN device only — every command, read and write executes inside the
 * isolated environment (separate processes/filesystem/user), never on the
 * user's machine. push/pull bridge files between the device and the task
 * workspace so work survives switching work modes.
 */
import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";
import { DeviceManager, DEVICE_USER, type CompanionDeviceRecord } from "../server/companionDevices.js";
import { resolveSecret } from "../server/secretsVault.js";
import { taskPath } from "../server/taskWorkspace.js";
import { bashPath } from "../policy/bashPath.js";

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string): string => Buffer.from(s, "base64").toString("utf8");

const deviceHome = "/home/loam";

function deviceError(res: { error: string }): ToolResult {
  return { ok: false, content: res.error };
}

export function createDeviceTools(manager: DeviceManager, device: CompanionDeviceRecord, agentId?: string): Tool[] {
  const exec = async (command: string, timeoutMs?: number) => manager.agentExec(device, command, timeoutMs);

  const tool = (name: string, description: string, parameters: Record<string, unknown>, run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>): Tool => ({
    name,
    description: `${description} (جهازك المستقل «${device.name}» — ${device.template})`,
    parameters,
    run,
  });

  return [
    tool("device_exec", "نفّذ أمر shell داخل جهازك المستقل المعزول (bash -lc). النتائج تعود بنص المخرجات ورمز الخروج.", {
      type: "object",
      properties: {
        command: { type: "string", description: "الأمر كما يُكتب في bash" },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000, description: "مهلة اختيارية بالميلي ثانية (افتراضي 120000)" },
      },
      required: ["command"],
    }, async (args, ctx) => {
      const command = str(args, "command");
      if (!command.trim()) return { ok: false, content: "command required" };
      if (ctx.signal?.aborted) return { ok: false, content: "⏹ أُلغي قبل التنفيذ" };
      // Race the exec against cancellation so a user stop interrupts long commands.
      const execP = exec(command, typeof args.timeoutMs === "number" ? args.timeoutMs : undefined);
      const cancelP = new Promise<never>((_, rej) => {
        ctx.signal?.addEventListener("abort", () => rej(new Error("cancelled")), { once: true });
      });
      try {
        const res = await Promise.race([execP, cancelP]);
        if ("error" in res) return deviceError(res);
        const text = [res.stdout, res.stderr].filter((s) => s.trim()).join("\n");
        return { ok: res.code === 0, content: res.code === 0 ? text || "(لا مخرجات)" : `(exit ${res.code})\n${text}` };
      } catch {
        return { ok: false, content: "⏹ أُلغي الأمر داخل الجهاز بناءً على طلبك (العملية البعيدة قد تكمل حتى نهايتها)" };
      }
    }),

    tool("device_read_file", "اقرأ ملفًا من جهازك المستقل (نص عبر base64 فيصل سليمًا).", {
      type: "object",
      properties: { path: { type: "string", description: `مسار مطلق داخل الجهاز (مثل ${deviceHome}/report.md)` }, maxBytes: { type: "integer", minimum: 100, maximum: 512000 } },
      required: ["path"],
    }, async (args) => {
      const p = str(args, "path");
      const res = await exec(`base64 -w0 ${bashPath(p)}`);
      if ("error" in res) return deviceError(res);
      if (res.code !== 0) return { ok: false, content: `تعذر قراءة ${p}: ${res.stderr}` };
      const text = unb64(res.stdout);
      const max = typeof args.maxBytes === "number" ? args.maxBytes : 64000;
      return { ok: true, content: text.length > max ? `${text.slice(0, max)}\n[...اقتُطع ${text.length - max} حرفًا]` : text };
    }),

    tool("device_write_file", "اكتب ملفًا داخل جهازك المستقل (المجلدات الأصل تُنشأ تلقائيًا).", {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    }, async (args) => {
      const p = str(args, "path");
      const content = str(args, "content");
      const dir = path.posix.dirname(p);
      const res = await exec(`mkdir -p ${bashPath(dir)} && printf %s ${b64(content)} | base64 -d > ${bashPath(p)} && wc -c < ${bashPath(p)}`);
      if ("error" in res) return deviceError(res);
      return { ok: res.code === 0, content: res.code === 0 ? `كُتب ${p} (${res.stdout.trim()} بايت داخل جهازك)` : `فشل الكتابة: ${res.stderr}` };
    }),

    tool("device_list_files", "اعرض محتويات مجلد داخل جهازك المستقل.", {
      type: "object",
      properties: { path: { type: "string", description: `افتراضي ${deviceHome}` } },
    }, async (args) => {
      const p = str(args, "path") || deviceHome;
      const res = await exec(`ls -la --time-style=+long-iso ${bashPath(p)}`);
      if ("error" in res) return deviceError(res);
      return { ok: res.code === 0, content: res.code === 0 ? res.stdout || "(مجلد فارغ)" : `تعذر عرض ${p}: ${res.stderr}` };
    }),

    tool("device_pull_file", "انسخ ملفًا من جهازك المستقل إلى مساحة مهمة Loam (ليصل للمستخدم ولتسليمه). يعيد المسار النسبي في المهمة.", {
      type: "object",
      properties: { path: { type: "string", description: "مسار الملف داخل الجهاز" }, as: { type: "string", description: "اسم اختياري للنسخة في المهمة" } },
      required: ["path"],
    }, async (args, ctx) => {
      const p = str(args, "path");
      const res = await exec(`base64 -w0 ${bashPath(p)}`);
      if ("error" in res) return deviceError(res);
      if (res.code !== 0) return { ok: false, content: `تعذر قراءة ${p} من الجهاز: ${res.stderr}` };
      const name = str(args, "as") || path.posix.basename(p) || "device-file";
      const outDir = taskPath(ctx.workspace, "device-files");
      fs.mkdirSync(outDir, { recursive: true });
      const safe = path.basename(name).replace(/[^\w.\u0600-\u06ff -]+/g, "_").slice(0, 120) || "device-file";
      const out = taskPath(ctx.workspace, path.join("device-files", `${Date.now()}-${safe}`));
      fs.writeFileSync(out, Buffer.from(res.stdout, "base64"));
      return { ok: true, content: `نُسخ الملف إلى مساحة المهمة: ${path.relative(ctx.workspace, out).split(path.sep).join("/")}` };
    }),

    ...(agentId
      ? [
          tool("device_write_secret", "اكتب سرًا من خزنة هذا المساعد إلى ملف داخل جهازك المستقل. القيمة تُحل في الخادم ولا تمر عبر النموذج أو السجلات — اطلب من المستخدم إضافة السر من لوحة الأسرار إن لم يوجد.", {
            type: "object",
            properties: {
              name: { type: "string", description: "اسم السر في الخزنة" },
              path: { type: "string", description: "مسار الملف داخل الجهاز (افتراضي /home/loam/.secrets/<الاسم> بصلاحية 600)" },
            },
            required: ["name"],
          }, async (args) => {
            const name = str(args, "name").trim();
            if (!/^[A-Za-z0-9_.-]{1,48}$/.test(name)) return { ok: false, content: "اسم سر غير صالح" };
            const value = resolveSecret(agentId, name);
            if (value === null) return { ok: false, content: `السر «${name}» غير موجود في خزنة هذا المساعد — اطلب من المستخدم إضافته من لوحة الأسرار في صفحة الرفقاء.` };
            const dest = str(args, "path") || `${deviceHome}/.secrets/${name}`;
            const b64value = Buffer.from(value, "utf8").toString("base64");
            const res = await exec(`mkdir -p ${bashPath(path.posix.dirname(dest))} && printf %s ${b64value} | base64 -d > ${bashPath(dest)} && chmod 600 ${bashPath(dest)} && echo written`);
            if ("error" in res) return deviceError(res);
            return { ok: res.code === 0, content: res.code === 0 ? `كُتب السر «${name}» إلى ${dest} داخل جهازك (القيمة لم تمر عبر السياق).` : `فشلت كتابة السر: ${res.stderr}` };
          }),
        ]
      : []),
    tool("device_push_file", "ارفع ملفًا من مساحة مهمة Loam إلى جهازك المستقل (مثل بيانات يحتاجها العمل المنفصل).", {
      type: "object",
      properties: { path: { type: "string", description: "مسار نسبي للملف في مساحة المهمة" }, to: { type: "string", description: `مسار الوجهة داخل الجهاز (افتراضي ${deviceHome}/inbox/<الاسم>)` } },
      required: ["path"],
    }, async (args, ctx) => {
      const rel = str(args, "path");
      const src = taskPath(ctx.workspace, rel);
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return { ok: false, content: `الملف غير موجود في مساحة المهمة: ${rel}` };
      const dest = str(args, "to") || `${deviceHome}/inbox/${path.basename(rel)}`;
      const content = fs.readFileSync(src).toString("base64");
      const res = await exec(`mkdir -p ${bashPath(path.posix.dirname(dest))} && printf %s ${content} | base64 -d > ${bashPath(dest)} && wc -c < ${bashPath(dest)}`);
      if ("error" in res) return deviceError(res);
      return { ok: res.code === 0, content: res.code === 0 ? `رُفع ${rel} إلى ${dest} داخل جهازك` : `فشل الرفع: ${res.stderr}` };
    }),
  ];
}

export const DEVICE_TOOL_NAMES = ["device_exec", "device_read_file", "device_write_file", "device_list_files", "device_pull_file", "device_push_file", "device_write_secret"];
export { DEVICE_USER };
