import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../../tools/registry.js";
import { readMobile } from "../../mobile/store.js";
import { readPackProject, writePackProject, presentPackProject } from "../present.js";
import { taskPath } from "../../server/taskWorkspace.js";

function json(value: unknown): ToolResult {
  return { ok: true, content: JSON.stringify(value) };
}

export function createMobilePackTools(): Tool[] {
  return [{
    name: "mobile_present",
    description: "Host-only gate that verifies the current screen-based mobile project and publishes its real mobile.json. Does not claim an APK, Expo build or signed store package.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async run(_args, ctx: ToolContext) {
      try {
        const project = readMobile(ctx.workspace);
        if (!project) return { ok: false, content: JSON.stringify({ error: "mobile_project_missing", retry: true }) };
        const screens = new Map(project.screens.map((screen) => [screen.id, screen]));
        for (const screen of project.screens) {
          for (const block of screen.blocks) {
            if (block.target && !screens.has(block.target)) return { ok: false, content: JSON.stringify({ error: "invalid_navigation_target", target: block.target }) };
          }
        }
        const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "mobile-app";
        const file = `uploads/${slug}.mobile.json`;
        const absolute = taskPath(ctx.workspace, file);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, JSON.stringify(project, null, 2));
        const previous = readPackProject(ctx.workspace, "loam-mobile");
        writePackProject(ctx.workspace, {
          projectId: previous?.projectId ?? ctx.taskId ?? slug,
          packId: "loam-mobile",
          revision: (previous?.revision ?? 0) + 1,
          items: [{ id: "mobile-1", state: "final", path: file }],
          data: { title: project.title, screenCount: project.screens.length, nativePackage: false },
        });
        const presented = presentPackProject({ workspace: ctx.workspace, packId: "loam-mobile", kind: "app", artifacts: [{ path: file, kind: "file", title: project.title, mime: "application/json" }], emit: ctx.emit });
        if (!presented.ok) return { ok: false, content: JSON.stringify(presented) };
        return json({ ...presented, screenCount: project.screens.length, nativePackage: false });
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : String(error) };
      }
    },
  }];
}
