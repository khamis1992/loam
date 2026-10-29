/**
 * BYOK image provider for the design asset pipeline (W5).
 *
 * `design_image_generate` (src/tools/designAssets.ts) accepts an injected
 * `UiAssetGenerator`. This module is a real, OpenAI-compatible one: it POSTs
 * the user's own key (BYOK) to `{baseUrl}/images/generations`, maps the tool's
 * free width/height requests onto provider-supported size buckets, honors a
 * 60s timeout, and reports failures as Arabic messages with the API key
 * redacted — the key is never echoed back (no headers, no request body).
 *
 * Configuration (either or both; env wins over config.json):
 *   - config.json → `cloudModel.images = { model, baseUrl?, apiKey? }`, where
 *     baseUrl/apiKey fall back to the parent `cloudModel` section, so an
 *     existing OpenRouter/cloud key is reused by adding only a model name.
 *   - Env overrides: LOAM_IMAGE_MODEL, LOAM_IMAGE_BASE_URL, LOAM_IMAGE_API_KEY
 *     (MANUS_LOCAL_IMAGE_* aliases accepted, matching the repo convention).
 *
 * When no image model is configured the resolver returns `undefined` and the
 * tool keeps its default local deterministic generator — unchanged behavior.
 * No third-party code, prompts or assets are used here.
 */
import type { UiAssetBytes, UiAssetGenerator, UiAssetRequest } from "../design/assets.js";

export interface CloudImagesConfig {
  /** Image model id, e.g. "gpt-image-1" or an OpenRouter image model. */
  model?: string;
  /** Provider base URL; defaults to the parent cloudModel.baseUrl. */
  baseUrl?: string;
  /** Provider API key; defaults to the parent cloudModel.apiKey. */
  apiKey?: string;
}

/** Structural slice of `Config["cloudModel"]` so tests can pass a plain object. */
export interface CloudModelLike {
  baseUrl?: string;
  apiKey?: string;
  images?: CloudImagesConfig;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Provider-supported size buckets (OpenAI /images/generations compatible). */
type ProviderSize = "256x256" | "512x512" | "1024x1024" | "1024x1536" | "1536x1024";

export interface MappedProviderSize {
  size: ProviderSize;
  width: number;
  height: number;
}

/**
 * Map a free-form width/height request onto a provider-supported size bucket.
 * Small images collapse to the square buckets; larger ones pick the landscape
 * or portrait 1024-class bucket from the aspect ratio.
 */
export function mapProviderSize(width?: number, height?: number): MappedProviderSize {
  const w = Number.isFinite(width) && width! >= 16 ? Math.min(4096, Math.round(width!)) : 800;
  const h = Number.isFinite(height) && height! >= 16 ? Math.min(4096, Math.round(height!)) : 600;
  const area = w * h;
  if (area <= 256 * 256) return { size: "256x256", width: 256, height: 256 };
  if (area <= 512 * 512) return { size: "512x512", width: 512, height: 512 };
  if (w >= h * 1.2) return { size: "1536x1024", width: 1536, height: 1024 };
  if (h >= w * 1.2) return { size: "1024x1536", width: 1024, height: 1536 };
  return { size: "1024x1024", width: 1024, height: 1024 };
}

/** Replace every occurrence of the secret with a placeholder so an error
 *  message that somehow captured it (e.g. an echoing provider body) stays safe. */
export function redactSecret(text: string, secret: string): string {
  const s = secret.trim();
  if (!s) return text;
  return text.split(s).join("[REDACTED]");
}

export const MISSING_IMAGE_KEY_MESSAGE_AR =
  "تعذّر توليد الصورة: أضف مفتاح مزود الصور في إعدادات النموذج السحابي (cloudModel.images.apiKey أو cloudModel.apiKey أو المتغير LOAM_IMAGE_API_KEY) ثم أعد المحاولة.";

export const MISSING_IMAGE_BASE_URL_MESSAGE_AR =
  "تعذّر توليد الصورة: أضف عنوان مزود الصور (cloudModel.images.baseUrl أو cloudModel.baseUrl أو المتغير LOAM_IMAGE_BASE_URL).";

const NO_IMAGE_MESSAGE_AR = "استجابة مزود الصور لا تحتوي على أي صورة.";

function timeoutMessageMs(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return `انتهت مهلة توليد الصورة (${seconds} ثانية). حاول مجددًا أو اطلب حجمًا أصغر.`;
}

/** HTTP header values must be printable ASCII (mirrors OllamaClient.cloudHeaders).
 *  A key containing non-ASCII characters is a config mistake (e.g. the Arabic
 *  placeholder from config.example.json) and is treated as unconfigured. */
function asciiKey(apiKey: string | undefined): string {
  const raw = (apiKey ?? "").trim();
  if (!raw) return "";
  if (/[^\x20-\x7E]/.test(raw)) return "";
  return raw;
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function networkFailureMessage(error: unknown, key: string): string {
  if (isAbort(error)) return timeoutMessageMs(DEFAULT_TIMEOUT_MS);
  const detail = error instanceof Error ? error.message : String(error);
  return `تعذّر الاتصال بمزود الصور: ${redactSecret(detail.slice(0, 300), key)}`;
}

function httpFailureMessage(status: number, bodyText: string, key: string): string {
  let detail = bodyText.slice(0, 300);
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: unknown } | string };
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    if (typeof message === "string" && message.trim()) detail = message.slice(0, 300);
  } catch {
    /* keep the raw slice */
  }
  return `فشل توليد الصورة من المزود (HTTP ${status}): ${redactSecret(detail, key)}`;
}

function sniffImageFormat(bytes: Buffer): "png" | "jpeg" | "webp" | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }
  return undefined;
}

function formatFromContentType(contentType: string | undefined | null): "png" | "jpeg" | "webp" | "svg" | undefined {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("image/png")) return "png";
  if (ct.includes("image/jpeg") || ct.includes("image/jpg")) return "jpeg";
  if (ct.includes("image/webp")) return "webp";
  if (ct.includes("image/svg")) return "svg";
  return undefined;
}

function finalizeAsset(
  bytes: Buffer,
  mapped: MappedProviderSize,
  contentType: string | undefined | null,
): UiAssetBytes {
  if (bytes.byteLength === 0) throw new Error(NO_IMAGE_MESSAGE_AR);
  const format = sniffImageFormat(bytes) ?? formatFromContentType(contentType) ?? "png";
  return { bytes, format, width: mapped.width, height: mapped.height };
}

function decodeDataUrl(url: string): { bytes: Buffer; contentType: string } {
  const match = /^data:([^;,]*);base64,(.*)$/s.exec(url.trim());
  if (!match) throw new Error(NO_IMAGE_MESSAGE_AR);
  return { bytes: Buffer.from(match[2]!, "base64"), contentType: match[1] ?? "" };
}

export interface OpenAiCompatibleImageProviderSettings {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Defaults to 60s; overridable for tests. */
  timeoutMs?: number;
}

/**
 * Build a `UiAssetGenerator` backed by an OpenAI-compatible
 * POST {baseUrl}/images/generations endpoint using the configured BYOK key.
 * Both `b64_json` and hosted-`url` responses are supported; URL responses are
 * downloaded (without the API key) and decoded to Buffers.
 */
export function createOpenAiCompatibleImageProvider(
  settings: OpenAiCompatibleImageProviderSettings,
): UiAssetGenerator {
  const timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async function openAiCompatibleImageProvider(request: UiAssetRequest): Promise<UiAssetBytes> {
    const baseUrl = settings.baseUrl.trim();
    if (!baseUrl) throw new Error(MISSING_IMAGE_BASE_URL_MESSAGE_AR);
    const key = asciiKey(settings.apiKey);
    if (!key) throw new Error(MISSING_IMAGE_KEY_MESSAGE_AR);

    const mapped = mapProviderSize(request.width, request.height);
    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/+$/, "")}/images/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: settings.model, prompt: request.prompt, size: mapped.size, n: 1 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isAbort(error)) throw new Error(timeoutMessageMs(timeoutMs));
      throw new Error(networkFailureMessage(error, key));
    }
    const text = await res.text();
    if (!res.ok) throw new Error(httpFailureMessage(res.status, text, key));

    let json: { data?: Array<{ url?: unknown; b64_json?: unknown }> };
    try {
      json = JSON.parse(text) as { data?: Array<{ url?: unknown; b64_json?: unknown }> };
    } catch {
      throw new Error(`استجابة مزود الصور غير صالحة: ${redactSecret(text.slice(0, 200), key)}`);
    }
    const first = Array.isArray(json.data) ? json.data[0] : undefined;
    const b64 = typeof first?.b64_json === "string" ? first.b64_json : undefined;
    const url = typeof first?.url === "string" ? first.url : undefined;

    if (b64 && b64.trim()) {
      return finalizeAsset(Buffer.from(b64, "base64"), mapped, undefined);
    }
    if (url && url.trim()) {
      if (url.startsWith("data:")) {
        const { bytes, contentType } = decodeDataUrl(url);
        return finalizeAsset(bytes, mapped, contentType);
      }
      let download: Response;
      try {
        // Hosted image URLs are pre-signed; the API key must NOT travel with this call.
        download = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        if (isAbort(error)) throw new Error(timeoutMessageMs(timeoutMs));
        throw new Error(networkFailureMessage(error, key));
      }
      if (!download.ok) throw new Error(httpFailureMessage(download.status, "", key));
      const bytes = Buffer.from(await download.arrayBuffer());
      const contentType = typeof download.headers?.get === "function" ? download.headers.get("content-type") : undefined;
      return finalizeAsset(bytes, mapped, contentType);
    }
    throw new Error(NO_IMAGE_MESSAGE_AR);
  };
}

export interface ResolvedImageProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function envValue(env: Record<string, string | undefined>, loam: string, legacy: string): string {
  return (env[loam] ?? env[legacy] ?? "").trim();
}

/**
 * Resolve the image provider configuration from the cloudModel config plus env
 * overrides. Returns `undefined` when no image model is named anywhere — the
 * caller then keeps the default local generator (today's behavior). When a
 * model IS named but the key/baseUrl are missing, the config still resolves so
 * the provider can surface the honest Arabic "add your key" message at call
 * time instead of silently degrading.
 */
export function resolveImageProviderConfig(
  cloud: CloudModelLike | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedImageProviderConfig | undefined {
  const model =
    envValue(env, "LOAM_IMAGE_MODEL", "MANUS_LOCAL_IMAGE_MODEL") || (cloud?.images?.model ?? "").trim();
  if (!model) return undefined;
  const baseUrl =
    envValue(env, "LOAM_IMAGE_BASE_URL", "MANUS_LOCAL_IMAGE_BASE_URL") ||
    (cloud?.images?.baseUrl ?? "").trim() ||
    (cloud?.baseUrl ?? "").trim();
  const apiKey =
    envValue(env, "LOAM_IMAGE_API_KEY", "MANUS_LOCAL_IMAGE_API_KEY") ||
    (cloud?.images?.apiKey ?? "").trim() ||
    (cloud?.apiKey ?? "").trim();
  return { baseUrl, apiKey, model };
}

/**
 * Wire the BYOK image provider for `design_image_generate` from a Config's
 * cloudModel section (plus env overrides). Returns `undefined` when no image
 * model is configured so the tool keeps its local deterministic generator.
 */
export function imageProviderFromConfig(
  cloud: CloudModelLike | undefined,
  env: Record<string, string | undefined> = process.env,
): UiAssetGenerator | undefined {
  const resolved = resolveImageProviderConfig(cloud, env);
  return resolved ? createOpenAiCompatibleImageProvider(resolved) : undefined;
}
