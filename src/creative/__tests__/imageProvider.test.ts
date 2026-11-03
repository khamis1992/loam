/**
 * W5 tests: the BYOK OpenAI-compatible image provider behind design_image_generate.
 *
 * Covers the size-bucket mapping, the config/env resolution (parent cloudModel
 * fallback + LOAM_IMAGE_* overrides), the happy paths (b64_json, hosted url,
 * data: url), Arabic key-redacted failures, the honest unconfigured message,
 * and the end-to-end tool wiring — the network is always stubbed.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

import type { Config } from "../../config.js";
import type { Emit } from "../../agent/events.js";
import type { ToolContext } from "../../tools/registry.js";
import { createDesignAssetsTools } from "../../tools/designAssets.js";
import {
  MISSING_IMAGE_KEY_MESSAGE_AR,
  createOpenAiCompatibleImageProvider,
  imageProviderFromConfig,
  mapProviderSize,
  redactSecret,
  resolveImageProviderConfig,
} from "../imageProvider.js";

// 1x1 transparent PNG — real magic bytes so format sniffing is exercised.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const SECRET_KEY = "sk-test-DO-NOT-LEAK-123";

let tmpDir = "";
const originalFetch = globalThis.fetch;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-image-provider-"));
});

after(() => {
  globalThis.fetch = originalFetch;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function ctx(workspace = tmpDir): ToolContext {
  return { cfg: {} as Config, workspace, emit: (() => undefined) as Emit };
}

function jsonFetchSpy(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
      arrayBuffer: async () => Buffer.from(JSON.stringify(payload)),
      headers: { get: () => "application/json" },
    };
  }) as unknown as typeof fetch;
  return calls;
}

describe("mapProviderSize", () => {
  it("maps the tool's default and common sizes onto provider buckets", () => {
    assert.deepEqual(mapProviderSize(800, 600), { size: "1536x1024", width: 1536, height: 1024 });
    assert.deepEqual(mapProviderSize(), { size: "1536x1024", width: 1536, height: 1024 });
    assert.deepEqual(mapProviderSize(400, 300), { size: "512x512", width: 512, height: 512 });
    assert.deepEqual(mapProviderSize(200, 200), { size: "256x256", width: 256, height: 256 });
    assert.deepEqual(mapProviderSize(600, 800), { size: "1024x1536", width: 1024, height: 1536 });
    assert.deepEqual(mapProviderSize(1024, 1024), { size: "1024x1024", width: 1024, height: 1024 });
    // A near-square landscape stays square rather than stretching.
    assert.deepEqual(mapProviderSize(1000, 900), { size: "1024x1024", width: 1024, height: 1024 });
  });
});

describe("redactSecret", () => {
  it("removes every occurrence of the secret", () => {
    const out = redactSecret(`key=${SECRET_KEY} again ${SECRET_KEY}`, SECRET_KEY);
    assert.ok(!out.includes(SECRET_KEY));
    assert.equal(out.split("[REDACTED]").length - 1, 2);
  });
});

describe("resolveImageProviderConfig", () => {
  it("returns undefined when no image model is named anywhere", () => {
    assert.equal(resolveImageProviderConfig(undefined, {}), undefined);
    assert.equal(resolveImageProviderConfig({ baseUrl: "https://api", apiKey: "k" }, {}), undefined);
    assert.equal(resolveImageProviderConfig({ baseUrl: "https://api", images: { model: "" } }, {}), undefined);
  });

  it("inherits the parent cloudModel key and base URL when only a model is named", () => {
    const resolved = resolveImageProviderConfig(
      { baseUrl: "https://openrouter.ai/api/v1", apiKey: "parent-key", images: { model: "gpt-image-1" } },
      {},
    );
    assert.deepEqual(resolved, { baseUrl: "https://openrouter.ai/api/v1", apiKey: "parent-key", model: "gpt-image-1" });
  });

  it("images section overrides the parent, and env overrides everything", () => {
    const sectionOnly = resolveImageProviderConfig(
      {
        baseUrl: "https://parent",
        apiKey: "parent-key",
        images: { model: "m1", baseUrl: "https://images", apiKey: "images-key" },
      },
      {},
    );
    assert.deepEqual(sectionOnly, { baseUrl: "https://images", apiKey: "images-key", model: "m1" });

    const envWins = resolveImageProviderConfig(
      { baseUrl: "https://parent", apiKey: "parent-key", images: { model: "m1", apiKey: "images-key" } },
      { LOAM_IMAGE_MODEL: "m2", LOAM_IMAGE_BASE_URL: "https://env", LOAM_IMAGE_API_KEY: "env-key" },
    );
    assert.deepEqual(envWins, { baseUrl: "https://env", apiKey: "env-key", model: "m2" });
  });

  it("accepts the MANUS_LOCAL_IMAGE_* aliases", () => {
    const resolved = resolveImageProviderConfig(undefined, { MANUS_LOCAL_IMAGE_MODEL: "m", MANUS_LOCAL_IMAGE_API_KEY: "k", MANUS_LOCAL_IMAGE_BASE_URL: "https://alias" });
    assert.deepEqual(resolved, { baseUrl: "https://alias", apiKey: "k", model: "m" });
  });

  it("still resolves with an empty key so the provider can surface the honest message", () => {
    const resolved = resolveImageProviderConfig({ baseUrl: "https://api", images: { model: "m" } }, {});
    assert.deepEqual(resolved, { baseUrl: "https://api", apiKey: "", model: "m" });
  });
});

describe("createOpenAiCompatibleImageProvider", () => {
  const base = { baseUrl: "https://provider.test/v1", apiKey: SECRET_KEY, model: "gpt-image-1" };

  it("throws the honest Arabic message when no key is configured", async () => {
    const generate = createOpenAiCompatibleImageProvider({ ...base, apiKey: "" });
    await assert.rejects(
      () => generate({ prompt: "hero", alt: "hero" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, MISSING_IMAGE_KEY_MESSAGE_AR);
        assert.match(err.message, /أضف مفتاح مزود الصور في إعدادات النموذج السحابي/);
        return true;
      },
    );
  });

  it("treats a fully non-ASCII key (e.g. the example placeholder) as unconfigured", async () => {
    const generate = createOpenAiCompatibleImageProvider({ ...base, apiKey: "ضع-مفتاحك-هنا" });
    await assert.rejects(() => generate({ prompt: "hero", alt: "hero" }), /أضف مفتاح مزود الصور/);
  });

  it("requires a base URL with its own Arabic message", async () => {
    const generate = createOpenAiCompatibleImageProvider({ ...base, baseUrl: "" });
    await assert.rejects(() => generate({ prompt: "hero", alt: "hero" }), /أضف عنوان مزود الصور/);
  });

  it("posts the BYOK request and decodes b64_json into a PNG buffer", async () => {
    const calls = jsonFetchSpy({ data: [{ b64_json: TINY_PNG.toString("base64") }] });
    const generate = createOpenAiCompatibleImageProvider(base);
    const asset = await generate({ prompt: "صورة غلاف", alt: "غلاف", width: 800, height: 600 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://provider.test/v1/images/generations");
    const init = calls[0]!.init!;
    assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${SECRET_KEY}`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    assert.equal(body.model, "gpt-image-1");
    assert.equal(body.prompt, "صورة غلاف");
    assert.equal(body.size, "1536x1024");
    assert.equal(body.n, 1);
    assert.equal(asset.format, "png");
    assert.deepEqual(asset.bytes.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.equal(asset.width, 1536);
    assert.equal(asset.height, 1024);
  });

  it("downloads a hosted url without the API key and sniffs the format", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/images/generations")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: [{ url: "https://cdn.test/img.jpg" }] }),
          arrayBuffer: async () => Buffer.from(""),
          headers: { get: () => "application/json" },
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => "",
        arrayBuffer: async () => TINY_JPEG,
        headers: { get: () => "image/jpeg" },
      };
    }) as unknown as typeof fetch;
    const generate = createOpenAiCompatibleImageProvider(base);
    const asset = await generate({ prompt: "photo", alt: "photo", width: 600, height: 800 });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, "https://provider.test/v1/images/generations");
    assert.equal(calls[1]!.url, "https://cdn.test/img.jpg");
    const headers = calls[1]!.init?.headers as Record<string, string> | undefined;
    assert.equal(headers?.authorization, undefined, "the download call must not carry the API key");
    assert.equal(asset.format, "jpeg");
    assert.deepEqual(asset.bytes, TINY_JPEG);
    assert.equal(asset.width, 1024);
    assert.equal(asset.height, 1536);
  });

  it("decodes an inline data: url without a second request", async () => {
    const calls = jsonFetchSpy({
      data: [{ url: `data:image/png;base64,${TINY_PNG.toString("base64")}` }],
    });
    const generate = createOpenAiCompatibleImageProvider(base);
    const asset = await generate({ prompt: "icon", alt: "icon", width: 200, height: 200 });
    assert.equal(calls.length, 1);
    assert.equal(asset.format, "png");
    assert.deepEqual(asset.bytes, TINY_PNG);
    assert.deepEqual([asset.width, asset.height], [256, 256]);
  });

  it("reports an HTTP failure in Arabic with the key redacted", async () => {
    // A hostile provider echoes the bearer key back in its error body.
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: `Invalid API key provided: ${SECRET_KEY}` } }),
      arrayBuffer: async () => Buffer.from(""),
      headers: { get: () => "application/json" },
    })) as unknown as typeof fetch;
    const generate = createOpenAiCompatibleImageProvider(base);
    await assert.rejects(
      () => generate({ prompt: "hero", alt: "hero" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /فشل توليد الصورة من المزود \(HTTP 401\)/);
        assert.ok(!err.message.includes(SECRET_KEY), `message must not contain the key: ${err.message}`);
        assert.ok(err.message.includes("[REDACTED]"));
        return true;
      },
    );
  });

  it("surfaces a network timeout as an Arabic timeout message", async () => {
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        });
      });
    }) as unknown as typeof fetch;
    const generate = createOpenAiCompatibleImageProvider({ ...base, timeoutMs: 25 });
    await assert.rejects(
      () => generate({ prompt: "hero", alt: "hero" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /انتهت مهلة توليد الصورة/);
        assert.ok(!err.message.includes(SECRET_KEY));
        return true;
      },
    );
  });

  it("rejects an empty provider response", async () => {
    jsonFetchSpy({ data: [] });
    const generate = createOpenAiCompatibleImageProvider(base);
    await assert.rejects(() => generate({ prompt: "hero", alt: "hero" }), /لا تحتوي على أي صورة/);
  });
});

describe("imageProviderFromConfig → design_image_generate wiring", () => {
  it("returns undefined (local generator keeps running) when unconfigured", () => {
    assert.equal(imageProviderFromConfig(undefined, {}), undefined);
    assert.equal(imageProviderFromConfig({ baseUrl: "https://api", apiKey: "k" }, {}), undefined);
  });

  it("flows real provider bytes through the tool without changing its output shape", async () => {
    const calls = jsonFetchSpy({ data: [{ b64_json: TINY_PNG.toString("base64") }] });
    const generator = imageProviderFromConfig(
      { baseUrl: "https://provider.test/v1", apiKey: SECRET_KEY, images: { model: "gpt-image-1" } },
      {},
    );
    assert.ok(generator, "a fully configured cloudModel.images section wires the provider");
    const tool = createDesignAssetsTools({ generator }).find((t) => t.name === "design_image_generate")!;
    const res = await tool.run({ prompt: "Hero banner", alt: "Hero banner", width: 800, height: 600 }, ctx());
    assert.ok(res.ok, res.content);
    const payload = JSON.parse(res.content) as {
      assets: Array<{ file: string; generator: string; src: string; width: number; height: number; format: string }>;
      files: string[];
      imgTags: string[];
    };
    assert.equal(payload.assets.length, 1);
    assert.equal(payload.assets[0]!.generator, "injected");
    assert.equal(payload.assets[0]!.format, "png");
    assert.equal(payload.assets[0]!.width, 1536);
    assert.equal(payload.assets[0]!.height, 1024);
    assert.match(payload.assets[0]!.src, /^\/assets\/ui\/ui_[a-z0-9_-]+\.png$/);
    assert.equal(payload.files.length, 1);
    assert.match(payload.imgTags[0]!, /alt="Hero banner"/);
    assert.deepEqual(fs.readFileSync(payload.assets[0]!.file).subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.equal(calls.length, 1);
  });

  it("surfaces the honest Arabic message through the tool when the key is missing", async () => {
    const generator = imageProviderFromConfig({ baseUrl: "https://api", images: { model: "m" } }, {});
    assert.ok(generator, "a named model wires the provider even without a key");
    const tool = createDesignAssetsTools({ generator }).find((t) => t.name === "design_image_generate")!;
    const res = await tool.run({ prompt: "Hero", alt: "Hero" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /أضف مفتاح مزود الصور في إعدادات النموذج السحابي/);
  });

  it("env-only configuration wires the provider (LOAM_IMAGE_*)", async () => {
    jsonFetchSpy({ data: [{ b64_json: TINY_JPEG.toString("base64") }] });
    const generator = imageProviderFromConfig(undefined, {
      LOAM_IMAGE_BASE_URL: "https://env.test/v1",
      LOAM_IMAGE_API_KEY: "env-key",
      LOAM_IMAGE_MODEL: "env-model",
    });
    assert.ok(generator);
    const tool = createDesignAssetsTools({ generator }).find((t) => t.name === "design_image_generate")!;
    const res = await tool.run({ prompt: "Env", alt: "Env", width: 300, height: 300 }, ctx());
    assert.ok(res.ok, res.content);
    const payload = JSON.parse(res.content) as { assets: Array<{ format: string }> };
    assert.equal(payload.assets[0]!.format, "jpeg");
  });
});
