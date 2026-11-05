import type { Config } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import type { Emit, Usage } from "./events.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PackId } from "../packs/types.js";
import { requireTaskWorkspace, taskPath } from "../server/taskWorkspace.js";
import { readPackProject } from "../packs/present.js";
import { completePackTask } from "../tools/finishTools.js";
import { chatWithFallback } from "./model.js";
import { extractJson } from "./planner.js";

export function staticWebsiteRequest(prompt: string, mode: string): boolean {
  if (mode !== "build") return false;
  if (!/static|ثابت|landing\s*page|صفحة\s*(?:هبوط|تعريفية)|موقع\s*تعريفي/i.test(prompt)) return false;
  return !/dashboard|لوحة\s*تحكم|backend|قاعدة\s*بيانات|متجر\s*متكامل/i.test(prompt);
}

interface StaticWebsiteOptions {
  cfg: Config;
  ollama: OllamaClient;
  tools: ToolRegistry;
  emit: Emit;
  prompt: string;
  taskId: string;
  packId?: PackId;
  signal?: AbortSignal;
  model?: string;
}

export interface StaticWebsiteResult {
  text: string;
  steps: number;
  model: string;
  usage: Usage;
  verified: true;
}

function requestedTitle(prompt: string): string {
  return prompt.match(/«([^»]{1,100})»/)?.[1]?.trim() || "Loam Website";
}

function htmlFromModel(value: unknown, raw: string, title: string, prompt: string): string {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const rawHtml = raw.trim().replace(/^```(?:html)?\s*/i, "").replace(/```$/, "").trim();
  const html = typeof record?.html === "string" ? record.html.trim() : rawHtml;
  if (html.length < 500 || html.length > 50_000) throw new Error("static website HTML is empty or exceeds the 50 KB budget");
  if (!/<html[\s>]/i.test(html) || !/<title>[^<]+<\/title>/i.test(html) || !/<body[\s\S]*<\/body>/i.test(html)) throw new Error("static website must be a complete HTML document");
  if (!html.includes(title)) throw new Error("static website does not contain the requested title");
  if (/<script[^>]+src\s*=|(?:lorem ipsum|عنصر نائب|<placeholder\b)/i.test(html)) throw new Error("static website contains an external script or placeholder content");
  if (/حجز|reserve|reservation|book/i.test(prompt) && !/<(?:button|a)\b/i.test(html)) throw new Error("static website is missing the requested reservation action");
  return html;
}

export async function runStaticWebsiteFastPath(opts: StaticWebsiteOptions): Promise<StaticWebsiteResult> {
  const root = requireTaskWorkspace(opts.taskId, opts.cfg.workspace);
  const title = requestedTitle(opts.prompt);
  const arabic = /[\u0590-\u08ff]/.test(opts.prompt);
  const usage: Usage = { promptTokens: 0, completionTokens: 0, durationMs: 0 };
  const plan = [
    { id: "init", title: arabic ? "تهيئة مشروع الموقع" : "Initialize the website", instruction: "Attach one Loam Build project", successCriteria: "One project exists" },
    { id: "author", title: arabic ? "تصميم الصفحة" : "Author the page", instruction: "Generate one self-contained HTML page", successCriteria: "The complete page matches the brief" },
    { id: "preview", title: arabic ? "فحص المعاينة" : "Verify the preview", instruction: "Serve and capture mobile and desktop previews", successCriteria: "The page renders without browser errors" },
    { id: "present", title: arabic ? "تسليم الموقع" : "Present the website", instruction: "Checkpoint and publish the verified HTML", successCriteria: "The host gate accepts the artifact" },
  ];
  const emitPlan = (done: number) => opts.emit({ type: "plan", goal: title, trivial: false, source: "fallback", steps: plan.map((step, index) => ({ ...step, status: index < done ? "done" : index === done ? "doing" : "pending" })) });
  emitPlan(0);
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    opts.emit({ type: "tool_call", name, args });
    const result = await opts.tools.exec(name, args, {
      cfg: opts.cfg,
      workspace: root,
      emit: opts.emit,
      taskId: opts.taskId,
      ...(opts.packId ? { packId: opts.packId } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    opts.emit({ type: "tool_result", name, ok: result.ok, summary: result.content.slice(0, 1200) });
    if (!result.ok) throw new Error(result.content);
    return result.content;
  };

  await call("site_init", { title, scaffold: true });
  emitPlan(1);
  let generated: Awaited<ReturnType<typeof chatWithFallback>> | undefined;
  let html = "";
  let failure: unknown;
  for (let attempt = 0; attempt < 2 && !html; attempt += 1) {
    generated = await chatWithFallback({
      cfg: opts.cfg,
      ollama: opts.ollama,
      messages: [
        { role: "system", content: attempt === 0 ? "Return only one COMPLETE static HTML document, without Markdown fences or explanation. Use at most 2400 tokens, concise inline CSS and inline SVG, no external dependencies or placeholders. Build a polished responsive page with strong contrast and accessible actions. Use Arabic RTL when requested. Close every element including body and html." : "Return only one COMPLETE static HTML document in at most 1600 tokens, without Markdown or explanation. Use concise inline CSS, three sections and one simple inline SVG. No external dependencies or placeholders. Close every element including body and html. Use Arabic RTL when requested." },
        { role: "user", content: opts.prompt },
      ],
      temperature: 0.25,
      numPredict: attempt === 0 ? 3_000 : 2_000,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    usage.promptTokens += generated.usage.promptTokens;
    usage.completionTokens += generated.usage.completionTokens;
    usage.durationMs += generated.usage.durationMs;
    try {
      html = htmlFromModel(extractJson(generated.content), generated.content, title, opts.prompt);
    } catch (error) {
      failure = error;
    }
  }
  if (!generated || !html) throw failure instanceof Error ? failure : new Error("static website generation failed");
  await call("file_write", { path: "index.html", content: html });
  emitPlan(2);
  const preview = await call("preview_serve", { dir: "." });
  await call("preview_screenshot", { viewports: [{ name: "mobile", width: 375, height: 812 }, { name: "desktop", width: 1440, height: 900 }], fullPage: true, waitMs: 250 });
  await call("site_checkpoint", {});
  const project = readPackProject(root, "loam-build");
  if (!project) throw new Error("site project is missing before presentation");
  const completion = await completePackTask({ cfg: opts.cfg, workspace: root, emit: opts.emit, taskId: opts.taskId, packId: "loam-build", ...(opts.signal ? { signal: opts.signal } : {}) }, ["index.html"]);
  if (!completion.ok) throw new Error(`site presentation failed: ${completion.content}`);
  const resourceUri = completion.pack?.ok ? completion.pack.uri : "";
  taskPath(root, "index.html");
  emitPlan(4);
  const previewUrl = preview.match(/https?:\/\/[^\s]+/)?.[0];
  const text = (arabic
    ? `تم إنشاء موقع «${title}» والتحقق من معاينته على الجوال وسطح المكتب:\n\nindex.html${previewUrl ? `\n${previewUrl}` : ""}`
    : `Created and verified ${title} on mobile and desktop:\n\nindex.html${previewUrl ? `\n${previewUrl}` : ""}`) + (resourceUri ? `\n\n${resourceUri}` : "");
  opts.emit({ type: "verify", verdict: "pass", reason: "Static HTML passed mobile and desktop preview checks and the Loam Build presentation gate." });
  opts.emit({ type: "assistant_message", text });
  opts.emit({ type: "done", text, steps: 4, model: generated.model });
  return { text, steps: 4, model: generated.model, usage, verified: true };
}
