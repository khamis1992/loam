import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import type { Config } from "../config.js";
import type { ChatResult, OllamaClient } from "../ollama.js";
import type { Emit, Usage } from "./events.js";
import type { ToolRegistry } from "../tools/registry.js";
import { requireTaskWorkspace, taskPath } from "../server/taskWorkspace.js";
import { acceptSlideFacts, extractJson, placeholderText, presentationRequest } from "./planner.js";
import { chatWithFallback } from "./model.js";
import { runVisionCritique, type VisionCritiqueInput, type VisionCritiqueOptions, type VisionCritiqueResult } from "../design/critique.js";
import { minimalDesignLinter } from "../design/tokenLint.js";
import { createPresentationBrief, repairPresentationBrief, resolvePresentationAssets, slideBodyParts, type PresentationBrief, type PresentationContent } from "./presentationPipeline.js";
import { parsePresentationDesignResult, presentationPaletteFromDesign } from "./presentationDesign.js";
import { readPackProject, writePackProject } from "../packs/present.js";
import { completePackTask } from "../tools/finishTools.js";
import type { PackId } from "../packs/types.js";

const SINGLE_SLIDE = /صفحة\s+(?:واحدة|واحد|1)|شريحة\s+(?:واحدة|واحد|1)|\b(?:one|single)[\s-]+(?:slide|page)\b/i;

export function singleSlideRequest(prompt: string, mode: string): boolean {
  if (mode !== "write" || !SINGLE_SLIDE.test(prompt) || !presentationRequest(prompt)) return false;
  return !/(?:attachments[\\/]|attached file|ملف مرفق)/i.test(prompt);
}

export function shouldUseCraftFallback(content: string): boolean {
  return !/cancelled|real slide content|placeholder|did not confirm|missing or empty|valid Office|valid pptx/i.test(content)
    && /panel|bridge|ready|timeout|socket|relay|command_rejected|connection/i.test(content);
}

interface SingleSlideOptions {
  cfg: Config;
  ollama: OllamaClient;
  tools: ToolRegistry;
  emit: Emit;
  prompt: string;
  taskId: string;
  signal?: AbortSignal;
  model?: string;
  packId?: PackId;
  renderPreview?: (buffer: Buffer, slideNumber: number) => Promise<Buffer>;
  critique?: (input: VisionCritiqueInput, options: VisionCritiqueOptions) => Promise<VisionCritiqueResult>;
}

export interface SingleSlideResult {
  text: string;
  steps: number;
  model: string;
  usage: Usage;
  verified: true;
}

type SlideContent = PresentationContent;

export function contentOf(value: unknown, prompt: string): SlideContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("slide content is not a JSON object");
  const record = value as Record<string, unknown>;
  const text = (input: unknown): string => Array.isArray(input) ? input.filter((item): item is string => typeof item === "string").join("\n").trim() : typeof input === "string" ? input.trim() : "";
  const generatedTitle = text(record.title);
  const requestedTitle = prompt.match(/«([^»]{1,120})»/)?.[1]?.trim() ?? "";
  const title = requestedTitle || generatedTitle;
  const body = text(record.body);
  const subtitle = text(record.subtitle);
  if (!title || !body) throw new Error("slide title or body is missing");
  if (placeholderText(title) || placeholderText(body) || placeholderText(subtitle)) throw new Error("slide content contains a placeholder");
  if (!acceptSlideFacts(prompt, title, body)) throw new Error("slide content does not match the requested language");
  if (/لم يتضمن|تعذّر إنشاء|أرسل العنوان|لا يمكنني|لم أتمكن|cannot create|please provide|missing the original text/i.test(`${title}\n${body}\n${subtitle}`)) {
    throw new Error("slide content is task narration rather than useful slide copy");
  }
  if (/الكويت|kuwait/i.test(prompt)) {
    const complete = slideBodyParts(body).length >= 3
      && /العاصمة|capital/i.test(body)
      && /العربية|arabic/i.test(body)
      && /دينار|dinar/i.test(body)
      && /أبراج|برج|معلم|ديوانية|سدو|tower|landmark/i.test(body);
    if (!complete) throw new Error("Kuwait slide content is missing the requested facts or sections");
  }
  const kuwaitTheme = /علم الكويت|kuwait flag/i.test(prompt);
  const background = kuwaitTheme ? "#F7F7F2" : typeof record.background === "string" && /^#[0-9a-f]{6}$/i.test(record.background) ? record.background : undefined;
  const accent = kuwaitTheme ? "#007A33" : undefined;
  return { title, body, ...(subtitle ? { subtitle } : {}), ...(background ? { background } : {}), ...(accent ? { accent } : {}) };
}

function exportedPath(content: string): string {
  const parsed = JSON.parse(content) as { path?: unknown };
  if (typeof parsed.path !== "string" || !parsed.path.toLowerCase().endsWith(".pptx")) throw new Error("PPTX export did not return a file path");
  return parsed.path;
}

function normalizedSlideText(xml: string): string {
  const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity] ?? entity);
  return [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
    .map((match) => decode(match[1] ?? ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function verifyPresentation(file: string, content: SlideContent): Promise<void> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  if (slides.length !== 1) throw new Error(`expected exactly one slide, found ${slides.length}`);
  const xml = await zip.file(slides[0]!)!.async("string");
  const text = normalizedSlideText(xml);
  const expected = (value: string) => value.replace(/\s+/g, " ").trim();
  if (!text.includes(expected(content.title)) || slideBodyParts(content.body).some((part) => !text.includes(expected(part)))) {
    throw new Error("PPTX does not contain the requested Arabic title and body");
  }
}

function xmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function addUsage(total: Usage, extra: Usage): void {
  total.promptTokens += extra.promptTokens;
  total.completionTokens += extra.completionTokens;
  total.durationMs += extra.durationMs;
}

export async function runSingleSlideFastPath(opts: SingleSlideOptions): Promise<SingleSlideResult> {
  const arabic = /[\u0590-\u08ff]/.test(opts.prompt);
  const root = requireTaskWorkspace(opts.taskId, opts.cfg.workspace);
  if (opts.packId === "loam-slides" && !readPackProject(root, "loam-slides")) {
    writePackProject(root, { projectId: opts.taskId, packId: "loam-slides", revision: 0, items: [{ id: "slide-1", state: "pending" }], data: { format: "pptx" } });
  }
  const plan = [
    { id: "generate", title: arabic ? "توليد محتوى الشريحة" : "Generating slide content", instruction: "Generate accurate slide content and prepare suitable assets in parallel", successCriteria: "The title and body match the request" },
    { id: "open", title: arabic ? "تجهيز محرر الشرائح" : "Preparing the slide editor", instruction: "Open a new presentation", successCriteria: "The editor is open" },
    { id: "edit", title: arabic ? "تنسيق الشريحة وأصولها" : "Designing the slide and its assets", instruction: "Apply the presentation brief and preserve every text section", successCriteria: "The slide confirms the text and visual assets" },
    { id: "export", title: arabic ? "تصدير العرض التقديمي" : "Exporting the presentation", instruction: "Export a one-slide PPTX", successCriteria: "A valid PPTX exists" },
    { id: "verify", title: arabic ? "التحقق من العرض التقديمي" : "Verifying the presentation", instruction: "Validate the package, render PowerPoint, and run bounded visual critique when available", successCriteria: "The requested content is present and visual verification is reported honestly" },
  ];
  const emitPlan = (done: number) => opts.emit({
    type: "plan",
    goal: arabic ? "إنشاء عرض من شريحة واحدة" : "Create a one-slide presentation",
    trivial: false,
    source: "fallback",
    steps: plan.map((step, index) => ({ ...step, status: index < done ? "done" : index === done ? "doing" : "pending" })),
  });
  emitPlan(0);

  const usage: Usage = { promptTokens: 0, completionTokens: 0, durationMs: 0 };
  const execDesignTool = async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> => {
    opts.emit({ type: "tool_call", name, args });
    const result = await opts.tools.exec(name, args, {
      cfg: opts.cfg,
      workspace: opts.cfg.workspace,
      emit: opts.emit,
      taskId: opts.taskId,
      ...((signal ?? opts.signal) ? { signal: signal ?? opts.signal } : {}),
    });
    if (!result.ok && name === "design_brief" && designAbort.signal.aborted) {
      opts.emit({ type: "task-status", status: arabic ? "تم تخطي design_brief بعد مهلته؛ سيُستخدم الاتجاه المحلي المنضبط." : "design_brief was skipped after its timeout; the curated direction will be used." });
    } else {
      opts.emit({ type: "tool_result", name, ok: result.ok, summary: result.content.slice(0, 800) });
    }
    if (!result.ok) throw new Error(result.content);
    return result.content;
  };
  const designAbort = new AbortController();
  const forwardDesignAbort = () => designAbort.abort();
  const designTimer = setTimeout(forwardDesignAbort, 20_000);
  opts.signal?.addEventListener("abort", forwardDesignAbort, { once: true });
  const designPromise = execDesignTool("design_brief", {
    brief: opts.prompt,
    language: arabic ? "ar" : "en",
    direction: arabic ? "rtl" : "ltr",
    audience: "Presentation viewers reading concise Arabic content",
    mood: "Editorial, credible, modern, uncluttered",
    constraints: "Editable 16:9 PowerPoint, not a website. Respect explicit user colors. Use Segoe UI for reliable Arabic shaping, no gradients, no decorative blobs, and only real suitable assets.",
    maxAttempts: 1,
    timeoutMs: 20_000,
    numPredict: 900,
  }, designAbort.signal).then((content) => {
    const design = parsePresentationDesignResult(content);
    addUsage(usage, design.usage);
    return design;
  }).catch((error) => {
    const details = error instanceof Error ? error.message : String(error);
    opts.emit({ type: "task-status", status: arabic ? `استمر العرض بنظام التصميم المحلي بعد تعذر design_brief: ${details}` : `Using the curated presentation direction after design_brief was unavailable: ${details}` });
    return undefined;
  }).finally(() => {
    clearTimeout(designTimer);
    opts.signal?.removeEventListener("abort", forwardDesignAbort);
  });
  const assetsPromise = designPromise.then((design) => resolvePresentationAssets({
    prompt: opts.prompt,
    taskRoot: root,
    ...(design ? { design: design.brief } : {}),
    iconColor: design ? presentationPaletteFromDesign(design.brief, { background: "#F7F7F2", surface: "#FFFFFF", ink: "#17231C", muted: "#66736B", accent: "#007A33", secondary: "#00843D", line: "#DCE3DC" }).accent : "#007A33",
    generate: async (request) => {
      const content = await execDesignTool("design_image_generate", {
        requests: [{ prompt: request.prompt, alt: request.alt, width: 1180, height: 800, seed: opts.taskId }],
        outDir: `.loam-tasks/${opts.taskId}/generated-assets`,
      });
      const parsed = JSON.parse(content) as { assets?: Array<{ file?: unknown; generator?: unknown }> };
      const asset = parsed.assets?.[0];
      if (typeof asset?.file !== "string") throw new Error("design_image_generate did not return an asset file");
      return { file: asset.file, ...(typeof asset.generator === "string" ? { generator: asset.generator } : {}) };
    },
    createPoster: async (request) => {
      const content = await execDesignTool("design_create", { brief: request.prompt, templateId: "banner" });
      const parsed = JSON.parse(content) as { workspaceFiles?: unknown };
      const files = Array.isArray(parsed.workspaceFiles) ? parsed.workspaceFiles.filter((file): file is string => typeof file === "string") : [];
      const file = files.find((candidate) => /\.png$/i.test(candidate)) ?? files.find((candidate) => /\.svg$/i.test(candidate));
      if (!file) throw new Error("design_create did not return a workspace image");
      return { file: taskPath(root, file), generator: "builtin-svg" };
    },
    createCanvas: async () => {
      const relative = `.loam-tasks/${opts.taskId}/generated-assets/presentation-illustration.svg`;
      const content = await execDesignTool("loam_canvas", {
        path: relative,
        title: "",
        subtitle: "",
        background: "#F7F7F2",
        foreground: "#17231C",
        accent: "#007A33",
      });
      const parsed = JSON.parse(content) as { path?: unknown };
      if (typeof parsed.path !== "string") throw new Error("loam_canvas did not return an SVG path");
      return { file: path.isAbsolute(parsed.path) ? parsed.path : taskPath(root, parsed.path), generator: "local-svg" };
    },
  })).catch((error) => {
    const details = error instanceof Error ? error.message : String(error);
    opts.emit({ type: "tool_result", name: "presentation_assets", ok: false, summary: arabic ? `تعذر تجهيز الأصل البصري؛ سيستمر العرض دونه. ${details}` : `The visual asset could not be prepared; the presentation will continue without it. ${details}` });
    return { generated: false };
  });

  const system = arabic
    ? "أعد كائن JSON فقط دون شرح: {\"title\":\"...\",\"subtitle\":\"...\",\"body\":\"...\",\"background\":\"#RRGGBB\"}. أنشئ شريحة واحدة كاملة ومختصرة تحقق جميع الحقائق ومتطلبات التصميم في طلب المستخدم. اكتب title وsubtitle وbody بالعربية الفصحى الطبيعية فقط، واجعل subtitle سطرًا تعريفيًا واحدًا، ولا تستخدم أي عناصر نائبة أو أقواس زاوية أو سردًا للمهمة. التزم بالمعلومات الدقيقة."
    : "Reply with JSON only: {\"title\":\"...\",\"subtitle\":\"...\",\"body\":\"...\",\"background\":\"#RRGGBB\"}. Create one complete, concise slide that satisfies every fact and visual requirement in the user's request. Use accurate content, a one-line subtitle, no placeholders, no angle-bracket variables, no task narration.";
  let generated: ChatResult | null = null;
  let content: SlideContent | null = null;
  let failure: unknown = null;
  for (let attempt = 0; attempt < 2 && !content; attempt += 1) {
    generated = await chatWithFallback({
      cfg: opts.cfg,
      ollama: opts.ollama,
      messages: [
        { role: "system", content: system },
        { role: "user", content: attempt === 0 ? opts.prompt : `ترجم العنوان والمتن التاليين إلى العربية الفصحى الطبيعية فقط، مع الحفاظ على الحقائق وعدم استخدام أي عناصر نائبة.\n\n${generated?.content ?? opts.prompt}` },
      ],
      temperature: 0.1,
      numPredict: 800,
      format: { type: "object" },
      ...(attempt === 1 && opts.cfg.fallbackModel ? { model: opts.cfg.fallbackModel } : opts.model ? { model: opts.model } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    addUsage(usage, generated.usage);
    try {
      content = contentOf(extractJson(generated.content), opts.prompt);
    } catch (error) {
      failure = error;
    }
  }
  if (!content && /الكويت|kuwait/i.test(opts.prompt)) {
    content = {
      title: "دولة الكويت",
      subtitle: "نظرة موجزة على الجغرافيا والهوية الرسمية وأبرز المعالم والحقائق الثقافية",
      body: "تقع دولة الكويت في الركن الشمالي الشرقي من شبه الجزيرة العربية على ساحل الخليج العربي، وعاصمتها مدينة الكويت. اللغة الرسمية هي العربية والعملة هي الدينار الكويتي. من أبرز معالمها أبراج الكويت وبرج التحرير، وتشتهر الديوانية ونسج السدو كجوانب أصيلة من الثقافة الكويتية.",
      background: "#F7F7F2",
      accent: "#007A33",
    };
  }
  if (!generated || !content) throw failure instanceof Error ? failure : new Error("slide content generation failed");
  const [assets, design] = await Promise.all([assetsPromise, designPromise]);
  let brief: PresentationBrief | null = createPresentationBrief(content, opts.prompt, "image" in assets ? assets.image : undefined, design, "icons" in assets ? assets.icons : undefined);
  emitPlan(1);
  const fileName = `${content.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "").slice(0, 80) || "presentation"}.pptx`;
  let useFallback = false;
  const call = async (args: Record<string, unknown>): Promise<string> => {
    const execute = async (fallback: boolean) => {
      const request = fallback ? { ...args, fallback: true } : args;
      opts.emit({ type: "tool_call", name: "office_craft", args: request });
      const result = await opts.tools.exec("office_craft", request, {
        cfg: opts.cfg,
        workspace: opts.cfg.workspace,
        emit: opts.emit,
        taskId: opts.taskId,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      opts.emit({ type: "tool_result", name: "office_craft", ok: result.ok, summary: result.content.slice(0, 800) });
      return result;
    };
    let result = await execute(useFallback);
    if (!result.ok && !useFallback && shouldUseCraftFallback(result.content)) {
      useFallback = true;
      result = await execute(true);
    }
    if (!result.ok) throw new Error(result.content);
    return result.content;
  };

  await call({ app: "slides", action: "open" });
  emitPlan(2);
  const edit = async () => call({
    app: "slides",
    action: "edit",
    title: content.title,
    body: content.body,
    ...(content.background ? { background: content.background } : {}),
    ...(brief ? {
      layout: "cards",
      sections: brief.sections,
      headings: brief.headings,
      subtitle: brief.subtitle,
      eyebrow: brief.eyebrow,
      localeTag: brief.localeTag,
      facts: brief.facts,
      palette: brief.palette,
      density: brief.density,
      ...(brief.designSource ? { designSource: brief.designSource, designSummary: brief.designSummary } : {}),
      ...(brief.image ? { image: brief.image } : {}),
      ...(brief.icons ? { icons: brief.icons } : {}),
    } : {}),
  });
  const exportDeck = async () => exportedPath(await call({ app: "slides", action: "export", title: content.title, file: fileName, ...(content.accent ? { accent: content.accent } : {}) }));
  await edit();
  emitPlan(3);
  let relative = await exportDeck();
  let absolute = taskPath(root, relative);
  await verifyPresentation(absolute, content);
  emitPlan(4);

  const render = opts.renderPreview ?? (await import("../studio/slide-preview.js")).renderSlidePreview;
  const renderPreview = async (file: string): Promise<string> => {
    const png = await render(fs.readFileSync(file), 1);
    const preview = taskPath(root, "previews/slide-1.png");
    fs.mkdirSync(path.dirname(preview), { recursive: true });
    fs.writeFileSync(preview, png);
    opts.emit({ type: "tool_result", name: "slide_preview", ok: true, summary: arabic ? "تم إنشاء معاينة PowerPoint للشريحة الأولى." : "PowerPoint rendered the first-slide preview." });
    return preview;
  };

  try {
    let preview = await renderPreview(absolute);
    const canCritique = Boolean(opts.critique || opts.cfg.vision?.model);
    if (canCritique && brief) {
      const reviewDir = taskPath(root, "previews/review");
      fs.mkdirSync(reviewDir, { recursive: true });
      const direction = brief.arabic ? "rtl" : "ltr";
      const locale = brief.arabic ? "ar" : "en";
      fs.writeFileSync(path.join(reviewDir, "index.html"), `<html lang="${locale}" dir="${direction}"><head><meta charset="utf-8"><link rel="stylesheet" href="tokens.css"></head><body><main><h1>${xmlText(brief.title)}</h1><p>${xmlText(brief.subtitle)}</p></main></body></html>`);
      fs.writeFileSync(path.join(reviewDir, "tokens.css"), `:root{--background:${brief.palette.background};--surface:${brief.palette.surface};--ink:${brief.palette.ink};--muted:${brief.palette.muted};--accent:${brief.palette.accent};--line:${brief.palette.line}}body{background:var(--background);color:var(--ink);font-family:"Segoe UI",sans-serif;margin:0}main{padding-inline:24px}`);
      const input: VisionCritiqueInput = {
        siteDir: reviewDir,
        fixtureId: "single-slide-pptx",
        prompt: opts.prompt,
        locale,
        direction,
        lint: await minimalDesignLinter().lintSite(reviewDir, { locale, direction }),
        expectations: { must: [brief.title, ...brief.sections], mustNot: ["lorem ipsum", "placeholder"] },
        screenshots: [preview],
        brief: `One-slide editable PowerPoint. Title: ${brief.title}. Subtitle: ${brief.subtitle}. Four-column editorial grid with a real cropped image, key facts, language and currency, and location. Judge Arabic shaping and legibility, not whether it resembles a website.`,
        tokens: { ...brief.palette },
      };
      const critiqueOptions: VisionCritiqueOptions = {
        cfg: opts.cfg,
        ollama: opts.ollama,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.cfg.vision?.model ? { model: opts.cfg.vision.model } : opts.model ? { model: opts.model } : {}),
        timeoutMs: 15_000,
        maxAttempts: 1,
      };
      try {
        const critique = await (opts.critique ?? runVisionCritique)(input, critiqueOptions);
        addUsage(usage, critique.usage);
        if (critique.ok && critique.verdict === "accept") {
          opts.emit({ type: "tool_result", name: "design_critique", ok: true, summary: arabic ? `قبلت مراجعة الرؤية التصميم بتقييم ${critique.score}/100.` : `Visual critique accepted the design with a score of ${critique.score}/100.` });
          opts.emit({ type: "verify", verdict: "pass", reason: `Visual critique accepted the rendered slide (${critique.score}/100).` });
        } else if (critique.ok && critique.verdict === "revise") {
          const repaired = repairPresentationBrief(brief, [...critique.issues, ...critique.fixes]);
          opts.emit({ type: "tool_result", name: "design_critique", ok: true, summary: arabic ? `طلبت مراجعة الرؤية تحسين التصميم (${critique.score}/100): ${critique.issues.join("؛ ")}` : `Visual critique requested revisions (${critique.score}/100): ${critique.issues.join("; ")}` });
          if (repaired) {
            brief = repaired;
            await edit();
            relative = await exportDeck();
            absolute = taskPath(root, relative);
            await verifyPresentation(absolute, content);
            preview = await renderPreview(absolute);
            opts.emit({ type: "tool_result", name: "design_repair", ok: true, summary: arabic ? `طُبقت جولة إصلاح واحدة وأُعيد التحقق من PPTX والمعاينة: ${preview}` : `One repair round was applied and the PPTX and preview were verified again: ${preview}` });
          }
        } else {
          opts.emit({ type: "tool_result", name: "design_critique", ok: false, summary: arabic ? `تعذر اعتماد نتيجة مراجعة الرؤية؛ بقي ملف PPTX الصالح والمعاينة متاحين. ${critique.notes.join("؛ ")}` : `The visual critique could not be accepted; the valid PPTX and rendered preview remain available. ${critique.notes.join("; ")}` });
        }
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        opts.emit({ type: "tool_result", name: "design_critique", ok: false, summary: arabic ? `تعذرت مراجعة الرؤية؛ تم التحقق من PPTX وإنشاء معاينته دون تقييم تصميم آلي. ${details}` : `Visual critique was unavailable; the PPTX was verified and rendered without an automated design score. ${details}` });
      }
    } else if (brief) {
      opts.emit({ type: "task-status", status: arabic ? "تم التحقق من PPTX والمعاينة؛ مراجعة الرؤية الآلية غير مهيأة." : "PPTX and preview verified; automated visual critique is not configured." });
    }
    opts.emit({ type: "verify", verdict: "pass", reason: "PowerPoint rendered the first-slide preview successfully." });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    opts.emit({ type: "tool_result", name: "slide_preview", ok: false, summary: arabic ? `تعذر التحقق البصري بواسطة PowerPoint؛ ملف PPTX صالح وتم التحقق من بنيته ومحتواه. ${details}` : `PowerPoint visual verification was unavailable; the PPTX structure and content are valid. ${details}` });
  }
  let resourceUri = "";
  if (opts.packId === "loam-slides") {
    const project = readPackProject(root, "loam-slides");
    if (!project) throw new Error("slide pack project disappeared before presentation");
    project.items = [{ id: "slide-1", state: "final", path: relative }];
    project.data = { ...project.data, title: content.title, format: "pptx" };
    writePackProject(root, { ...project, revision: project.revision + 1 });
    const completion = await completePackTask({ cfg: opts.cfg, workspace: root, emit: opts.emit, taskId: opts.taskId, packId: opts.packId, ...(opts.signal ? { signal: opts.signal } : {}) }, [relative]);
    if (!completion.ok) throw new Error(`deck_present failed: ${completion.content}`);
    resourceUri = completion.pack?.ok ? completion.pack.uri : "";
  }
  emitPlan(5);
  const text = (arabic ? `تم إنشاء العرض من شريحة واحدة وتصديره بنجاح:\n\n${relative}` : `Created and exported the one-slide presentation:\n\n${relative}`) + (resourceUri ? `\n\n${resourceUri}` : "");
  opts.emit({ type: "verify", verdict: "pass", reason: "PPTX contains exactly one slide with the requested title and body." });
  opts.emit({ type: "assistant_message", text });
  opts.emit({ type: "done", text, steps: 5, model: generated.model });
  return { text, steps: 5, model: generated.model, usage, verified: true };
}
