import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runSvgImageFastPath, svgImageRequest } from "../svgImage.js";
import { createTask } from "../../server/db.js";
import { ToolRegistry } from "../../tools/registry.js";
import { taskPath } from "../../server/taskWorkspace.js";
import { readPackProject } from "../../packs/present.js";
import type { Config } from "../../config.js";
import type { OllamaClient } from "../../ollama.js";
import type { AgentEvent } from "../events.js";

describe("SVG image fast path", () => {
  it("creates and presents one safe standalone SVG", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-svg-fast-"));
    const task = createTask("أنشئ شعارًا هندسيًا SVG لمتحف الفن الإسلامي");
    try {
      const registry = new ToolRegistry();
      registry.register({ name: "file_write", description: "write", parameters: {}, run: async (args, ctx) => {
        const file = taskPath(ctx.workspace, String(args.path));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, String(args.content));
        return { ok: true, content: "written" };
      } });
      const ollama = { chat: async () => ({ model: "test", content: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><title>Star</title><desc>Geometric star</desc><path d=\"M50 0L100 100H0Z\"/></svg>", toolCalls: [], usage: { promptTokens: 1, completionTokens: 2, durationMs: 3 } }) } as unknown as OllamaClient;
      const events: AgentEvent[] = [];
      const result = await runSvgImageFastPath({ cfg: { workspace, model: "test", agent: { temperature: 0.1, requestTimeoutMs: 1000 } } as Config, ollama, tools: registry, emit: (event) => events.push(event), prompt: task.prompt, taskId: task.id });
      assert.equal(result.verified, true);
      const root = path.join(workspace, ".loam-tasks", task.id);
      assert.equal(readPackProject(root, "loam-image")?.items[0]?.state, "final");
      assert.ok(events.findIndex((event) => event.type === "artifact_published") < events.findIndex((event) => event.type === "done"));
      assert.equal(svgImageRequest(task.prompt, "media"), true);
      assert.equal(svgImageRequest("create a PNG", "media"), false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
