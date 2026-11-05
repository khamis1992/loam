import fs from "node:fs";
import path from "node:path";
import { str } from "../../tools/registry.js";
import type { Tool, ToolContext, ToolResult } from "../../tools/registry.js";
import { readPackProject, writePackProject, presentPackProject } from "../present.js";
import { taskPath } from "../../server/taskWorkspace.js";

function json(value: unknown): ToolResult {
  return { ok: true, content: JSON.stringify(value) };
}

export function createGamePackTools(): Tool[] {
  return [{
    name: "game_present",
    description: "Host-only gate that validates a playable HTML5 Canvas game: game loop, input handling, error capture and a real index.html.",
    parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" } } },
    async run(args, ctx: ToolContext) {
      try {
        const file = str(args, "path", "index.html");
        const absolute = taskPath(ctx.workspace, file);
        const html = fs.readFileSync(absolute, "utf8");
        if (!/<canvas\b/i.test(html)) return { ok: false, content: JSON.stringify({ error: "game_canvas_missing", path: file }) };
        if (!/requestAnimationFrame\s*\(/i.test(html)) return { ok: false, content: JSON.stringify({ error: "game_loop_missing", path: file }) };
        if (!/window\.__errors\s*=|onerror\s*=/.test(html)) return { ok: false, content: JSON.stringify({ error: "game_error_capture_missing", path: file }) };
        if (!/keydown|keyup|pointerdown|click|touchstart|mousedown/i.test(html)) return { ok: false, content: JSON.stringify({ error: "game_input_missing", path: file }) };
        if (/<script[^>]+src\s*=|<(?:img|iframe|video|audio|source)[^>]+src\s*=\s*["']https?:/i.test(html)) return { ok: false, content: JSON.stringify({ error: "external_game_asset", path: file }) };
        const previous = readPackProject(ctx.workspace, "loam-game");
        writePackProject(ctx.workspace, {
          projectId: previous?.projectId ?? ctx.taskId ?? "local-game",
          packId: "loam-game",
          revision: (previous?.revision ?? 0) + 1,
          items: [{ id: "game-1", state: "final", path: file }],
          data: { title: path.basename(file), verified: ["canvas", "loop", "input", "error-capture"] },
        });
        const presented = presentPackProject({ workspace: ctx.workspace, packId: "loam-game", kind: "page", artifacts: [{ path: file, kind: "page", title: path.basename(file), mime: "text/html" }], emit: ctx.emit });
        if (!presented.ok) return { ok: false, content: JSON.stringify(presented) };
        return json({ ...presented, verified: ["canvas", "loop", "input", "error-capture"] });
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : String(error) };
      }
    },
  }];
}
