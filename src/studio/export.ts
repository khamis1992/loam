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
    // The package's CJS-style declarations expose an extra default under NodeNext.
    const Presentation = PptxGenJS as unknown as typeof PptxGenJS.default;
    const deck = new Presentation();
    deck.layout = "LAYOUT_WIDE"; deck.author = "Loam"; deck.subject = "Loam Studio"; deck.title = artifact.title;
    deck.theme = { headFontFace: "Arial", bodyFontFace: "Arial" };
    for (const item of artifact.content.slides) {
      const slide = deck.addSlide();
      slide.background = { color: item.background.slice(1) };
      if(item.textBoxes?.length){
        for(const box of item.textBoxes){
          const content=String(box.text||'');
          slide.addText(content,{x:Number(box.x)*13.333333/100,y:Number(box.y)*7.5/100,w:Number(box.w)*13.333333/100,h:Number(box.h)*7.5/100,
            fontFace:String(box.fontFamily||'Arial'),fontSize:Number(box.fontSize)||22,bold:box.bold===true,italic:box.italic===true,
            color:String(box.color||'#'+foreground(item.background)).slice(1),...(box.background?{fill:{color:String(box.background).slice(1)}}:{}),
            align:box.alignment==='center'?'center':box.alignment==='right'?'right':box.alignment==='justify'?'justify':'left',rtlMode:isRtl(content),
            valign:'top',margin:box.background?12:0,breakLine:false,fit:'shrink'});
        }
      }else{
      slide.addShape(deck.ShapeType.rect, { x: .55, y: .55, w: .12, h: 6.35, line: { color: item.accent.slice(1), transparency: 100 }, fill: { color: item.accent.slice(1) } });
      slide.addText(item.title, { x: .95, y: .65, w: 11.4, h: 1.1, fontSize: 30, bold: true, color: item.accent.slice(1), breakLine: false, fit: "shrink", rtlMode: isRtl(item.title), align: isRtl(item.title) ? "right" : "left", margin: 0 });
      slide.addText(item.body, { x: .95, y: 2, w: 11.4, h: 4.65, fontSize: 22, color: foreground(item.background), fit: "shrink", valign: "top", rtlMode: isRtl(item.body), align: isRtl(item.body) ? "right" : "left", margin: 0 });
      }
      for(const image of item.images||[])slide.addImage({data:image.src,altText:image.alt,x:image.x*13.333333/100,y:image.y*7.5/100,w:image.w*13.333333/100,h:image.h*7.5/100});
      for(const table of item.tables||[]){
        const rows=[table.columns,...table.rows].map((row,r)=>row.map(text=>({text,options:{bold:r===0,color:r===0?foreground(table.headerColor):'172D2A',fill:{color:r===0?table.headerColor.slice(1):r%2?'F1F6F3':'FFFFFF'},align:isRtl(text)?'right' as const:'left' as const}})));
        slide.addTable(rows,{x:table.x*13.333333/100,y:table.y*7.5/100,w:table.w*13.333333/100,h:table.h*7.5/100,
          rowH:table.h*7.5/100/(table.rows.length+1),fontFace:'Arial',fontSize:table.fontSize,margin:6,border:{type:'solid',pt:.5,color:'CADBD3'},valign:'middle',autoPage:false});
      }
      if (item.notes) slide.addNotes(item.notes);
      for(const chart of item.charts||[]){const scale=chartScale(chart.series.flatMap(s=>s.values));slide.addChart(chart.type==='line'?deck.ChartType.line:deck.ChartType.bar,
        chart.series.map(s=>({name:s.name,labels:chart.labels,values:s.values})),{
          x:chart.x*13.333333/100,y:chart.y*7.5/100,w:chart.w*13.333333/100,h:chart.h*7.5/100,
          title:chart.title,showTitle:!!chart.title,showLegend:true,legendPos:'b',legendFontFace:'Arial',legendFontSize:12,
          catAxisLabelFontFace:'Arial',catAxisLabelFontSize:12,valAxisLabelFontFace:'Arial',valAxisLabelFontSize:12,
          chartColors:chart.series.map(s=>s.color.slice(1)),barDir:'col',barGrouping:'clustered',showValue:false,
          lineDataSymbol:'circle',lineSize:2,chartArea:{fill:{color:'FFFFFF'}},valGridLine:{color:'D9E4DE',size:.5},
          valAxisMinVal:scale.min,valAxisMaxVal:scale.max,valAxisMajorUnit:scale.step,catAxisLabelPos:'low',
        });}
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
    applySheetFormat(sheet,source);
  }
  if (!workbook.worksheets.length) workbook.addWorksheet("Loam");
  return { buffer: Buffer.from(await workbook.xlsx.writeBuffer()), filename: filename(artifact.title, "xlsx"), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
}


