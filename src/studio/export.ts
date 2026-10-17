import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from "docx";
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
export async function exportStudio(input: StudioArtifact): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  const artifact = { ...validateStudio(input), revision: input.revision } as StudioArtifact;
  if (artifact.kind === "document") {
    const paragraph = (text: string, options: { heading?: typeof HeadingLevel.TITLE | typeof HeadingLevel.HEADING_1; bullet?: { level: number }; bold?: boolean; italic?: boolean } = {}) => new Paragraph({
      heading: options.heading, bullet: options.bullet, bidirectional: isRtl(text),
      alignment: isRtl(text) ? AlignmentType.RIGHT : AlignmentType.LEFT,
      spacing: { after: 180 }, children: [new TextRun({ text, bold: options.bold, italics: options.italic, rightToLeft: isRtl(text), font: "Arial" })],
    });
    const document = new Document({ creator: "Loam", title: artifact.title, sections: [{ children: [
      paragraph(artifact.title, { heading: HeadingLevel.TITLE }),
      ...artifact.content.blocks.map((block) => paragraph(block.text, { bold: block.bold, italic: block.italic,
        ...(block.type === "heading" ? { heading: HeadingLevel.HEADING_1 } : {}),
        ...(block.type === "bullet" ? { bullet: { level: 0 } } : {}),
      })),
    ] }] });
    return { buffer: await Packer.toBuffer(document), filename: filename(artifact.title, "docx"), contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  }
  if (artifact.kind === "presentation") {
    // The package's CJS-style declarations expose an extra default under NodeNext.
    const Presentation = PptxGenJS as unknown as typeof PptxGenJS.default;
    const deck = new Presentation();
    deck.layout = "LAYOUT_WIDE"; deck.author = "Loam"; deck.subject = "Loam Studio"; deck.title = artifact.title;
    deck.theme = { headFontFace: "Arial", bodyFontFace: "Arial" };
    for (const item of artifact.content.slides) {
      const slide = deck.addSlide();
      slide.background = { color: item.background.slice(1) };
      slide.addShape(deck.ShapeType.rect, { x: .55, y: .55, w: .12, h: 6.35, line: { color: item.accent.slice(1), transparency: 100 }, fill: { color: item.accent.slice(1) } });
      slide.addText(item.title, { x: .95, y: .65, w: 11.4, h: 1.1, fontSize: 30, bold: true, color: item.accent.slice(1), breakLine: false, fit: "shrink", rtlMode: isRtl(item.title), align: isRtl(item.title) ? "right" : "left", margin: 0 });
      slide.addText(item.body, { x: .95, y: 2, w: 11.4, h: 4.65, fontSize: 22, color: foreground(item.background), fit: "shrink", valign: "top", rtlMode: isRtl(item.body), align: isRtl(item.body) ? "right" : "left", margin: 0 });
      if (item.notes) slide.addNotes(item.notes);
    }
    if (!artifact.content.slides.length) deck.addSlide();
    const result = await deck.write({ outputType: "nodebuffer" });
    return { buffer: Buffer.from(result as Uint8Array), filename: filename(artifact.title, "pptx"), contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
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
  }
  if (!workbook.worksheets.length) workbook.addWorksheet("Loam");
  return { buffer: Buffer.from(await workbook.xlsx.writeBuffer()), filename: filename(artifact.title, "xlsx"), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
}
