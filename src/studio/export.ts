import JSZip from "jszip";
import {chartScale} from '../../ui/chart-scale.js';
import { exportImported } from "./roundtrip.js";
import { positionWord } from './word-position.js';
import {applySheetFormat} from './sheet-format.js';
import { StudioError } from "./store.js";
import { Packer } from "docx";
import { createWordDocument } from "./word.js";
import PptxGenJS from "pptxgenjs";
import ExcelJS from "exceljs";
import { validateStudio, type StudioArtifact } from "./store.js";

const isRtl = (text: string) => /[\u0590-\u08ff]/u.test(text);
function filename(title: string, extension: string): string {
  let name = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "").trim().slice(0, 120) || "Loam";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `Loam-${name}`;
  return `${name}.${extension}`;
}
function foreground(hex: string): string {
  const rgb = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  return rgb[0]! * .299 + rgb[1]! * .587 + rgb[2]! * .114 > 150 ? "18202B" : "FFFFFF";
}

/** Produce editable native Office files, never HTML with an Office extension. */
export async function exportStudio(input: StudioArtifact, workspace?: string): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  const artifact = { ...validateStudio(input), revision: input.revision } as StudioArtifact;
  if (artifact.sourceId) {
    if (!workspace) throw new StudioError("Task workspace is required for imported files");
    const extension = artifact.kind === "document" ? "docx" : artifact.kind === "presentation" ? "pptx" : "xlsx";
    const contentType = artifact.kind === "document" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : artifact.kind === "presentation" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const raw=await exportImported(artifact, workspace);
    return { buffer: artifact.kind==='document'?await positionWord(raw,artifact):raw, filename: filename(artifact.title, extension), contentType };
  }
  if (artifact.kind === "document") {
    const document = await createWordDocument(artifact);
    return { buffer: await positionWord(await Packer.toBuffer(document),artifact), filename: filename(artifact.title, "docx"), contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  }
  if (artifact.kind === "presentation") {
    const Presentation = PptxGenJS as unknown as typeof PptxGenJS.default;
    const deck = new Presentation();
    deck.layout = "LAYOUT_WIDE"; deck.author = "Loam"; deck.subject = "Loam Studio"; deck.title = artifact.title;
    deck.theme = { headFontFace: "Segoe UI", bodyFontFace: "Segoe UI" };
    const totalSlides = artifact.content.slides.length;
    for (let slideIndex = 0; slideIndex < totalSlides; slideIndex += 1) {
      const item = artifact.content.slides[slideIndex]!;
      const slide = deck.addSlide();
      slide.background = { color: item.background.slice(1) };
      const rtl = isRtl(item.title);
      const align = rtl ? "right" : "left";
      const inkColor = foreground(item.background);
      if (item.textBoxes?.length) {
        for (const box of item.textBoxes) {
          const content = String(box.text || "");
          slide.addText(content, { x: Number(box.x) * 13.333333 / 100, y: Number(box.y) * 7.5 / 100, w: Number(box.w) * 13.333333 / 100, h: Number(box.h) * 7.5 / 100,
            fontFace: String(box.fontFamily || "Segoe UI"), fontSize: Number(box.fontSize) || 22, bold: box.bold === true, italic: box.italic === true,
            color: String(box.color || "#" + inkColor).slice(1), ...(box.background ? { fill: { color: String(box.background).slice(1) } } : {}),
            align: box.alignment === "center" ? "center" : box.alignment === "right" ? "right" : box.alignment === "justify" ? "justify" : "left", rtlMode: isRtl(content),
            valign: "top", margin: box.background ? 12 : 0, breakLine: false, fit: "shrink" });
        }
      } else {
        const lines = item.body.split("\n").map((line) => line.trim()).filter(Boolean);
        const subtitle = lines[0] ?? "";
        const bodyLines = lines.slice(1);
        slide.addShape(deck.ShapeType.rect, { x: rtl ? 12.8 : 0.55, y: 0.55, w: 0.12, h: 6.35, line: { color: item.accent.slice(1), transparency: 100 }, fill: { color: item.accent.slice(1) } });
        slide.addText(item.title, { x: rtl ? 0.55 : 0.95, y: 0.65, w: 11.4, h: 1.1, fontSize: 40, bold: true, color: item.accent.slice(1), breakLine: false, fit: "shrink", rtlMode: rtl, align, margin: 0 });
        if (subtitle) slide.addText(subtitle, { x: rtl ? 0.55 : 0.95, y: 1.85, w: 11.4, h: 0.5, fontSize: 18, color: inkColor, fit: "shrink", rtlMode: isRtl(subtitle), align, margin: 0 });
        slide.addShape(deck.ShapeType.line, { x: 0.55, y: 2.5, w: 12.25, h: 0, line: { color: "DCE3DC", width: 1 } });
        if (bodyLines.length > 0) {
          const cardCount = Math.min(3, bodyLines.length);
          const cardWidth = 3.8;
          const cardHeight = 3.5;
          const startX = rtl ? 8.5 : 0.95;
          const startY = 2.8;
          for (let i = 0; i < cardCount; i += 1) {
            const x = rtl ? startX - i * (cardWidth + 0.3) : startX + i * (cardWidth + 0.3);
            const y = startY;
            slide.addShape(deck.ShapeType.rect, { x, y, w: cardWidth, h: cardHeight, fill: { color: "FFFFFF" }, line: { color: "DCE3DC", width: 0.5 } });
            slide.addShape(deck.ShapeType.rect, { x: rtl ? x + cardWidth - 0.1 : x, y: y + 0.2, w: 0.08, h: 0.3, fill: { color: item.accent.slice(1) }, line: { color: item.accent.slice(1), transparency: 100 } });
            slide.addText(String(i + 1).padStart(2, "0"), { x: rtl ? x + 0.2 : x + cardWidth - 0.6, y: y + 0.15, w: 0.5, h: 0.3, fontSize: 10, color: "66736B", align: rtl ? "left" : "right", margin: 0 });
            slide.addText(bodyLines[i]!, { x: x + 0.2, y: y + 0.6, w: cardWidth - 0.4, h: cardHeight - 0.8, fontSize: 14, color: inkColor, rtlMode: isRtl(bodyLines[i]!), align, valign: "top", margin: 0 });
          }
          if (bodyLines.length > 3) slide.addText(bodyLines.slice(3).join("\n"), { x: 0.95, y: 6.5, w: 11.4, h: 0.8, fontSize: 12, color: "66736B", rtlMode: isRtl(bodyLines[3]!), align, margin: 0 });
        }
        slide.addShape(deck.ShapeType.line, { x: 0.55, y: 6.85, w: 12.25, h: 0, line: { color: "DCE3DC", width: 0.5 } });
        slide.addText(`${String(slideIndex + 1).padStart(2, "0")} / ${String(totalSlides).padStart(2, "0")}`, { x: 11.5, y: 6.9, w: 1.3, h: 0.3, fontSize: 9, color: "66736B", align: "right", margin: 0 });
      }
      for (const image of item.images || []) slide.addImage({ data: image.src, altText: image.alt, x: image.x * 13.333333 / 100, y: image.y * 7.5 / 100, w: image.w * 13.333333 / 100, h: image.h * 7.5 / 100 });
      for (const table of item.tables || []) {
        const rows = [table.columns, ...table.rows].map((row, r) => row.map((text) => ({ text, options: { bold: r === 0, color: r === 0 ? foreground(table.headerColor) : "172D2A", fill: { color: r === 0 ? table.headerColor.slice(1) : r % 2 ? "F1F6F3" : "FFFFFF" }, align: isRtl(text) ? "right" as const : "left" as const } })));
        slide.addTable(rows, { x: table.x * 13.333333 / 100, y: table.y * 7.5 / 100, w: table.w * 13.333333 / 100, h: table.h * 7.5 / 100,
          rowH: table.h * 7.5 / 100 / (table.rows.length + 1), fontFace: "Segoe UI", fontSize: table.fontSize, margin: 6, border: { type: "solid", pt: 0.5, color: "CADBD3" }, valign: "middle", autoPage: false });
      }
      if (item.notes) slide.addNotes(item.notes);
      for (const chart of item.charts || []) {
        const scale = chartScale(chart.series.flatMap((s) => s.values));
        slide.addChart(chart.type === "line" ? deck.ChartType.line : deck.ChartType.bar,
          chart.series.map((s) => ({ name: s.name, labels: chart.labels, values: s.values })),
          { x: chart.x * 13.333333 / 100, y: chart.y * 7.5 / 100, w: chart.w * 13.333333 / 100, h: chart.h * 7.5 / 100,
            title: chart.title, showTitle: !!chart.title, showLegend: true, legendPos: "b", legendFontFace: "Segoe UI", legendFontSize: 12,
            catAxisLabelFontFace: "Segoe UI", catAxisLabelFontSize: 12, valAxisLabelFontFace: "Segoe UI", valAxisLabelFontSize: 12,
            chartColors: chart.series.map((s) => s.color.slice(1)), barDir: "col", barGrouping: "clustered", showValue: false,
            lineDataSymbol: "circle", lineSize: 2, chartArea: { fill: { color: "FFFFFF" } }, valGridLine: { color: "D9E4DE", size: 0.5 },
            valAxisMinVal: scale.min, valAxisMaxVal: scale.max, valAxisMajorUnit: scale.step, catAxisLabelPos: "low" });
      }
    }
    if (!artifact.content.slides.length) deck.addSlide();
    const result = await deck.write({ outputType: "nodebuffer" });
    const buffer = await markArabicSlides(Buffer.from(result as Uint8Array));
    return { buffer, filename: filename(artifact.title, "pptx"), contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Loam"; workbook.title = artifact.title; workbook.calcProperties.fullCalcOnLoad = true;
  for (const source of artifact.content.sheets) {
    const sheet = workbook.addWorksheet(source.name, { views: [{ rightToLeft: source.cells.some((row) => row.some(isRtl)) }] });
    source.cells.forEach((row, rowIndex) => row.forEach((value, colIndex) => {
      const cell = sheet.getCell(rowIndex + 1, colIndex + 1);
      // Formula cells remain editable and are recalculated by the spreadsheet application.
      if (value.startsWith("=") && value.length > 1) cell.value = { formula: value.slice(1) };
      else if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && value.replace(/[-.]/g, "").length <= 15) cell.value = Number(value);
      else cell.value = value;
      cell.font = { name: "Arial", size: 11 };
      cell.alignment = { vertical: "top", wrapText: true, ...(isRtl(value) ? { horizontal: "right" as const } : {}) };
    }));
    sheet.columns.forEach((column) => { column.width = 22; });
    applySheetFormat(sheet,source);
  }
  if (!workbook.worksheets.length) workbook.addWorksheet("Loam");
  return { buffer: Buffer.from(await workbook.xlsx.writeBuffer()), filename: filename(artifact.title, "xlsx"), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
}

/** pptxgenjs ignores rtlMode. Arabic slides need rtl="1" and a complex-script font. */
async function markArabicSlides(buffer: Buffer): Promise<Buffer> {
  const arabic = /[\u0590-\u08ff]/;
  const zip = await JSZip.loadAsync(buffer);
  let changed = false;
  for (const name of Object.keys(zip.files)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
    const file = zip.file(name);
    if (!file) continue;
    let xml = await file.async("string");
    if (!arabic.test(xml) || xml.includes('rtl="1"')) continue;
    xml = xml.replace(/<a:pPr\b([^>]*?)>/g, '<a:pPr rtl="1"$1>');
    if (!xml.includes('rtl="1"')) xml = xml.replace(/<a:p\b/g, '<a:p rtl="1"');
    xml = xml.replace(/<a:latin typeface="[^"]*"/g, '<a:latin typeface="Segoe UI"');
    if (!xml.includes("<a:cs ")) xml = xml.replace(/<a:latin typeface="Segoe UI"\/>/g, '<a:latin typeface="Segoe UI"/><a:cs typeface="Segoe UI"/>');
    zip.file(name, xml);
    changed = true;
  }
  if (!changed) return buffer;
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}


