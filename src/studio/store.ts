import {validateSourceCharts,type SourceChart} from './slide-chart-data.js';
import {cropKeys} from './slide-picture-crop.js';
import {validatePrintSettings,type SheetPrint} from './sheet-print.js';
import {embeddedPicture} from './embedded-picture.js';
import {borderSides,borderStyles} from './sheet-borders.js';
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { taskPath } from "../server/taskWorkspace.js";

export type InlineSegment = { text: string; bold?: boolean; italic?: boolean; underline?: boolean; color?: string; highlight?: string; size?: number; font?: string };
export type DocumentBlock = { text: string; bold?: boolean; italic?: boolean; segments?: InlineSegment[]; sourceIndex?: number; sourceNode?: number; continuationOf?: number; frameWidth?: number; position?: {x:number;y:number;width?:number}; style?: Record<string, string | number | boolean>; cellImages?: CellImage[] } & (
  | { type: "heading" | "paragraph" | "bullet" }
  | { type: "stats"; items: Array<{ value: string; label: string; tone: "teal" | "blue" | "amber" }> }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "image"; src: string; alt: string }
);
/** An image inserted into one cell of an imported table: appended as a new paragraph, never restructuring the cell. */
export type CellImage = { row: number; column: number; src: string; alt: string };
/** Editable special text region kept outside the body flow: headers, footers and text boxes. */
export type DocumentRegion = { kind: "header" | "footer" | "textbox"; part?: string; node?: number; label: string; text: string };
export type SlideImage = {id:string;src:string;alt:string;x:number;y:number;w:number;h:number};
export type SlideChart = {id:string;type:"column"|"line";title:string;labels:string[];series:Array<{name:string;values:number[];color:string}>;x:number;y:number;w:number;h:number};
export type SlideTable = {id:string;columns:string[];rows:string[][];x:number;y:number;w:number;h:number;fontSize:number;headerColor:string};
export type StudioArtifact = { title: string; revision: number; sourceId?: string; warnings?: string[] } & (
  | { kind: "document"; content: { blocks: DocumentBlock[]; regions?: DocumentRegion[] } }
  | { kind: "presentation"; content: { slides: Array<{ id: string; title: string; body: string; notes: string; background: string; accent: string; sourceIndex?: number; images?:SlideImage[]; tables?:SlideTable[]; charts?:SlideChart[]; sourceCharts?: SourceChart[]; sourcePictures?: Array<Record<string, string | number | boolean>>; tableCells?: Array<Record<string, string | number | boolean>>; textBoxes?: Array<Record<string, string | number | boolean>> }> } }
  | { kind: "spreadsheet"; content: { sheets: Array<{ name: string; cells: string[][]; sourceIndex?: number; styles?: Record<string, Record<string, string | number | boolean>>; columnWidths?: number[]; rowHeights?: number[]; merges?: string[]; hiddenRows?: boolean[]; hiddenColumns?: boolean[]; printSettings?: SheetPrint }> } }
);
export class StudioError extends Error { constructor(message: string, public status = 400, public artifact?: StudioArtifact | null) { super(message); } }
const fail = (message: string): never => { throw new StudioError(message); };
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return fail("Expected an object"); return value as Record<string, unknown>; }
function text(value: unknown, max: number): string { if (typeof value !== "string" || value.length > max) return fail(`Expected text of at most ${max} characters`); return value; }
function array(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) return fail(`Expected at most ${max} items`); return value; }
function slideCharts(value:unknown):SlideChart[]{
 const ids=new Set<string>();return array(value,8).map(item=>{const t=object(item),id=text(t.id,100);if(!id||ids.has(id))fail('Chart IDs must be unique');ids.add(id);if(!['column','line'].includes(String(t.type)))fail('Invalid chart type');
 const labels=array(t.labels,20).map(v=>text(v,100));if(!labels.length)fail('Chart needs categories');
 const series=array(t.series,6).map(v=>{const row=object(v),name=text(row.name,100),color=text(row.color,7);if(!/^#[a-f0-9]{6}$/i.test(color))fail('Invalid chart color');const values=array(row.values,20).map(n=>{if(typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>1e12)fail('Chart values must be finite numbers');return Number(n);});if(values.length!==labels.length)fail('Chart values must match category count');return {name,color,values};});if(!series.length)fail('Chart needs a data series');
 for(const key of ['x','y','w','h']){const v=t[key];if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>100||(['w','h'].includes(key)&&v<1))fail('Invalid chart geometry');}if(Number(t.x)+Number(t.w)>100.001||Number(t.y)+Number(t.h)>100.001)fail('Chart must remain inside the slide');
 return {id,type:t.type as 'column'|'line',title:text(t.title,200),labels,series,x:Number(t.x),y:Number(t.y),w:Number(t.w),h:Number(t.h)};
 });
}
function slideTables(value:unknown):SlideTable[]{
 const ids=new Set<string>();return array(value,8).map(item=>{const t=object(item),id=text(t.id,100);if(!id||ids.has(id))fail('Table IDs must be unique');ids.add(id);
 const columns=array(t.columns,6).map(v=>text(v,200));if(!columns.length)fail('Table needs columns');
 const rows=array(t.rows,12).map(v=>{const cells=array(v,6).map(c=>text(c,500));if(cells.length!==columns.length)fail('Table must be rectangular');return cells;});
 for(const key of ['x','y','w','h']){const v=t[key];if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>100||(['w','h'].includes(key)&&v<1))fail('Invalid table geometry');}
 if(Number(t.x)+Number(t.w)>100.001||Number(t.y)+Number(t.h)>100.001)fail('Table must remain inside the slide');
 const fontSize=t.fontSize??16;if(typeof fontSize!=='number'||!Number.isFinite(fontSize)||fontSize<8||fontSize>48)fail('Invalid table font size');
 const headerColor=t.headerColor??'#187665';if(typeof headerColor!=='string'||!/^#[a-f0-9]{6}$/i.test(headerColor))fail('Invalid table header color');
 return {id,columns,rows,x:Number(t.x),y:Number(t.y),w:Number(t.w),h:Number(t.h),fontSize:Number(fontSize),headerColor:String(headerColor)};
 });
}
function slideImages(value:unknown):SlideImage[]{
 const ids=new Set<string>();return array(value,50).map(item=>{const image=object(item),id=text(image.id,100),src=text(image.src,1_400_000);
 if(!id||ids.has(id))fail('Image IDs must be unique');ids.add(id);
 if(!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(src))fail('Use embedded PNG/JPEG images');
 const bytes=Buffer.from(src.slice(src.indexOf(',')+1),'base64');if(src.startsWith('data:image/png')?!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)fail('Invalid image signature');
 for(const key of ['x','y','w','h']){const v=image[key];if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>100||(['w','h'].includes(key)&&v<1))fail('Invalid slide image geometry');}
 if(Number(image.x)+Number(image.w)>100.001||Number(image.y)+Number(image.h)>100.001)fail('Image must remain inside the slide');
 return {id,src,alt:text(image.alt??'',500),x:Number(image.x),y:Number(image.y),w:Number(image.w),h:Number(image.h)};
 });
}


function style(input: unknown): Record<string,string|number|boolean> {
 const source=object(input), out:Record<string,string|number|boolean>={};
 for(const side of borderSides){const key='border'+side,colorKey=key+'Color';if(source[key]!==undefined){if(!borderStyles.includes(String(source[key])))fail('Invalid cell border');out[key]=String(source[key]);}if(source[colorKey]!==undefined){if(typeof source[colorKey]!=='string'||!/^#[a-f0-9]{6}$/i.test(source[colorKey] as string))fail('Invalid border color');out[colorKey]=String(source[colorKey]);}}
 for(const key of ['bold','italic','wrapText'])if(source[key]!==undefined){if(typeof source[key]!=='boolean')fail('Invalid style flag');out[key]=source[key] as boolean;}
 for(const key of ['color','background'])if(source[key]!==undefined){if(typeof source[key]!=='string'||!/^#[a-f0-9]{6}$/i.test(source[key] as string))fail('Invalid style color');out[key]=source[key] as string;}
 if(source.fontFamily!==undefined){const font=text(source.fontFamily,100);if(!/^[\p{L}\p{N} _.,+\-]+$/u.test(font))fail('Invalid font family');out.fontFamily=font;}
 if(source.fontSize!==undefined){if(typeof source.fontSize!=='number'||!Number.isFinite(source.fontSize)||source.fontSize<1||source.fontSize>500)fail('Invalid font size');out.fontSize=source.fontSize as number;}
 if(source.alignment!==undefined){if(!['general','left','right','center','justify','both','start','end','distributed','fill','centerContinuous'].includes(String(source.alignment)))fail('Invalid alignment');out.alignment=String(source.alignment);}
 if(source.verticalAlignment!==undefined){if(!['top','middle','bottom','justify','distributed'].includes(String(source.verticalAlignment)))fail('Invalid vertical alignment');out.verticalAlignment=String(source.verticalAlignment);}
 if(source.numberFormat!==undefined)out.numberFormat=text(source.numberFormat,500);
 return out;
}
const highlightColors = ["yellow", "green", "cyan", "magenta", "blue", "red", "darkBlue", "darkCyan", "darkGreen", "darkMagenta", "darkRed", "darkYellow", "darkGray", "lightGray", "black", "white", "none"];
/** Inline run formatting for a text block: explicit values only, concatenated text must equal the block text. */
function inlineSegments(value: unknown): InlineSegment[] | undefined {
 if (value === undefined) return undefined;
 const out = array(value, 500).map(item => {
  const segment: Record<string, unknown> = object(item), content = text(segment.text, 20_000);
  if (!content) fail("Inline segments must not be empty");
  const clean: Record<string, unknown> = { text: content };
  for (const key of ["bold", "italic", "underline"]) { const flag = segment[key]; if (flag === undefined) continue; if (typeof flag !== "boolean") fail("Invalid inline style flag"); clean[key] = flag; }
  if (segment.color !== undefined) { if (typeof segment.color !== "string" || !/^#[a-f0-9]{6}$/i.test(segment.color)) fail("Inline colors must be six-digit hex values"); clean.color = segment.color; }
  if (segment.highlight !== undefined) { if (typeof segment.highlight !== "string" || !highlightColors.includes(segment.highlight)) fail("Invalid highlight color"); clean.highlight = segment.highlight; }
  if (segment.size !== undefined) { const size = segment.size; if (typeof size !== "number" || !Number.isFinite(size) || size < 4 || size > 144 || Math.round(size * 2) !== size * 2) fail("Invalid inline font size"); clean.size = size; }
  if (segment.font !== undefined) { const font = text(segment.font, 100); if (!/^[\p{L}\p{N} _.,+\-]+$/u.test(font)) fail("Invalid inline font family"); clean.font = font; }
  return clean;
 });
 return out.length ? (out as InlineSegment[]) : undefined;
}
/** Images appended into cells of an imported table; positions must stay inside the grid. */
function tableCellImages(value: unknown, rowCount: number, columnCount: number): CellImage[] | undefined {
 if (value === undefined) return undefined;
 const out = array(value, 4).map(item => {
  const image = object(item);
  const row = image.row, column = image.column;
  if (!Number.isSafeInteger(row) || Number(row) < 0 || Number(row) >= rowCount || !Number.isSafeInteger(column) || Number(column) < 0 || Number(column) >= columnCount) fail("Cell image position must stay inside the table grid");
  const src = text(image.src, 1_400_000);
  if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(src)) fail("Use embedded PNG or JPEG images inside table cells");
  const bytes = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64');
  if (src.startsWith('data:image/png') ? !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) fail("Invalid cell image signature");
  return { row: Number(row), column: Number(column), src, alt: text(image.alt ?? "", 500) };
 });
 return out.length ? out : undefined;
}
/** Editable header/footer/text-box regions: identified by ZIP part or body node, edited as plain text only. */
function documentRegions(value: unknown): DocumentRegion[] {
 return array(value, 40).map(item => {
  const region = object(item);
  const kind = String(region.kind);
  if (!["header", "footer", "textbox"].includes(kind)) fail("Invalid document region kind");
  const clean: Record<string, unknown> = { kind, label: text(region.label ?? kind, 200), text: text(region.text, 20_000) };
  if (region.part !== undefined) {
   if (kind === "textbox" || !/^word\/(header|footer)\d*\.xml$/.test(String(region.part))) fail("Header and footer regions need a valid header or footer part");
   clean.part = String(region.part);
  }
  if (region.node !== undefined) {
   if (kind !== "textbox" || !Number.isSafeInteger(region.node) || Number(region.node) < 0 || Number(region.node) > 10000) fail("Text box regions need a valid body node");
   clean.node = Number(region.node);
  }
  if (kind !== "textbox" && clean.part === undefined) fail("Header and footer regions need a part");
  if (kind === "textbox" && clean.node === undefined) fail("Text box regions need a body node");
  return clean as unknown as DocumentRegion;
 });
}
function metadata(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
 const result:Record<string,unknown>={};
 for(const key of keys){const v=value[key];if(v===undefined)continue;
 if(key==='sourceIndex'||key==='sourceNode'||key==='continuationOf'){if(!Number.isSafeInteger(v)||Number(v)<0||Number(v)>10000)fail('Invalid source index');result[key]=v;}
 else if(key==='frameWidth'){if(typeof v!=='number'||!Number.isFinite(v)||v<=0||v>1584)fail('Invalid frame width');result[key]=v;}
 else if(key==='position'){const p=object(v);if(!['x','y'].every(k=>typeof p[k]==='number'&&Number.isFinite(p[k])&&Number(p[k])>=0&&Number(p[k])<=1584))fail('Invalid page position');if(p.width!==undefined&&(typeof p.width!=='number'||!Number.isFinite(p.width)||p.width<24||p.width>1584))fail('Invalid positioned width');result[key]={x:p.x,y:p.y,...(p.width!==undefined?{width:p.width}:{})};}
 else if(key==='printSettings'){try{result[key]=validatePrintSettings(v);}catch{fail('Invalid worksheet print settings');}}
 else if(key==='sourceCharts')result[key]=validateSourceCharts(v);
 else if(key==='style')result[key]=style(v);
 else if(key==='styles'){const map=object(v),clean:Record<string,unknown>={};if(Object.keys(map).length>200000)fail('Too many cell styles');for(const [address,format] of Object.entries(map)){if(!/^[A-Z]{1,3}[1-9]\d{0,3}$/.test(address))fail('Invalid cell address');clean[address]=style(format);}result[key]=clean;}
 else if(key==='columnWidths'||key==='rowHeights')result[key]=array(v,key==='columnWidths'?100:2000).map(n=>{if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>10000)fail('Invalid dimension');return n;});
 else if(key==='hiddenRows'||key==='hiddenColumns')result[key]=array(v,key==='hiddenRows'?2000:100).map(n=>{if(typeof n!=='boolean')fail('Invalid visibility');return n;});
 else if(key==='merges')result[key]=array(v,10000).map(n=>{if(typeof n!=='string'||! /^[A-Z]{1,3}[1-9]\d{0,3}:[A-Z]{1,3}[1-9]\d{0,3}$/.test(n))fail('Invalid merge');return n;});
 else if(key==='textBoxes'||key==='tableCells'||key==='sourcePictures'){const ids=new Set<string>();result[key]=array(v,500).map(item=>{const box=object(item),id=text(box.id,100);if(!id||ids.has(id))fail('Invalid text box id');ids.add(id);const clean:Record<string,unknown>={...style(box),id,text:text(box.text,20000)};if(key==='sourcePictures')for(const prop of cropKeys){if(box[prop]===undefined)continue;const n=box[prop];if(typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>10000)fail('Invalid picture crop');clean[prop]=n;}if(key==='sourcePictures'&&cropKeys.every(k=>box[k]!==undefined)&&(Number(box.cropLeft)+Number(box.cropRight)>=100||Number(box.cropTop)+Number(box.cropBottom)>=100))fail('Keep a visible image crop area');if(key==='sourcePictures'&&box.src!==undefined){try{embeddedPicture(box.src);}catch{fail('Use a valid embedded PNG/JPEG replacement image');}clean.src=box.src;}for(const prop of ['x','y','w','h']){const n=box[prop];if(typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>10000||(prop==='w'||prop==='h')&&n<0)fail('Invalid text box position');clean[prop]=n;}return clean;});}
 }
 return result;
}
export function validateStudio(input: unknown): Omit<StudioArtifact, "revision"> {
  const value = object(input), content = object(value.content), title = text(value.title, 300);
  let clean: unknown;
  if (value.kind === "document") {
    clean = { kind: value.kind, title, content: { blocks: array(content.blocks, 2000).map((item) => {
      const block = object(item); if (!["heading", "paragraph", "bullet", "stats", "table", "image"].includes(String(block.type))) fail("Invalid block type");
      if (["stats", "table", "image"].includes(String(block.type))) {
        if(block.sourceIndex!==undefined) fail("New rich blocks cannot replace source paragraphs");
        const caption = text(block.text ?? "", 500);
        if(block.type === "stats") {
          const items = array(block.items, 4).map(v => { const s=object(v); const tone=s.tone ?? "teal"; if(!["teal","blue","amber"].includes(String(tone))) fail("Invalid card tone"); return {value:text(s.value,40),label:text(s.label,120),tone}; });
          if(!items.length) fail("Add at least one statistics card");
          return {...metadata(block,['sourceNode','position','frameWidth']),type:"stats",text:caption,items};
        }
        if(block.type === "table") {
          const columns=array(block.columns,6).map(v=>text(v,200)); if(!columns.length) fail("Add at least one table column");
          const rows=array(block.rows,200).map(v=>{const row=array(v,6).map(c=>text(c,1000));if(row.length!==columns.length)fail("Table rows must match column count");return row;});
          const cellImages=tableCellImages(block.cellImages, rows.length, columns.length);
          return {...metadata(block,['sourceNode','position','frameWidth']),type:"table",text:caption,columns,rows,...(cellImages?{cellImages}:{})};
        }
        const src=text(block.src,1_400_000);
        if(!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(src))fail("Images must be embedded PNG or JPEG data, up to 1 MB");
        const bytes=Buffer.from(src.slice(src.indexOf(',')+1),'base64');
        if(src.startsWith('data:image/png') ? !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)fail("Invalid image signature");
        return {...metadata(block,['sourceNode','position','frameWidth']),type:"image",text:caption,src,alt:text(block.alt ?? caption,500)};
      }
      for (const key of ["bold", "italic"]) if (block[key] !== undefined && typeof block[key] !== "boolean") fail("Invalid text style");
      const content = text(block.text, 50_000), segments = inlineSegments(block.segments);
      if (segments && segments.map(s => s.text).join("") !== content) fail("Inline formatting must cover the paragraph text exactly");
      return { ...metadata(block, ["sourceIndex", "sourceNode", "continuationOf", "position", "style"]), type: block.type, text: content, ...(block.bold !== undefined ? { bold: block.bold } : {}), ...(block.italic !== undefined ? { italic: block.italic } : {}), ...(segments ? { segments } : {}) };
    }) , ...(content.regions !== undefined ? { regions: documentRegions(content.regions) } : {})} };
  } else if (value.kind === "presentation") {
    const ids = new Set<string>();
    clean = { kind: value.kind, title, content: { slides: array(content.slides, 200).map((item) => {
      const slide = object(item), id = text(slide.id, 100); if (!id || ids.has(id)) fail("Slide ids must be unique and nonempty"); ids.add(id);
      const color = (v: unknown) => { if (typeof v !== "string" || !/^#[\da-f]{6}$/i.test(v)) return fail("Colors must be six-digit hex values"); return v; };
      const images=slide.images===undefined?undefined:slideImages(slide.images);
      const charts=slide.charts===undefined?undefined:slideCharts(slide.charts);
      if(value.sourceId&&charts?.length)fail('Charts in imported presentations are not supported yet');
      const tables=slide.tables===undefined?undefined:slideTables(slide.tables);
      if(!value.sourceId&&(slide.tableCells!==undefined||slide.sourcePictures!==undefined||slide.sourceCharts!==undefined))fail('Original table cells require an imported presentation');
      if(value.sourceId&&tables?.length)fail('New tables in imported presentations are not supported yet');
      if(value.sourceId&&images?.length)fail('New images in imported presentations are not supported yet');
      return { ...metadata(slide, ["sourceIndex", "textBoxes", "tableCells", "sourcePictures", "sourceCharts"]), ...(images?{images}:{}), ...(tables?{tables}:{}), ...(charts?{charts}:{}), id, title: text(slide.title, 500), body: text(slide.body, 20_000), notes: text(slide.notes, 20_000), background: color(slide.background), accent: color(slide.accent) };
    }) } };
  } else if (value.kind === "spreadsheet") {
    const names = new Set<string>();
    clean = { kind: value.kind, title, content: { sheets: array(content.sheets, 20).map((item) => {
      const sheet = object(item), name = text(sheet.name, 31); if (!name.trim() || /[\[\]:*?/\\]/.test(name) || names.has(name.toLowerCase())) fail("Sheet names must be unique and valid"); names.add(name.toLowerCase());
      return { ...metadata(sheet, ["sourceIndex", "styles", "columnWidths", "rowHeights", "merges", "hiddenRows", "hiddenColumns", "printSettings"]), name, cells: array(sheet.cells, 2000).map((row) => array(row, 100).map((cell) => text(cell, 10_000))) };
    }) } };
  } else return fail("Invalid studio kind");
  if (value.sourceId !== undefined) { if (typeof value.sourceId !== "string" || !/^[a-f0-9-]{36}$/.test(value.sourceId)) fail("Invalid import source"); Object.assign(clean as object, { sourceId: value.sourceId }); }
  if (value.warnings !== undefined) Object.assign(clean as object, { warnings: array(value.warnings, 20).map(v => text(v, 1000)) });
  if (Buffer.byteLength(JSON.stringify(clean)) > 2_000_000) fail("Studio content exceeds 2 MB");
  return clean as Omit<StudioArtifact, "revision">;
}
export function readStudio(workspace: string): StudioArtifact | null {
  const file = taskPath(workspace, ".loam/studio.json"); if (!fs.existsSync(file)) return null;
  if (fs.statSync(file).size > 2_001_000) fail("Studio content exceeds 2 MB");
  const value = object(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) fail("Invalid saved revision");
  return { ...validateStudio(value), revision: Number(value.revision) } as StudioArtifact;
}
/** No awaits between compare and atomic rename: concurrent HTTP/tool writes cannot lose edits. */
export function saveStudio(workspace: string, input: unknown, expectedRevision: unknown): StudioArtifact {
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) fail("expectedRevision must be a nonnegative integer");
  let clean = validateStudio(input); const current = readStudio(workspace);
  if ((current?.revision ?? 0) !== expectedRevision) throw new StudioError("Content changed. Read the latest revision before applying your changes.", 409, current);
  if(current?.sourceId && clean.kind===current.kind && !clean.sourceId) clean={...clean,sourceId:current.sourceId,warnings:current.warnings};
  if(clean.sourceId){const source=taskPath(workspace,`.loam/imports/${clean.sourceId}.zip`),manifest=taskPath(workspace,`.loam/imports/${clean.sourceId}.json`);if(!fs.existsSync(source)||!fs.existsSync(manifest))fail('Imported source is unavailable in this task');const original=JSON.parse(fs.readFileSync(manifest,'utf8'));if(original.artifact?.kind!==clean.kind)fail('Imported source kind mismatch');
 const artifact=clean as StudioArtifact;
 const items=artifact.kind==='document'?artifact.content.blocks:artifact.kind==='presentation'?artifact.content.slides:artifact.content.sheets;
 const originals=artifact.kind==='document'?original.artifact.content.blocks:artifact.kind==='presentation'?original.artifact.content.slides:original.artifact.content.sheets;
 if(artifact.kind==='document'){const nodes=new Set<number>();for(const b of artifact.content.blocks){if(b.sourceNode===undefined)continue;const old=originals.find((o:any)=>o.sourceNode===b.sourceNode);if(nodes.has(b.sourceNode)||!old||(old.type!==b.type&&(!["paragraph","heading","bullet"].includes(old.type)||!["paragraph","heading","bullet"].includes(b.type))))fail('Invalid imported element reference or type');nodes.add(b.sourceNode);}}
 const seen=new Set<number>();for(const item of items){if(item.sourceIndex===undefined){if(artifact.kind!=='document')fail('Adding slides or sheets to an imported file is not supported yet. Preserve the imported sourceIndex.');continue;}if(seen.has(item.sourceIndex)||!originals[item.sourceIndex])fail('Invalid or duplicate imported source index');seen.add(item.sourceIndex);}
 }
  const artifact = { ...clean, revision: Number(expectedRevision) + 1 } as StudioArtifact;
  const file = taskPath(workspace, ".loam/studio.json"); fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = taskPath(workspace, `.loam/studio-${randomUUID()}.tmp`);
  try { fs.writeFileSync(temporary, JSON.stringify(artifact), { encoding: "utf8", flag: "wx" }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return artifact;
}
export function appendStudio(workspace: string, input: unknown, expectedRevision: unknown): StudioArtifact {
  const value = object(input), current = readStudio(workspace);
  if (!current) return saveStudio(workspace, input, expectedRevision);
  if (current.kind !== value.kind) fail("Cannot append a different studio kind");
  const addition = validateStudio({ ...value, title: value.title ?? current.title }) as StudioArtifact;
  let content: unknown;
  if (current.kind === "document" && addition.kind === "document") {const index=value.insertAt??current.content.blocks.length;if(!Number.isSafeInteger(index)||Number(index)<0||Number(index)>current.content.blocks.length)fail('Invalid insertion position');content = { blocks: [...current.content.blocks.slice(0,Number(index)), ...addition.content.blocks,...current.content.blocks.slice(Number(index))] };}
  if (current.kind === "presentation" && addition.kind === "presentation") content = { slides: [...current.content.slides, ...addition.content.slides] };
  if (current.kind === "spreadsheet" && addition.kind === "spreadsheet") {
    if (addition.content.sheets.length !== 1 || !current.content.sheets[0]) fail("Append requires one input sheet and an existing first sheet");
    content = { sheets: current.content.sheets.map((sheet, index) => index ? sheet : { ...sheet, cells: [...sheet.cells, ...addition.content.sheets[0]!.cells] }) };
  }
  return saveStudio(workspace, { ...current, content }, expectedRevision);
}




