import fs from "node:fs";
import type { Config } from "../config.js";
import type { PreviewService } from "../preview/serve.js";
import { DEFAULT_VIEWPORTS, PreviewScreenshotService, type ShotViewport } from "../preview/shot.js";
import { isInside, resolveRead } from "../policy/paths.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { bool, num, str } from "./registry.js";

/** Read an optional viewport override list; invalid entries are dropped. */
function parseViewports(args: Record<string, unknown>): ShotViewport[] | undefined {
  const raw = args["viewports"];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const viewports: ShotViewport[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = typeof record["name"] === "string" ? record["name"].trim() : "";
    const width = Number(record["width"]);
    const height = Number(record["height"]);
    if (!name || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) continue;
    viewports.push({ name, width: Math.round(width), height: Math.round(height) });
  }
  return viewports.length > 0 ? viewports : undefined;
}

export function createPreviewTools(preview: PreviewService, cfg: Config): Tool[] {
  const shots = new PreviewScreenshotService(cfg);
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
    {
      name: "preview_screenshot",
      description:
        "Render a generated site in a headless browser and save one PNG per responsive viewport, then report the browser console/page errors it produced. " +
        "Defaults to mobile 375, tablet 768 and desktop 1440 so responsive breakage and runtime errors surface before delivery. " +
        "Use it after preview_serve (or pass url) and inspect the attached images plus the error list; fix layout or script errors and capture again. " +
        "For an RTL/Arabic page confirm the layout still reads correctly at every viewport. Only the captured origin is reachable, so the page cannot call external services.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Page URL to capture. Defaults to the running preview server URL." },
          dir: { type: "string", description: "Workspace folder to serve first when no preview is running and no url is given." },
          viewports: {
            type: "array",
            description: "Optional viewport overrides. Defaults to the 375/768/1440 set.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Output file name (mobile, tablet, desktop, ...)." },
                width: { type: "number", description: "Viewport width in CSS pixels." },
                height: { type: "number", description: "Viewport height in CSS pixels." },
              },
              required: ["name", "width", "height"],
            },
          },
          fullPage: { type: "boolean", description: "Capture the whole scrollable page instead of one viewport (default true)." },
          waitMs: { type: "number", description: "Extra settle time after load, in milliseconds." },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        try {
          let url = str(args, "url", "").trim();
          if (!url) {
            const running = preview.status;
            if (running.url && running.root && isInside(ctx.workspace, running.root)) {
              url = running.url;
            } else {
              const dir = str(args, "dir", "").trim();
              if (!dir) {
                return { ok: false, content: "preview_screenshot needs a url, a running preview (preview_serve first), or a dir to serve." };
              }
              const resolved = resolveRead(ctx.workspace, dir, false);
              const inst = await preview.start(resolved, num(args, "port", 0) || undefined);
              url = inst.url;
            }
          }
          const requested = parseViewports(args) ?? DEFAULT_VIEWPORTS;
          const result = await shots.capture({
            workspace: ctx.workspace,
            url,
            viewports: requested,
            waitMs: num(args, "waitMs", 0),
            fullPage: bool(args, "fullPage", true),
            signal: ctx.signal,
          });
          const lines = [
            result.ok ? `captured ${result.shots.length} screenshot(s) at ${url}` : `screenshot capture incomplete (${result.shots.length} of ${requested.length})`,
            ...result.shots.map((shot) => `${shot.viewport.name} ${shot.viewport.width}x${shot.viewport.height}: ${shot.relative}`),
            `errors (${result.errors.length}):`,
            ...(result.errors.length > 0 ? result.errors.map((entry) => `- ${entry}`) : ["- none"]),
          ];
          if (result.warnings.length > 0) lines.push(`warnings (${result.warnings.length}): ${result.warnings.join("; ")}`);
          if (result.unavailable) lines.push(`unavailable: ${result.message ?? "browser could not be launched"}`);
          return {
            ok: result.ok,
            content: lines.join("\n"),
            ...(result.shots.length > 0
              ? { images: result.shots.map((shot) => fs.readFileSync(shot.file).toString("base64")) }
              : {}),
          };
        } catch (err) {
          return { ok: false, content: `preview_screenshot failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
  ];
}
