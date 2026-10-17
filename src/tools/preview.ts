import type { PreviewService } from "../preview/serve.js";
import { isInside, resolveRead } from "../policy/paths.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

export function createPreviewTools(preview: PreviewService): Tool[] {
  return [
    {
      name: "preview_serve",
      description:
        "Serve a folder from the workspace over a local URL so the user can view the generated site/app in the app's preview panel. Returns the preview URL.",
      parameters: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Folder to serve (relative to workspace or absolute inside it)." },
          port: { type: "number", description: "Optional fixed port." },
        },
        required: ["dir"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        try {
          const dir = resolveRead(ctx.workspace, str(args, "dir", "."), false);
          const inst = await preview.start(dir, num(args, "port", 0) || undefined);
          return { ok: true, content: `preview running at ${inst.url}\nroot: ${inst.root}` };
        } catch (err) {
          return { ok: false, content: `preview_serve failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "preview_status",
      description: "Report the current preview server (url, root, request count).",
      parameters: { type: "object", properties: {} },
      async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        return { ok: true, content: JSON.stringify(preview.status.root && isInside(ctx.workspace, preview.status.root) ? preview.status : { running: false, url: null, root: null }) };
      },
    },
    {
      name: "preview_stop",
      description: "Stop the local preview server.",
      parameters: { type: "object", properties: {} },
      async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const stopped = preview.status.root && isInside(ctx.workspace, preview.status.root) ? preview.stop() : false;
        return { ok: true, content: stopped ? "preview stopped" : "no preview was running" };
      },
    },
  ];
}
