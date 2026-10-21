/**
 * V4: option sanitization guard for /api/auto-video/plan — client-supplied knobs
 * are validated and clamped, never trusted.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before } from "node:test";

// config.ts reads LOAM_DATA_DIR at import time, so the route module is imported dynamically.
let sanitizeOptions: (raw: Record<string, unknown>) => Record<string, unknown>;

before(async () => {
  process.env.LOAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "loam-auto-video-"));
  ({ sanitizeOptions } = await import("../routes/autoVideo.js"));
});

describe("auto-video option sanitizer", () => {
  it("keeps well-formed values", () => {
    const out = sanitizeOptions({ threshold: 0.4, targetSeconds: 20, aspect: 9 / 16, width: 1920, height: 1080, maxChars: 42, minClipSeconds: 2, maxClipSeconds: 8, minSceneSeconds: 0.6, duration: 60, maxCueSeconds: 5 });
    assert.deepStrictEqual(out, { threshold: 0.4, minSceneSeconds: 0.6, duration: 60, targetSeconds: 20, minClipSeconds: 2, maxClipSeconds: 8, aspect: 9 / 16, width: 1920, height: 1080, maxChars: 42, maxCueSeconds: 5 });
  });
  it("drops invalid numbers and out-of-range values", () => {
    const out = sanitizeOptions({ threshold: 5, targetSeconds: 0, aspect: -1, width: 999999, maxChars: 0, maxCueSeconds: 999, language: "x".repeat(50) });
    assert.deepStrictEqual(out, { language: "x".repeat(16) });
  });
  it("passes structured transcript and subjects through", () => {
    const transcript = [{ start: 0, end: 1, text: "hi" }];
    const subjects = [{ t: 0, boxes: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] }];
    const out = sanitizeOptions({ transcript, subjects });
    assert.deepStrictEqual(out.transcript, transcript);
    assert.deepStrictEqual(out.subjects, subjects);
  });
  it("rounds fractional dimensions", () => {
    assert.strictEqual(sanitizeOptions({ width: 1919.6 }).width, 1920);
  });
});
