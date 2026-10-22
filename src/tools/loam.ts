import sharp from "sharp";
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveRead, resolveWrite } from "../policy/paths.js";
import { str, type Tool } from "./registry.js";
import { appendStudio, readStudio, saveStudio, StudioError, type StudioArtifact } from "../studio/store.js";

const imageRef=(src:string)=>createHash('sha256').update(src).digest('hex');
function studioToolView(artifact:StudioArtifact|null){
  if(artifact?.kind==='presentation')return {...artifact,content:{slides:artifact.content.slides.map(slide=>({...slide,...(slide.images?{images:slide.images.map(({src,...image})=>({...image,imageRef:imageRef(src)}))}:{})}))}};
  if(!artifact||artifact.kind!=='document')return artifact;
  return {...artifact,content:{blocks:artifact.content.blocks.map(b=>b.type==='image'?{type:b.type,text:b.text,alt:b.alt,sourceNode:b.sourceNode,imageRef:imageRef(b.src)}:b)}};
}

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
      description: "Edit the LIVE task studio visible to the user: document, presentation or spreadsheet. Always read first to obtain revision. Create with replace expectedRevision=0, then append one block/slide or a few rows at a time so the user sees generation live. Preserve user edits; on conflict read again and merge, never blindly overwrite. Spreadsheet append adds input sheet rows to the current first sheet. Content: document {blocks:[{type:heading|paragraph|bullet,text,bold?,italic?} OR {type:stats,text:caption,items:[{value,label,tone:teal|blue|amber}]} (1-4 cards) OR {type:table,text:caption,columns:string[],rows:string[][]} (1-6 columns, max 200 rows, rectangular) OR {type:image,path:taskRelativePngOrJpeg,alt,text:caption}]}. Images may also use src with embedded PNG/JPEG data URI. Read returns compact imageRef identifiers instead of image bytes: preserve imageRef when replacing existing image blocks. A saved:true response confirms all changes including images; do not repeat completed additions. Use existing task images; never invent paths. Rich blocks also work in imported Word documents: preserve sourceNode (or legacy sourceIndex) references on original blocks, edit their items/cells/imageRef in place using replace. New blocks have no source references. For append, optional insertAt chooses a zero-based block position anywhere in the document. Keep original captions as separate paragraphs. Original template styles, headers, images and tables are preserved. presentation {slides:[{id,title,body,notes,background:#RRGGBB,accent:#RRGGBB,textBoxes?:[{id,text,x,y,w,h,fontFamily,fontSize,bold,italic,color:#RRGGBB,background:#RRGGBB,alignment:left|center|right}],images?:[{id,path:taskRelativePngOrJpeg,alt,x,y,w,h}],tables?:[{id,columns:string[],rows:string[][],x,y,w,h,fontSize:18,headerColor:#187665}],charts?:[{id,type:column|line,title,labels:string[],series:[{name,values:number[],color:#RRGGBB}],x,y,w,h}]}]}; Charts export as native editable charts with an embedded data workbook. Use up to 20 categories and 6 series with finite numeric values matching category count. Charts in imported slides are not supported yet. Tables export as native editable PowerPoint tables; limit to 6 columns and 12 rows, keep cells brief, and leave generous height for wrapping. Tables in imported slides are not yet editable. Generated slide images use percentage geometry, must stay within slide bounds, and export as native editable pictures. Preserve imageRef on read/replace. Image insertion in imported presentations is not supported yet. Text box coordinates are percentages of a 16:9 slide, fontSize is in points. For professional generated presentations use textBoxes with deliberate title/body hierarchy, generous margins and separated cards or columns; all boxes export as editable native PowerPoint shapes. Retain all imported sourceIndex and text box IDs. spreadsheet {sheets:[{name,cells:string[][],styles?:{A1:{fontFamily,fontSize,bold,italic,color:#RRGGBB,background:#RRGGBB,alignment,numberFormat}},columnWidths?:number[],rowHeights?:number[],merges?:string[]}]}. For professional spreadsheets use clear header colors, readable column widths, restrained alternating row fills, and appropriate number formats (e.g. #,##0.00 or 0.0%). Keep numeric values numeric strings and formulas beginning with =. Use replace to apply formatting after appending rows. Imported XLSX supports cell formatting and dimensions while preserving original supporting parts; retain sourceIndex, original sheet names and merge ranges. Use this tool for documents, slides and tables instead of merely describing them in chat.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["read", "replace", "append"] }, kind: { type: "string", enum: ["document", "presentation", "spreadsheet"] }, title: { type: "string" }, content: { type: "object" }, insertAt: { type: "integer", minimum: 0 }, expectedRevision: { type: "integer", minimum: 0 } }, required: ["action"] },
      async run(args, ctx) {
        try {
          // The agent retains tool arguments in its conversation history. Never put image bytes there.
          args=structuredClone(args);
          const action = str(args, "action");
          if (action === "read") return { ok: true, content: JSON.stringify({ artifact: studioToolView(readStudio(ctx.workspace)) }) };
          if (action !== "replace" && action !== "append") throw new StudioError("Invalid studio action");
          // Resolve image files inside this task, then persist portable bounded raster data.
          const content=args.content as {blocks?:Array<Record<string,unknown>>;slides?:Array<{images?:Array<Record<string,unknown>>}>}|undefined;
          const current=readStudio(ctx.workspace);
          if(args.title===undefined&&current)args.title=current.title;
          if(action==='replace'&&current?.kind==='document'&&current.sourceId){
            const retained=new Set(Array.isArray(content?.blocks)?content.blocks.map(b=>b.sourceNode!==undefined?'node:'+b.sourceNode:'p:'+b.sourceIndex):[]);
            if(current.content.blocks.some(b=>(b.sourceIndex!==undefined||b.sourceNode!==undefined)&&!retained.has(b.sourceNode!==undefined?'node:'+b.sourceNode:'p:'+b.sourceIndex)))throw new StudioError('Replacement must retain every imported sourceIndex/sourceNode. Use append for additions; read the complete document before editing.');
          }
          const imageBlocks=args.kind==='document'?(content?.blocks||[]).filter(b=>b.type==='image'):args.kind==='presentation'?(content?.slides||[]).flatMap(s=>s.images||[]):[];
          for(const block of imageBlocks){
            if(block.src===undefined && typeof block.imageRef==='string'){
              const existing=current?.kind==='document'?current.content.blocks.find(b=>b.type==='image'&&imageRef(b.src)===block.imageRef):current?.kind==='presentation'?current.content.slides.flatMap(s=>s.images||[]).find(b=>imageRef(b.src)===block.imageRef):undefined;
              if(!existing||!('src' in existing))throw new StudioError('Image reference is unavailable in this task. Read the studio again.');
              block.src=existing.src;delete block.imageRef;
            }
            if(typeof block.path==='string'){
              const file=resolveRead(ctx.workspace,block.path,false);
              if(!/\.(png|jpe?g)$/i.test(file)||fs.statSync(file).size>10_000_000)throw new StudioError('Use a task PNG/JPEG image up to 10 MB');
              const bytes=await sharp(file,{limitInputPixels:24_000_000}).rotate().resize({width:1400,height:1400,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:85}).toBuffer();
              block.src='data:image/jpeg;base64,'+bytes.toString('base64');delete block.path;
            }
          }
          const artifact = (action === "append" ? appendStudio : saveStudio)(ctx.workspace, args, args.expectedRevision);
          return { ok: true, content: JSON.stringify({ saved:true,revision:artifact.revision,kind:artifact.kind,title:artifact.title,sourceId:artifact.sourceId,
            ...(artifact.kind==='document'?{blockTypes:artifact.content.blocks.map(b=>b.type),images:artifact.content.blocks.filter(b=>b.type==='image').map(b=>({alt:b.alt,embedded:true,imageRef:imageRef(b.src)}))}:{}),
            message:'Saved successfully. Embedded images are already stored; do not append them again. Read only if more edits are needed.' }) };
        } catch (error) {
          if (error instanceof StudioError) return { ok: false, content: JSON.stringify({ error: error.message, status: error.status, ...(error.status === 409 ? { artifact: studioToolView(error.artifact ?? null) } : {}) }) };
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
