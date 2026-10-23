/**
 * V10 acceptance tests: `preview_screenshot` renders a fixture site at the
 * three responsive viewports and reports the browser errors it produced.
 *
 * The fixture is a tiny self-contained Arabic/RTL page (no external requests),
 * served by the real PreviewService and rendered by the real headless browser.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Config } from "../../config.js";
import { getLoamMode } from "../../modes/catalog.js";
import { classifyToolCall } from "../../policy/riskTier.js";
import type { ToolContext } from "../../tools/registry.js";
import { createPreviewTools } from "../../tools/preview.js";
import { PreviewService } from "../serve.js";
import { DEFAULT_VIEWPORTS, PreviewScreenshotService } from "../shot.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const FIXTURE_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><title>صفحة اختبار</title></head>
<body>
  <main><h1>مرحبا بالعالم</h1><p>محتوى حقيقي للمعاينة.</p></main>
  <script>
    console.error("fixture console failure");
    console.warn("fixture warning");
    setTimeout(function () { throw new Error("fixture page failure"); }, 0);
  </script>
</body>
</html>`;

function testConfig(workspace: string): Config {
  return {
    workspace,
    browser: { channel: "", headless: true, viewport: { width: 1280, height: 800 } },
    policy: { networkEnabled: false },
  } as unknown as Config;
}

function toolContext(workspace: string): ToolContext {
  return { cfg: testConfig(workspace), workspace, emit: () => {} } as unknown as ToolContext;
}

describe("preview_screenshot", () => {
  let workspace: string;
  let preview: PreviewService;

  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-shot-"));
    fs.writeFileSync(path.join(workspace, "index.html"), FIXTURE_HTML);
    preview = new PreviewService();
  });

  after(() => {
    preview.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("serves a fixture site and captures three PNGs with an error list", async () => {
    const inst = await preview.start(workspace);
    const service = new PreviewScreenshotService(testConfig(workspace));
    const result = await service.capture({ workspace, url: inst.url, waitMs: 50 });

    assert.equal(result.ok, true, result.message);
    assert.equal(result.shots.length, DEFAULT_VIEWPORTS.length);
    assert.deepEqual(result.shots.map((shot) => shot.viewport.name), ["mobile", "tablet", "desktop"]);

    for (const shot of result.shots) {
      assert.ok(fs.existsSync(shot.file), `missing ${shot.file}`);
      const bytes = fs.readFileSync(shot.file);
      assert.ok(bytes.subarray(0, 8).equals(PNG_MAGIC), `${shot.relative} is not a PNG`);
    }

    assert.ok(result.errors.includes("fixture console failure"), `console error missing: ${result.errors.join(" | ")}`);
    assert.ok(result.errors.includes("fixture page failure"), `page error missing: ${result.errors.join(" | ")}`);
    assert.ok(result.warnings.includes("fixture warning"), `warning missing: ${result.warnings.join(" | ")}`);
  });

  it("is reachable through the preview tool registry and attaches the images", async () => {
    await preview.start(workspace);
    const tools = createPreviewTools(preview, testConfig(workspace));
    const shot = tools.find((tool) => tool.name === "preview_screenshot");
    assert.ok(shot, "preview_screenshot is not registered");

    const res = await shot!.run({}, toolContext(workspace));

    assert.equal(res.ok, true, res.content);
    assert.match(res.content, /mobile 375x812/);
    assert.match(res.content, /tablet 768x1024/);
    assert.match(res.content, /desktop 1440x900/);
    assert.match(res.content, /errors \(2\):/);
    assert.equal(res.images?.length, 3);
  });

  it("refuses to capture without a url, a running preview or a dir", async () => {
    const idle = new PreviewService();
    const tools = createPreviewTools(idle, testConfig(workspace));
    const shot = tools.find((tool) => tool.name === "preview_screenshot")!;

    const res = await shot.run({}, toolContext(workspace));

    assert.equal(res.ok, false);
    assert.match(res.content, /preview_serve/);
  });

  it("is advertised in the build mode and classified as an exec-tier tool", () => {
    assert.ok(getLoamMode("build").tools.includes("preview_screenshot"), "build mode must expose preview_screenshot");
    assert.equal(classifyToolCall("preview_screenshot", { url: "http://127.0.0.1:1/" }, workspace), "exec");
  });
});
