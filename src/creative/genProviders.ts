/**
 * Generation provider adapters (N12): pluggable backends behind the media and
 * search generator tools (src/tools/genExtra.ts).
 *
 * Every provider is injected into createGenExtraTools, so tests substitute a
 * mock and an unconfigured provider yields a clear card instead of a crash.
 * Real adapters are wired from the environment by defaultGenProviders(cfg):
 * Tripo / Meshy / a local placeholder for image-to-3D, Openverse for image
 * search (keyless), the X API v2 for post search, and an OpenAI-compatible
 * endpoint for music. No third-party code, prompts or assets are used.
 */
import fs from "node:fs";
import path from "node:path";
import type { ToolContext } from "../tools/registry.js";
import { str, num } from "../tools/registry.js";
import { taskPath } from "../server/taskWorkspace.js";

/** What a provider produced, already JSON-safe. */
export interface GenOutput {
  kind: "3d-model" | "music" | "images" | "tweets";
  data: Record<string, unknown>;
  /** Optional base64 images (no data: prefix) to attach to the model call. */
  images?: string[];
}

export type GenProviderResult = { ok: true; output: GenOutput } | { ok: false; content: string };

export interface GenProvider {
  id: string;
  label: string;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<GenProviderResult>;
}

export interface GenProviders {
  imageTo3d?: GenProvider;
  music?: GenProvider;
  imageSearch?: GenProvider;
  xSearch?: GenProvider;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESULT_BYTES = 8_000_000;

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

async function fetchLimited(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: number; text: string }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(url, { ...init, signal: combined, redirect: "follow" });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_RESULT_BYTES) throw new Error(`response too large (${buf.byteLength} bytes)`);
  return { status: res.status, text: buf.toString("utf8") };
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const { status, text } = await fetchLimited(url, init, timeoutMs, signal);
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}: ${text.slice(0, 400)}`);
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`provider returned invalid JSON: ${text.slice(0, 200)}`);
  }
}

function requireKey(value: string, name: string): string | null {
  return value ? value : null;
}

// ---------------------------------------------------------------------------
// Image-to-3D
// ---------------------------------------------------------------------------

export interface ImageInput {
  /** Remote image URL when the caller supplied one. */
  url?: string;
  /** Base64 payload (no data: prefix) when the caller supplied a local image. */
  base64?: string;
  mediaType?: string;
}

/** Resolve the `image` argument: http(s) URL, data URL, absolute path, or a
 *  workspace-relative path read into base64. Returns null when unreadable. */
export async function resolveImageInput(args: Record<string, unknown>, ctx: ToolContext): Promise<ImageInput | null> {
  const image = str(args, "image").trim();
  if (!image) return null;
  if (/^https?:\/\//i.test(image)) return { url: image };
  const dataUrl = /^data:(image\/[a-z+.-]+);base64,(.+)$/is.exec(image);
  if (dataUrl) return { base64: dataUrl[2]!, mediaType: dataUrl[1] };
  const file = path.isAbsolute(image) ? image : path.join(ctx.workspace, image);
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    const buf = fs.readFileSync(file);
    return { base64: buf.toString("base64"), mediaType: "image/png" };
  } catch {
    return null;
  }
}

/** Tripo image-to-model: submit a task, poll until the .glb is ready. */
export const tripoImageTo3dProvider: GenProvider = {
  id: "tripo",
  label: "Tripo",
  async run(args, ctx) {
    const key = requireKey(env("LOAM_TRIPO_API_KEY"), "LOAM_TRIPO_API_KEY");
    if (!key) return { ok: false, content: "Tripo provider is not configured: set LOAM_TRIPO_API_KEY." };
    const input = await resolveImageInput(args, ctx);
    if (!input) return { ok: false, content: "could not read the source image (path, URL, or data URL)" };
    const file: Record<string, unknown> = input.url
      ? { type: input.mediaType ?? "image/png", url: input.url }
      : { type: input.mediaType ?? "image/png", data: input.base64 };
    const submitted = await fetchJson(
      "https://api.tripo3d.ai/v2/openapi/task",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          type: "image_to_model",
          model_version: "v2.5-20250123",
          file,
          ...(str(args, "style").trim() ? { style: str(args, "style").trim() } : {}),
        }),
      },
      DEFAULT_TIMEOUT_MS,
      ctx.signal,
    );
    const taskId = (submitted as { data?: { task_id?: string } }).data?.task_id;
    if (!taskId) return { ok: false, content: `Tripo did not return a task id: ${JSON.stringify(submitted).slice(0, 300)}` };
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      const task = await fetchJson(
        `https://api.tripo3d.ai/v2/openapi/task/${encodeURIComponent(taskId)}`,
        { headers: { authorization: `Bearer ${key}` } },
        DEFAULT_TIMEOUT_MS,
        ctx.signal,
      );
      const data = task.data as { status?: string; output?: { model?: { src?: string } } } | undefined;
      if (data?.status === "success" && data.output?.model?.src) {
        return { ok: true, output: { kind: "3d-model", data: { provider: "tripo", taskId, modelUrl: data.output.model.src, format: "glb" } } };
      }
      if (data?.status === "failed" || data?.status === "error") {
        return { ok: false, content: `Tripo task ${taskId} failed: ${JSON.stringify(task).slice(0, 300)}` };
      }
      if (Date.now() > deadline) return { ok: false, content: `Tripo task ${taskId} timed out after 5 minutes` };
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  },
};

/** Meshy image-to-3D: submit a task, poll until the .glb is ready. */
export const meshyImageTo3dProvider: GenProvider = {
  id: "meshy",
  label: "Meshy",
  async run(args, ctx) {
    const key = requireKey(env("LOAM_MESHY_API_KEY"), "LOAM_MESHY_API_KEY");
    if (!key) return { ok: false, content: "Meshy provider is not configured: set LOAM_MESHY_API_KEY." };
    const input = await resolveImageInput(args, ctx);
    if (!input?.url) return { ok: false, content: "Meshy image-to-3D requires a public image URL (http/https)" };
    const submitted = await fetchJson(
      "https://api.meshy.ai/openapi/v2/image-to-3d",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ image_url: input.url, enable_pbr: true, topology: "quad", target_polycount: 30000 }),
      },
      DEFAULT_TIMEOUT_MS,
      ctx.signal,
    );
    const taskId = submitted.result as string | undefined;
    if (!taskId) return { ok: false, content: `Meshy did not return a task id: ${JSON.stringify(submitted).slice(0, 300)}` };
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      const task = await fetchJson(
        `https://api.meshy.ai/openapi/v2/image-to-3d/${encodeURIComponent(taskId)}`,
        { headers: { authorization: `Bearer ${key}` } },
        DEFAULT_TIMEOUT_MS,
        ctx.signal,
      );
      const status = task.status as string | undefined;
      const glb = (task.model_urls as { glb?: string } | undefined)?.glb;
      if (status === "SUCCEEDED" && glb) {
        return { ok: true, output: { kind: "3d-model", data: { provider: "meshy", taskId, modelUrl: glb, format: "glb" } } };
      }
      if (status === "FAILED" || status === "EXPIRED") {
        return { ok: false, content: `Meshy task ${taskId} ended with status ${status}` };
      }
      if (Date.now() > deadline) return { ok: false, content: `Meshy task ${taskId} timed out after 5 minutes` };
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  },
};

/** Minimal valid binary glTF (glTF 2.0) written locally. */
function minimalGlb(): Buffer {
  const json = JSON.stringify({
    asset: { version: "2.0", generator: "Loam local 3D placeholder" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: {} }] }],
  });
  const jsonBuf = Buffer.from(json, "utf8");
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(pad, 0x20)]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(jsonChunk.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4); // "JSON"
  return Buffer.concat([header, chunkHeader, jsonChunk]);
}

/**
 * Local image-to-3D: no network. Reads the source image (so the tool is only
 * usable on a real image) and writes a deterministic placeholder .glb into the
 * task workspace, clearly marked previewOnly. A future local model can replace
 * this adapter without touching the tool.
 */
export const localImageTo3dProvider: GenProvider = {
  id: "local",
  label: "Local",
  async run(args, ctx) {
    const input = await resolveImageInput(args, ctx);
    if (!input) return { ok: false, content: "could not read the source image (path, URL, or data URL)" };
    const slug = (str(args, "style").trim() || "model").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "model";
    const rel = `uploads/gen-3d-${slug}-${Date.now()}.glb`;
    fs.mkdirSync(path.dirname(taskPath(ctx.workspace, rel)), { recursive: true });
    fs.writeFileSync(taskPath(ctx.workspace, rel), minimalGlb());
    return {
      ok: true,
      output: {
        kind: "3d-model",
        data: { provider: "local", modelPath: rel, format: "glb", previewOnly: true, note: "Placeholder GLB generated locally; no 3D model was rendered." },
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------

/** OpenAI-compatible music endpoint: POST a prompt, read back audio. */
export const musicProvider: GenProvider = {
  id: "openai-compatible",
  label: "Music",
  async run(args, ctx) {
    const baseUrl = env("LOAM_MUSIC_URL");
    const key = env("LOAM_MUSIC_API_KEY");
    if (!baseUrl) return { ok: false, content: "Music provider is not configured: set LOAM_MUSIC_URL (and LOAM_MUSIC_API_KEY)." };
    const prompt = str(args, "prompt").trim();
    if (!prompt) return { ok: false, content: "music requires prompt" };
    const payload = await fetchJson(
      baseUrl.replace(/\/+$/, ""),
      {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          prompt,
          duration: num(args, "durationSec", 0) > 0 ? Math.min(120, num(args, "durationSec", 0)) : undefined,
          instrumental: Boolean(args.instrumental),
        }),
      },
      DEFAULT_TIMEOUT_MS,
      ctx.signal,
    );
    const audioUrl = (payload.audio_url ?? payload.url ?? payload.audioUrl) as string | undefined;
    const base64 = payload.audio as string | undefined;
    if (!audioUrl && !base64) return { ok: false, content: `music provider returned no audio: ${JSON.stringify(payload).slice(0, 300)}` };
    return {
      ok: true,
      output: {
        kind: "music",
        data: { provider: "openai-compatible", prompt, ...(audioUrl ? { audioUrl } : {}), ...(base64 ? { audioBase64Length: base64.length } : {}), format: "mp3" },
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Openverse image search (keyless JSON API). */
export const openverseImageSearchProvider: GenProvider = {
  id: "openverse",
  label: "Openverse",
  async run(args, ctx) {
    const query = str(args, "query").trim();
    if (!query) return { ok: false, content: "image search requires query" };
    const limit = Math.min(20, Math.max(1, Math.floor(num(args, "limit", 8))));
    const url = `https://api.openverse.org/v1/images/?${new URLSearchParams({ q: query, page_size: String(limit), license_type: "all" })}`;
    const payload = await fetchJson(url, { headers: { accept: "application/json" } }, DEFAULT_TIMEOUT_MS, ctx.signal);
    const results = Array.isArray(payload.results) ? payload.results : [];
    const mapped = results.slice(0, limit).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        title: typeof row.title === "string" ? row.title : "",
        url: typeof row.url === "string" ? row.url : "",
        creator: typeof row.creator === "string" ? row.creator : "",
        license: typeof row.license === "string" ? row.license : "",
        licenseUrl: typeof row.license_url === "string" ? row.license_url : "",
        width: typeof row.width === "number" ? row.width : null,
        height: typeof row.height === "number" ? row.height : null,
      };
    });
    return { ok: true, output: { kind: "images", data: { provider: "openverse", query, results: mapped } } };
  },
};

/** X (Twitter) post search via the v2 recent-search endpoint. */
export const xSearchProvider: GenProvider = {
  id: "x",
  label: "X",
  async run(args, ctx) {
    const token = requireKey(env("LOAM_X_BEARER_TOKEN"), "LOAM_X_BEARER_TOKEN");
    if (!token) return { ok: false, content: "X search is not configured: set LOAM_X_BEARER_TOKEN." };
    const query = str(args, "query").trim();
    if (!query) return { ok: false, content: "X search requires query" };
    const limit = Math.min(100, Math.max(1, Math.floor(num(args, "limit", 10))));
    const params = new URLSearchParams({ query, max_results: String(limit), "tweet.fields": "author_id,created_at,public_metrics,lang" });
    const payload = await fetchJson(`https://api.x.com/2/tweets/search/recent?${params}`, { headers: { authorization: `Bearer ${token}` } }, DEFAULT_TIMEOUT_MS, ctx.signal);
    const tweets = Array.isArray(payload.data) ? payload.data : [];
    const users = new Map<string, string>();
    for (const u of (payload.includes as { users?: Array<Record<string, unknown>> } | undefined)?.users ?? []) {
      if (typeof u.id === "string") users.set(u.id, typeof u.username === "string" ? u.username : "");
    }
    const mapped = tweets.slice(0, limit).map((t) => {
      const row = t as Record<string, unknown>;
      const authorId = typeof row.author_id === "string" ? row.author_id : "";
      const metrics = row.public_metrics as Record<string, unknown> | undefined;
      return {
        id: typeof row.id === "string" ? row.id : "",
        text: typeof row.text === "string" ? row.text : "",
        author: users.get(authorId) ?? authorId,
        createdAt: typeof row.created_at === "string" ? row.created_at : "",
        likes: typeof metrics?.like_count === "number" ? metrics.like_count : null,
        url: typeof row.id === "string" ? `https://x.com/i/web/status/${row.id}` : "",
      };
    });
    return { ok: true, output: { kind: "tweets", data: { provider: "x", query, tweets: mapped } } };
  },
};

/**
 * Wire the providers that are configured in this environment. Only the
 * generation/search providers are env-driven; the reasoning model used by
 * solve_logic / generate_storyboard is injected separately by the runtime.
 */
export function defaultGenProviders(cfg: { policy?: { networkEnabled?: boolean } }): GenProviders {
  const providers: GenProviders = {};
  const networkEnabled = cfg?.policy?.networkEnabled !== false;
  if (!networkEnabled) return providers;
  if (env("LOAM_TRIPO_API_KEY")) providers.imageTo3d = tripoImageTo3dProvider;
  else if (env("LOAM_MESHY_API_KEY")) providers.imageTo3d = meshyImageTo3dProvider;
  else if (env("LOAM_3D_LOCAL") === "1") providers.imageTo3d = localImageTo3dProvider;
  if (env("LOAM_MUSIC_URL")) providers.music = musicProvider;
  providers.imageSearch = openverseImageSearchProvider;
  if (env("LOAM_X_BEARER_TOKEN")) providers.xSearch = xSearchProvider;
  return providers;
}
