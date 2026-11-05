import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runStaticWebsiteFastPath, staticWebsiteRequest } from "../staticWebsite.js";
import { createSitePackTools } from "../../packs/build/tools.js";
import { ToolRegistry, type ToolContext } from "../../tools/registry.js";
import { createTask } from "../../server/db.js";
import { taskPath } from "../../server/taskWorkspace.js";
import { readPackProject } from "../../packs/present.js";
import type { AgentEvent } from "../events.js";
import type { Config } from "../../config.js";
import type { OllamaClient } from "../../ollama.js";

describe("static website fast path", () => {
  it("detects only static website requests", () => {
    assert.equal(staticWebsiteRequest("أنشئ موقعًا ثابتًا لمطعم", "build"), true);
    assert.equal(staticWebsiteRequest("build a dashboard with a database", "build"), false);
    assert.equal(staticWebsiteRequest("أنشئ عرضًا", "write"), false);
  });

  it("authors, previews and presents one bounded static page", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-static-fast-"));
    const task = createTask("أنشئ موقعًا ثابتًا لمطعم كويتي باسم «مطعم الديوانية» مع زر حجز");
    try {
      const registry = new ToolRegistry();
      registry.registerAll(createSitePackTools());
      for (const name of ["file_write", "preview_serve", "preview_screenshot"]) {
        registry.register({
          name,
          description: name,
          parameters: {},
          run: async (args, ctx) => {
            if (name === "file_write") {
              const file = taskPath(ctx.workspace, String(args.path));
              fs.writeFileSync(file, String(args.content));
              return { ok: true, content: "written" };
            }
            return { ok: true, content: name === "preview_serve" ? "preview running at http://127.0.0.1:4000" : "verified" };
          },
        });
      }
      const html = `<html dir="rtl"><head><title>مطعم الديوانية</title><style>body{font-family:sans-serif}</style></head><body><main><h1>مطعم الديوانية</h1>${"<p>مأكولات كويتية أصيلة وحجز طاولة</p>".repeat(20)}<button>حجز طاولة</button></main></body></html>`;
      const ollama = {
        chat: async () => ({ model: "test-model", content: JSON.stringify({ html }), toolCalls: [], usage: { promptTokens: 10, completionTokens: 20, durationMs: 30 } }),
      } as unknown as OllamaClient;
      const events: AgentEvent[] = [];
      const result = await runStaticWebsiteFastPath({
        cfg: { workspace, model: "test-model", agent: { temperature: 0.1, requestTimeoutMs: 1000 } } as Config,
        ollama,
        tools: registry,
        emit: (event) => events.push(event),
        prompt: task.prompt,
        taskId: task.id,
        packId: "loam-build",
      });
      assert.equal(result.verified, true);
      const root = path.join(workspace, ".loam-tasks", task.id);
      assert.equal(readPackProject(root, "loam-build")?.items[0]?.state, "final");
      assert.ok(events.findIndex((event) => event.type === "artifact_published") < events.findIndex((event) => event.type === "done"));
      assert.ok(fs.statSync(path.join(root, "index.html")).size > 500);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
