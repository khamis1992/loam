/**
 * Missing generator tools (N12): gen_3d_from_image, gen_music,
 * generate_storyboard, solve_logic, search_images and search_x.
 *
 * Each tool is backed by an injected provider (src/creative/genProviders.ts)
 * or an injected reasoning model. When the backing dependency is not wired the
 * tool returns a clear `provider_not_configured` card instead of throwing, so
 * an unconfigured feature degrades gracefully rather than crashing the run.
 *
 * generate_storyboard returns a `scenes` array in the exact {index,start,end,
 * peak} shape consumed by the auto-video planner (src/creative/auto.ts), so a
 * storyboard can be handed straight to the autoVideo pipeline.
 */
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str, num } from "./registry.js";
import type { GenProvider, GenProviders } from "../creative/genProviders.js";
import type { Scene, TranscriptSegment } from "../creative/auto.js";

/** Error code for a graceful "provider not configured" card. */
export const PROVIDER_NOT_CONFIGURED = "provider_not_configured";

const SETUP_3D = "Set LOAM_TRIPO_API_KEY, LOAM_MESHY_API_KEY, or LOAM_3D_LOCAL=1 on the Loam server.";
const SETUP_MUSIC = "Set LOAM_MUSIC_URL (and LOAM_MUSIC_API_KEY) on the Loam server.";
const SETUP_IMAGES = "Enable network access and configure an image-search provider (Openverse is built in).";
const SETUP_X = "Set LOAM_X_BEARER_TOKEN on the Loam server, or add an X connector in Services > Integrations.";
const SETUP_REASONER = "Configure a reasoning model (the Loam model provider) so generator tools can plan and reason.";

/** A clear, machine-readable card the UI can render instead of a stack trace. */
export function providerNotConfigured(tool: string, provider: string, setup: string): ToolResult {
  return {
    ok: false,
    content: JSON.stringify({
      error: PROVIDER_NOT_CONFIGURED,
      tool,
      provider,
      message: `${tool} is not configured: no ${provider} provider is available.`,
      setup,
    }),
  };
}

function providerFailure(tool: string, err: unknown): ToolResult {
  return { ok: false, content: `${tool} failed: ${err instanceof Error ? err.message : String(err)}` };
}

function finish(tool: string, provider: GenProvider, output: { data: Record<string, unknown>; images?: string[] }): ToolResult {
  return { ok: true, content: JSON.stringify({ tool, provider: provider.id, ...output.data }), ...(output.images && output.images.length > 0 ? { images: output.images } : {}) };
}

/** Resolve the single provider a tool uses, honouring an explicit `provider` arg. */
function resolveProvider(
  providers: GenProviders,
  requested: string,
  current: GenProvider | undefined,
  tool: string,
  label: string,
  setup: string,
): { provider?: GenProvider; error?: ToolResult } {
  if (requested) {
    if (current && current.id === requested) return { provider: current };
    return { error: providerNotConfigured(tool, requested, setup) };
  }
  if (!current) return { error: providerNotConfigured(tool, label, setup) };
  return { provider: current };
}

// ---------------------------------------------------------------------------
// Reasoning model (solve_logic, generate_storyboard)
// ---------------------------------------------------------------------------

/** Minimal surface the generator tools need from a model client. */
export interface GenReasoner {
  chat(opts: {
    model: string;
    messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
    signal?: AbortSignal;
  }): Promise<{ content: string }>;
}

export interface GenExtraDeps {
  providers?: GenProviders;
  reasoner?: GenReasoner;
}

function reasonerModel(args: Record<string, unknown>, ctx: ToolContext): string {
  const explicit = str(args, "model").trim();
  if (explicit) return explicit;
  const configured = (ctx.cfg as { model?: string }).model;
  return configured && configured.trim() ? configured : "default";
}

// ---------------------------------------------------------------------------
// Storyboard compilation (pure)
// ---------------------------------------------------------------------------

export interface StoryboardScene {
  index: number;
  title: string;
  visual: string;
  narration: string;
  durationSec: number;
}

export interface Storyboard {
  title: string;
  style: string;
  scenes: StoryboardScene[];
}

export interface CompiledStoryboard {
  storyboard: Storyboard;
  /** autoVideo scene shape: {index,start,end,peak}, ordered and non-overlapping. */
  scenes: Scene[];
  /** Transcript shape the auto-video caption lane accepts. */
  captions: TranscriptSegment[];
  warnings: string[];
}

/** Extract the first JSON object from a model reply (tolerates code fences). */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function clampDuration(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 4;
  return Math.min(30, Math.max(0.5, seconds));
}

/** Compile a model storyboard reply into validated story + autoVideo scenes. */
export function compileStoryboard(input: {
  raw: string;
  sceneCount: number;
  durationSec?: number;
  language?: string;
}): { ok: true; value: CompiledStoryboard } | { ok: false; error: string } {
  const parsed = parseJsonObject(input.raw);
  if (!parsed) return { ok: false, error: "the model did not return a JSON object" };
  const scenesRaw = parsed.scenes;
  if (!Array.isArray(scenesRaw) || scenesRaw.length === 0) return { ok: false, error: "the model returned no scenes" };

  const target = Math.max(1, Math.min(24, Math.floor(input.sceneCount)));
  const warnings: string[] = [];
  const storyScenes: StoryboardScene[] = [];
  const scenes: Scene[] = [];
  const captions: TranscriptSegment[] = [];
  let cursor = 0;

  for (let i = 0; i < target; i++) {
    const src = (scenesRaw[i] && typeof scenesRaw[i] === "object" ? scenesRaw[i] : {}) as Record<string, unknown>;
    if (!scenesRaw[i] || typeof scenesRaw[i] !== "object") warnings.push(`scene ${i + 1} missing from the model reply; a placeholder was used`);
    const perScene = typeof src.durationSec === "number" && Number.isFinite(src.durationSec) ? src.durationSec : 0;
    const duration = clampDuration(perScene > 0 ? perScene : input.durationSec ? input.durationSec / target : 4);
    const start = cursor;
    const end = cursor + duration;
    const index = storyScenes.length;
    scenes.push({ index, start: round3(start), end: round3(end), peak: 0.5 });
    const narration = typeof src.narration === "string" && src.narration.trim()
      ? src.narration.trim()
      : typeof src.visual === "string"
        ? src.visual.trim()
        : "";
    if (narration) captions.push({ start: round3(start), end: round3(end), text: narration.slice(0, 400) });
    storyScenes.push({
      index: index + 1,
      title: typeof src.title === "string" && src.title.trim() ? src.title.trim() : `Scene ${index + 1}`,
      visual: typeof src.visual === "string" ? src.visual.trim() : "",
      narration,
      durationSec: round3(duration),
    });
    cursor = end;
  }

  const storyboard: Storyboard = {
    title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "Untitled storyboard",
    style: typeof parsed.style === "string" ? parsed.style.trim() : "",
    scenes: storyScenes,
  };
  return { ok: true, value: { storyboard, scenes, captions, warnings } };
}

// ---------------------------------------------------------------------------
// Prompts (complete, precise, professional)
// ---------------------------------------------------------------------------

const STORYBOARD_SYSTEM = [
  "You are Loam's storyboard planner. Turn a creative brief into a precise, shootable scene list for an automatic video pipeline.",
  "Rules:",
  "- Return ONLY a single JSON object. No prose and no markdown fences.",
  '- The object MUST contain "title" (string), "style" (string) and "scenes" (array).',
  '- Each scene MUST contain "index" (1-based integer), "title" (short string), "visual" (one concrete sentence describing exactly what the camera sees), "narration" (the spoken line for the scene) and "durationSec" (number 0.5 to 30).',
  "- Produce exactly the requested number of scenes, in story order, with no gaps or overlaps.",
  "- Visuals must be specific and filmable; narration must be a complete sentence that matches its visual.",
  "- Do not include absolute timings; the pipeline computes the timeline from durationSec.",
].join("\n");

const SOLVE_LOGIC_SYSTEM = [
  "You are Loam's logic solver. Solve the problem with rigorous, verifiable reasoning.",
  "Rules:",
  "- Restate the problem and every constraint precisely.",
  "- Reason step by step; each step must follow from the previous step or from a stated constraint.",
  "- Explicitly check the final answer against every constraint before stating it.",
  "- If the problem is under-specified, state the assumptions you made and how they affect the answer.",
  "- End with a clearly delimited final answer.",
  "- Be concise and precise; never invent facts.",
].join("\n");

function storyboardUser(brief: string, sceneCount: number, durationSec: number | undefined, language: string, style: string): string {
  const lines = [`Brief: ${brief}`, `Number of scenes: ${sceneCount}`];
  if (durationSec && durationSec > 0) lines.push(`Total duration: ${durationSec} seconds (split across the scenes)`);
  lines.push(`Narration language: ${language || "the language of the brief"}`);
  if (style) lines.push(`Style: ${style}`);
  lines.push("Return the JSON object now.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function createGenExtraTools(deps: GenExtraDeps = {}): Tool[] {
  const providers = deps.providers ?? {};

  return [
    {
      name: "gen_3d_from_image",
      description:
        "Turn a source image into a 3D model (.glb). The source may be a workspace-relative path, an absolute path, an http(s) URL or a data URL. Uses the configured image-to-3D provider (Tripo, Meshy, or a local placeholder); when no provider is configured the tool returns a clear not-configured card. Returns the model URL or the workspace path of the generated .glb.",
      parameters: {
        type: "object",
        properties: {
          image: { type: "string", description: "Source image: workspace-relative path, absolute path, http(s) URL, or data URL." },
          style: { type: "string", description: "Optional look hint for the model (e.g. 'low-poly', 'realistic')." },
          provider: { type: "string", enum: ["tripo", "meshy", "local"], description: "Force a provider; otherwise the configured default is used." },
        },
        required: ["image"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const image = str(args, "image").trim();
        if (!image) return { ok: false, content: "gen_3d_from_image requires image (a path, URL, or data URL)" };
        const resolved = resolveProvider(providers, str(args, "provider").trim(), providers.imageTo3d, "gen_3d_from_image", "3d-from-image", SETUP_3D);
        if (resolved.error) return resolved.error;
        try {
          const result = await resolved.provider!.run({ ...args, image }, ctx);
          if (!result.ok) return { ok: false, content: result.content };
          return finish("gen_3d_from_image", resolved.provider!, result.output);
        } catch (err) {
          return providerFailure("gen_3d_from_image", err);
        }
      },
    },
    {
      name: "gen_music",
      description:
        "Generate a music clip from a text prompt using the configured music provider. Returns the audio URL (or a base64 length when the provider returns inline audio). When no provider is configured the tool returns a clear not-configured card.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Description of the music: mood, instruments, tempo, structure." },
          durationSec: { type: "number", minimum: 1, maximum: 120, description: "Requested length in seconds (provider may clamp)." },
          instrumental: { type: "boolean", description: "Instrumental only (no vocals)." },
          provider: { type: "string", description: "Force a provider id when several are wired." },
        },
        required: ["prompt"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const prompt = str(args, "prompt").trim();
        if (!prompt) return { ok: false, content: "gen_music requires prompt" };
        const resolved = resolveProvider(providers, str(args, "provider").trim(), providers.music, "gen_music", "music", SETUP_MUSIC);
        if (resolved.error) return resolved.error;
        try {
          const result = await resolved.provider!.run({ ...args, prompt }, ctx);
          if (!result.ok) return { ok: false, content: result.content };
          return finish("gen_music", resolved.provider!, result.output);
        } catch (err) {
          return providerFailure("gen_music", err);
        }
      },
    },
    {
      name: "generate_storyboard",
      description:
        "Plan a scene-by-scene storyboard for a brief with the reasoning model and return JSON: a human storyboard plus a `scenes` array in the auto-video {index,start,end,peak} shape and a `captions` transcript, so it can be fed straight into the autoVideo pipeline. Requires a configured reasoning model; otherwise returns a clear not-configured card.",
      parameters: {
        type: "object",
        properties: {
          brief: { type: "string", description: "The story or concept to storyboard, in plain language." },
          scenes: { type: "integer", minimum: 1, maximum: 24, description: "Number of scenes to produce (default 4)." },
          durationSec: { type: "number", minimum: 1, maximum: 600, description: "Optional total duration; split across the scenes." },
          style: { type: "string", description: "Optional visual style (e.g. 'cinematic', 'anime')." },
          language: { type: "string", description: "Narration language (defaults to the brief's language)." },
          model: { type: "string", description: "Optional reasoning model override." },
        },
        required: ["brief"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const brief = str(args, "brief").trim();
        if (!brief) return { ok: false, content: "generate_storyboard requires a brief" };
        if (!deps.reasoner) return providerNotConfigured("generate_storyboard", "reasoning model", SETUP_REASONER);
        const sceneCount = Math.max(1, Math.min(24, Math.floor(num(args, "scenes", 4))));
        const durationSec = num(args, "durationSec", 0) > 0 ? num(args, "durationSec", 0) : undefined;
        const language = str(args, "language").trim();
        const style = str(args, "style").trim();
        const model = reasonerModel(args, ctx);
        try {
          const reply = await deps.reasoner.chat({
            model,
            messages: [
              { role: "system", content: STORYBOARD_SYSTEM },
              { role: "user", content: storyboardUser(brief, sceneCount, durationSec, language, style) },
            ],
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          const compiled = compileStoryboard({ raw: reply.content, sceneCount, durationSec, language });
          if (!compiled.ok) return { ok: false, content: `generate_storyboard: ${compiled.error}` };
          return {
            ok: true,
            content: JSON.stringify({
              tool: "generate_storyboard",
              model,
              storyboard: compiled.value.storyboard,
              scenes: compiled.value.scenes,
              captions: compiled.value.captions,
              warnings: compiled.value.warnings,
              note: "Feed `scenes` (and `captions`) to the autoVideo pipeline; each scene uses the {index,start,end,peak} shape the auto-video planner accepts.",
            }),
          };
        } catch (err) {
          return providerFailure("generate_storyboard", err);
        }
      },
    },
    {
      name: "solve_logic",
      description:
        "Solve a logic, math or reasoning problem with a rigorous step-by-step reasoning-model sub-call. Returns the full reasoning and a delimited final answer. Requires a configured reasoning model; otherwise returns a clear not-configured card.",
      parameters: {
        type: "object",
        properties: {
          problem: { type: "string", description: "The problem to solve, stated precisely." },
          constraints: { type: "string", description: "Optional constraints or required output format." },
          model: { type: "string", description: "Optional reasoning model override." },
        },
        required: ["problem"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const problem = str(args, "problem").trim();
        if (!problem) return { ok: false, content: "solve_logic requires problem" };
        if (!deps.reasoner) return providerNotConfigured("solve_logic", "reasoning model", SETUP_REASONER);
        const constraints = str(args, "constraints").trim();
        const model = reasonerModel(args, ctx);
        try {
          const reply = await deps.reasoner.chat({
            model,
            messages: [
              { role: "system", content: SOLVE_LOGIC_SYSTEM },
              { role: "user", content: constraints ? `Problem:\n${problem}\n\nConstraints:\n${constraints}` : `Problem:\n${problem}` },
            ],
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return { ok: true, content: JSON.stringify({ tool: "solve_logic", model, answer: reply.content }) };
        } catch (err) {
          return providerFailure("solve_logic", err);
        }
      },
    },
    {
      name: "search_images",
      description:
        "Search for images and return titles, direct image URLs, creators and licence info as JSON (Openverse is built in). Use it to find reference images or assets; read a chosen image with file_view_image or pass its URL to a generator. When no image-search provider is configured the tool returns a clear not-configured card.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for." },
          limit: { type: "integer", minimum: 1, maximum: 20, description: "Max results (default 8)." },
          provider: { type: "string", description: "Force a provider id when several are wired." },
        },
        required: ["query"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const query = str(args, "query").trim();
        if (!query) return { ok: false, content: "search_images requires query" };
        const resolved = resolveProvider(providers, str(args, "provider").trim(), providers.imageSearch, "search_images", "image search", SETUP_IMAGES);
        if (resolved.error) return resolved.error;
        try {
          const result = await resolved.provider!.run({ ...args, query }, ctx);
          if (!result.ok) return { ok: false, content: result.content };
          return finish("search_images", resolved.provider!, result.output);
        } catch (err) {
          return providerFailure("search_images", err);
        }
      },
    },
    {
      name: "search_x",
      description:
        "Search public X (Twitter) posts and return matching tweets with author, text, created time, like count and a status URL as JSON. Uses the X connector/API when it is configured; otherwise returns a clear not-configured card.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "X search query (supports X operators such as from:, #hashtag, since:)." },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Max results (default 10)." },
          provider: { type: "string", description: "Force a provider id when several are wired." },
        },
        required: ["query"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const query = str(args, "query").trim();
        if (!query) return { ok: false, content: "search_x requires query" };
        const resolved = resolveProvider(providers, str(args, "provider").trim(), providers.xSearch, "search_x", "X search", SETUP_X);
        if (resolved.error) return resolved.error;
        try {
          const result = await resolved.provider!.run({ ...args, query }, ctx);
          if (!result.ok) return { ok: false, content: result.content };
          return finish("search_x", resolved.provider!, result.output);
        } catch (err) {
          return providerFailure("search_x", err);
        }
      },
    },
  ];
}

export const GEN_EXTRA_TOOL_NAMES = [
  "gen_3d_from_image",
  "gen_music",
  "generate_storyboard",
  "solve_logic",
  "search_images",
  "search_x",
] as const;
