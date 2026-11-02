/**
 * Built-in Craft fallback. Runs when Loam Docs / Sheets / Slides cannot be
 * driven (the panel never attaches, or the caller asks for fallback). It writes
 * the same `.loam/studio.json` artifact as `loam_studio` and exports it with
 * the same Office writer as `office_export`. It does not import the Frontier core.
 */
import fs from "node:fs";
import path from "node:path";
import { readStudio, saveStudio } from "../studio/store.js";
import { exportStudio } from "../studio/export.js";
import { taskPath } from "../server/taskWorkspace.js";
import { str, type ToolContext, type ToolResult } from "./registry.js";

const NATIVE = new Set(["docs", "sheets", "slides"]);

function kindOf(app: string): "document" | "presentation" | "spreadsheet" {
  if (app === "slides") return "presentation";
  if (app === "sheets") return "spreadsheet";
  return "document";
}

function starter(app: string, title: string, body: string): { kind: "document" | "presentation" | "spreadsheet"; title: string; content: unknown } {
  const kind = kindOf(app);
  if (kind === "presentation") {
    return {
      kind,
      title,
      content: {
        slides: [{
          id: "s1",
          title,
          body: body || title,
          notes: "",
          background: "#F7F3EA",
          accent: "#187665",
        }],
      },
    };
  }
  if (kind === "spreadsheet") {
    return { kind, title, content: { sheets: [{ name: "Sheet1", cells: [[title], [body || ""]] }] } };
  }
  const blocks = [{ type: "heading", text: title }];
  if (body) blocks.push({ type: "paragraph", text: body });
  return { kind, title, content: { blocks } };
}

export async function runNativeCraftFallback(
  app: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!NATIVE.has(app)) {
    return {
      ok: false,
      content: JSON.stringify({
        ok: false,
        reason: "fallback_unavailable",
        retry: false,
        message: `No built-in editor replaces this Craft app (${app}). Say so in the user's language. Do not retry office_craft.`,
      }),
    };
  }
  const title = str(args, "title").trim() || (app === "slides" ? "عرض" : app === "sheets" ? "جدول" : "مستند");
  const body = str(args, "instruction").trim() || str(args, "body").trim();
  const current = readStudio(ctx.workspace);
  const kind = kindOf(app);
  if (!current || current.kind !== kind) {
    saveStudio(ctx.workspace, starter(app, title, body), current?.revision ?? 0);
  }
  const artifact = readStudio(ctx.workspace);
  if (!artifact) {
    return { ok: false, content: JSON.stringify({ ok: false, reason: "fallback_unavailable", retry: false, message: "The built-in studio did not save." }) };
  }
  const output = await exportStudio(artifact, ctx.workspace);
  const ext = kind === "presentation" ? ".pptx" : kind === "document" ? ".docx" : ".xlsx";
  const requested = str(args, "path").trim();
  const rel = requested.endsWith(ext) ? requested : `uploads/${output.filename}`;
  const out = taskPath(ctx.workspace, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, output.buffer);
  const saved = path.relative(ctx.workspace, out).split(path.sep).join("/");
  return {
    ok: true,
    content: JSON.stringify({
      ok: true,
      fallback: "loam_studio",
      retry: false,
      kind: artifact.kind,
      title: artifact.title,
      revision: artifact.revision,
      path: saved,
      message: "The Craft editor is unavailable. loam_studio wrote the artifact and office_export wrote the Office file. Edit further with loam_studio, then office_export. Write user-facing text in the user's language. Do not build a website.",
    }),
  };
}
