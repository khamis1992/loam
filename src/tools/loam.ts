import fs from "node:fs";
import path from "node:path";
import { resolveRead, resolveWrite } from "../policy/paths.js";
import { str, type Tool } from "./registry.js";
import { appendStudio, readStudio, saveStudio, StudioError } from "../studio/store.js";

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** RFC 4180-style CSV parser: quoted delimiters, escaped quotes and multiline fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted) quoted = false;
      else if (!cell) quoted = true;
      else throw new Error("Invalid quote in CSV field");
    } else if (c === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (quoted) throw new Error("Unclosed quoted CSV field");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function createLoamTools(): Tool[] {
  return [
    {
      name: "loam_studio",
      description: "Edit the LIVE task studio visible to the user: document, presentation or spreadsheet. Always read first to obtain revision. Create with replace expectedRevision=0, then append one block/slide or a few rows at a time so the user sees generation live. Preserve user edits; on conflict read again and merge, never blindly overwrite. Spreadsheet append adds input sheet rows to the current first sheet. Content: document {blocks:[{type:heading|paragraph|bullet,text,bold?,italic?}]}; presentation {slides:[{id,title,body,notes,background:#RRGGBB,accent:#RRGGBB}]}; spreadsheet {sheets:[{name,cells:string[][]}]}. Use this tool for documents, slides and tables instead of merely describing them in chat.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["read", "replace", "append"] }, kind: { type: "string", enum: ["document", "presentation", "spreadsheet"] }, title: { type: "string" }, content: { type: "object" }, expectedRevision: { type: "integer", minimum: 0 } }, required: ["action"] },
      async run(args, ctx) {
        try {
          const action = str(args, "action");
          if (action === "read") return { ok: true, content: JSON.stringify({ artifact: readStudio(ctx.workspace) }) };
          if (action !== "replace" && action !== "append") throw new StudioError("Invalid studio action");
          const artifact = (action === "append" ? appendStudio : saveStudio)(ctx.workspace, args, args.expectedRevision);
          return { ok: true, content: JSON.stringify({ artifact }) };
        } catch (error) {
          if (error instanceof StudioError) return { ok: false, content: JSON.stringify({ error: error.message, status: error.status, ...(error.status === 409 ? { artifact: error.artifact } : {}) }) };
          throw error;
        }
      },
    },
    {
      name: "loam_document", description: "Create a Loam document as UTF-8 Markdown or a safe, printable HTML page inside this task.",
      parameters: { type: "object", properties: { path: { type: "string" }, title: { type: "string" }, content: { type: "string" }, format: { type: "string", enum: ["markdown", "html"] } }, required: ["path", "title", "content"] },
      async run(args, ctx) {
        const format = str(args, "format", "markdown");
        if (!["markdown", "html"].includes(format)) throw new Error("format must be markdown or html");
        const output = resolveWrite(ctx.workspace, str(args, "path"));
        if (!output.endsWith(format === "html" ? ".html" : ".md")) throw new Error("Use .html or .md matching the requested format");
        const title = str(args, "title"); const content = str(args, "content");
        const body = format === "html" ? `<!doctype html><html lang="ar" dir="auto"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{font:18px/1.8 system-ui;max-width:850px;margin:3rem auto;padding:1.5rem;color:#263a30}main{white-space:pre-wrap;overflow-wrap:anywhere}@media print{body{margin:0}}</style><h1>${escape(title)}</h1><main>${escape(content)}</main></html>` : `# ${title}\n\n${content}\n`;
        fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, body, "utf8");
        return { ok: true, content: JSON.stringify({ path: path.relative(ctx.workspace, output), format, bytes: Buffer.byteLength(body) }) };
      },
    },
    {
      name: "loam_dataset", description: "Inspect a task-local CSV. Reports row counts, missing values and numeric min/max/sum/mean calculated from the file, with an optional JSON output.",
      parameters: { type: "object", properties: { path: { type: "string" }, output: { type: "string" } }, required: ["path"] },
      async run(args, ctx) {
        const input = resolveRead(ctx.workspace, str(args, "path"), false);
        if (fs.statSync(input).size > 5_000_000) throw new Error("CSV limit is 5 MB");
        const rows = parseCsv(fs.readFileSync(input, "utf8")); const headers = rows.shift();
        if (!headers?.length) throw new Error("CSV is empty");
        if (rows.some((row) => row.length !== headers.length)) throw new Error("CSV rows have inconsistent column counts");
        const columns = headers.map((name, index) => {
          const values = rows.map((row) => row[index]!.trim()); const filled = values.filter(Boolean);
          const numeric = filled.length > 0 && filled.every((v) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v) && Number.isFinite(Number(v)));
          const numbers = numeric ? filled.map(Number) : []; const sum = numbers.reduce((a, b) => a + b, 0);
          return { name, missing: values.length - filled.length, type: numeric ? "number" : "text", ...(numeric ? { min: numbers.reduce((a, b) => Math.min(a, b), Infinity), max: numbers.reduce((a, b) => Math.max(a, b), -Infinity), sum, mean: sum / numbers.length } : {}) };
        });
        const result = JSON.stringify({ source: path.relative(ctx.workspace, input), rows: rows.length, columns }, null, 2);
        if (str(args, "output")) { const output = resolveWrite(ctx.workspace, str(args, "output")); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, result, "utf8"); }
        return { ok: true, content: result };
      },
    },
    {
      name: "loam_canvas", description: "Create a task-local SVG poster with title, subtitle and palette. Generates vector artwork without any external image service.",
      parameters: { type: "object", properties: { path: { type: "string" }, title: { type: "string" }, subtitle: { type: "string" }, background: { type: "string" }, foreground: { type: "string" }, accent: { type: "string" } }, required: ["path", "title"] },
      async run(args, ctx) {
        const output = resolveWrite(ctx.workspace, str(args, "path"));
        if (!output.endsWith(".svg")) throw new Error("Canvas output must end with .svg");
        const color = (key: string, fallback: string) => { const value = str(args, key, fallback); if (!/^#[\da-f]{6}$/i.test(value)) throw new Error(`${key} must be a six-digit hex color`); return value; };
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900"><rect width="1200" height="900" fill="${color("background", "#f5f1e8")}"/><circle cx="1070" cy="100" r="280" fill="${color("accent", "#a8b69b")}"/><path d="M0 760Q380 520 720 900H0Z" fill="${color("accent", "#a8b69b")}"/><g fill="${color("foreground", "#263a30")}" font-family="sans-serif" text-anchor="middle" direction="rtl"><text x="600" y="420" font-size="64">${escape(str(args, "title"))}</text><text x="600" y="510" font-size="28">${escape(str(args, "subtitle"))}</text></g></svg>`;
        fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, svg, "utf8");
        return { ok: true, content: JSON.stringify({ path: path.relative(ctx.workspace, output), width: 1200, height: 900, format: "svg" }) };
      },
    },
  ];
}
