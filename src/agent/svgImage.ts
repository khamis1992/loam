import path from "node:path";
import type { Config } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import type { Emit, Usage } from "./events.js";
import type { ToolRegistry } from "../tools/registry.js";
import { requireTaskWorkspace, taskPath } from "../server/taskWorkspace.js";
import { writePackProject } from "../packs/present.js";
import { completePackTask } from "../tools/finishTools.js";
import { chatWithFallback } from "./model.js";

export function svgImageRequest(prompt: string, mode: string): boolean {
  return mode === "media" && /\bSVG\b|Scalable Vector|رسوم\s*متجهة|شعار\s*هندسي/i.test(prompt);
}

interface SvgImageOptions {
  cfg: Config;
  ollama: OllamaClient;
  tools: ToolRegistry;
  emit: Emit;
  prompt: string;
  taskId: string;
  signal?: AbortSignal;
  model?: string;
}

export interface SvgImageResult {
  text: string;
  steps: number;
  model: string;
  usage: Usage;
  verified: true;
}

function validSvg(content: string): string {
  const raw = content.trim().replace(/^```(?:svg|xml)?\s*/i, "").replace(/```$/, "").trim();
  const start = raw.search(/<svg[\s>]/i);
  const end = raw.toLowerCase().lastIndexOf("</svg>");
  if (start < 0 || end < 0) throw new Error("generated SVG is incomplete");
  const svg = raw.slice(start, end + 6).trim();
  if (svg.length < 100 || svg.length > 60_000) throw new Error("generated SVG is empty or too large");
  if (/<script|javascript:|<foreignObject|(?:href|src)\s*=\s*["']https?:/i.test(svg)) throw new Error("generated SVG contains active or external content");
  return svg;
}

export async function runSvgImageFastPath(opts: SvgImageOptions): Promise<SvgImageResult> {
  const root = requireTaskWorkspace(opts.taskId, opts.cfg.workspace);
  const arabic = /[\u0590-\u08ff]/.test(opts.prompt);
  const usage: Usage = { promptTokens: 0, completionTokens: 0, durationMs: 0 };
  let generated: Awaited<ReturnType<typeof chatWithFallback>> | undefined;
  let svg = "";
  let failure: unknown;
  for (let attempt = 0; attempt < 2 && !svg; attempt += 1) {
    generated = await chatWithFallback({
      cfg: opts.cfg,
      ollama: opts.ollama,
      messages: [
        { role: "system", content: attempt === 0 ? "Return only one complete standalone SVG document, without Markdown or explanation. Use original geometric vector paths, accessible title/desc, no scripts, no external assets, no foreignObject, no raster image and no placeholders. Keep it below 2000 tokens and close the svg element." : "Return only one COMPLETE SVG in at most 1200 tokens. Use simple original vector geometry, title/desc, no scripts, no external assets, no foreignObject and no placeholders. Close the svg element before finishing." },
        { role: "user", content: opts.prompt },
      ],
      temperature: 0.25,
      numPredict: attempt === 0 ? 2_500 : 1_500,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    usage.promptTokens += generated.usage.promptTokens;
    usage.completionTokens += generated.usage.completionTokens;
    usage.durationMs += generated.usage.durationMs;
    try {
      svg = validSvg(generated.content);
    } catch (error) {
      failure = error;
    }
  }
  let relative = "";
  let usedFallback = false;
  if (!svg) {
    usedFallback = true;
    opts.emit({ type: "task-status", status: arabic ? "المخرج المخصص لم يكتمل؛ سيُستخدم مولّد SVG المحلي المتحقق منه." : "The custom model output was incomplete; the verified local SVG generator will be used." });
    opts.emit({ type: "tool_call", name: "image_generate", args: { prompt: opts.prompt, format: "svg" } });
    const fallback = await opts.tools.exec("image_generate", { prompt: opts.prompt, title: "Vector artwork", format: "svg" }, { cfg: opts.cfg, workspace: root, emit: opts.emit, taskId: opts.taskId, packId: "loam-image", ...(opts.signal ? { signal: opts.signal } : {}) });
    opts.emit({ type: "tool_result", name: "image_generate", ok: fallback.ok, summary: fallback.content.slice(0, 500) });
    if (!fallback.ok) throw failure instanceof Error ? failure : new Error(fallback.content);
    const output = JSON.parse(fallback.content) as { path?: unknown };
    if (typeof output.path !== "string" || !output.path.endsWith(".svg")) throw new Error("local SVG generator returned no file");
    relative = output.path;
  } else {
    relative = `uploads/vector-${Date.now()}.svg`;
    taskPath(root, relative);
    if (!opts.tools.get("file_write")) throw new Error("file_write is unavailable for SVG output");
    opts.emit({ type: "tool_call", name: "file_write", args: { path: relative } });
    const written = await opts.tools.exec("file_write", { path: relative, content: svg }, { cfg: opts.cfg, workspace: root, emit: opts.emit, taskId: opts.taskId, packId: "loam-image", ...(opts.signal ? { signal: opts.signal } : {}) });
    opts.emit({ type: "tool_result", name: "file_write", ok: written.ok, summary: written.content.slice(0, 500) });
    if (!written.ok) throw new Error(written.content);
    writePackProject(root, { projectId: opts.taskId, packId: "loam-image", revision: 0, items: [{ id: "image-1", state: "final", path: relative }], data: { format: "svg", generator: "model-vector-fast-path" } });
  }
  const completion = await completePackTask({ cfg: opts.cfg, workspace: root, emit: opts.emit, taskId: opts.taskId, packId: "loam-image", ...(opts.signal ? { signal: opts.signal } : {}) }, [relative]);
  if (!completion.ok) throw new Error(`image_present failed: ${completion.content}`);
  const resourceUri = completion.pack?.ok ? completion.pack.uri : "";
  const text = (arabic ? `تم إنشاء ملف SVG والتحقق منه${usedFallback ? " باستخدام مولّد SVG المحلي" : ""}:\n\n${relative}` : `Created and verified the SVG${usedFallback ? " with the local SVG generator" : ""}:\n\n${relative}`) + (resourceUri ? `\n\n${resourceUri}` : "");
  opts.emit({ type: "verify", verdict: "pass", reason: usedFallback ? "Local SVG generator produced a real file after the custom model output was incomplete." : `Standalone SVG verified (${svg.length} characters, no active or external content).` });
  opts.emit({ type: "assistant_message", text });
  const resultModel = generated?.model ?? "local-svg";
  opts.emit({ type: "done", text, steps: 1, model: resultModel });
  return { text, steps: 1, model: resultModel, usage, verified: true };
}
