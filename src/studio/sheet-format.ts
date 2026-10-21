import {validatePrintSettings,type SheetPrint} from './sheet-print.js';
import type ExcelJS from 'exceljs';
import {applyBorders} from './sheet-borders.js';
import {StudioError} from './store.js';

/** One typed studio cell value: text or formula (a string starting with '='), a real number, a real boolean, or a calendar date. */
export type StudioCellValue = string | number | boolean | { date: string };

/** Canonical decimal text accepted as a typed number: no grouping, no thousands separators, at most 15 significant digits. */
export const numericText = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const XLSX_DATE_START = 1900, XLSX_NUMBER_LIMIT = 1e15;

/** Parse one studio grid value into its typed form so numbers, calendar dates, booleans and formulas stay distinct from text. */
export function typedCellValue(value: unknown): StudioCellValue {
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= XLSX_NUMBER_LIMIT ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.startsWith("=") && value.length > 1) return value;
    if (isoDate.test(value) && Number(value.slice(0, 4)) >= XLSX_DATE_START && Number.isFinite(Date.parse(value + "T00:00:00Z"))) return { date: value };
    if (numericText.test(value) && value.replace(/[-.]/g, "").length <= 15 && Math.abs(Number(value)) <= XLSX_NUMBER_LIMIT) return Number(value);
    if (value === "true" || value === "TRUE") return true;
    if (value === "false" || value === "FALSE") return false;
    return value;
  }
  return String(value ?? "");
}

/** Write one typed studio value into an ExcelJS cell; date cells gain an ISO display format only when no explicit number format exists. */
export function applyCellType(cell: ExcelJS.Cell, value: StudioCellValue, style?: { numberFormat?: string | number | boolean }): void {
  if (typeof value === "number") cell.value = value;
  else if (typeof value === "boolean") cell.value = value;
  else if (typeof value === "object") {
    cell.value = new Date(Date.parse(value.date + "T00:00:00Z"));
    if (style?.numberFormat === undefined) cell.numFmt = "yyyy-mm-dd";
  } else if (value.startsWith("=") && value.length > 1) cell.value = { formula: value.slice(1) };
  else cell.value = value;
}

/** Read one ExcelJS cell back into a typed studio value; formula cells keep their editable formula text. */
export function sheetCellValue(cell: ExcelJS.Cell): StudioCellValue {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  if (value instanceof Date) return { date: value.toISOString().slice(0, 10) };
  const object = value as unknown as Record<string, unknown>; 
  if (typeof object.formula === "string") return "=".concat(object.formula);
  if (Array.isArray(object.richText)) return (object.richText as Array<{ text?: string }>).map((part) => String(part.text)).join("");
  if (typeof object.text === "string") return object.text;
  if (typeof object.error === "string") return object.error;
  const result = object.result;
  if (typeof result === "number" && Number.isFinite(result) && Math.abs(result) <= XLSX_NUMBER_LIMIT) return result;
  if (typeof result === "boolean") return result;
  if (result instanceof Date) return { date: result.toISOString().slice(0, 10) };
  if (typeof result === "string") return result;
  return "";
}

/** Column label for a one-based index. */
export const cellAddress = (column: number, row: number): string => {
  let label = "";
  while (column) { column--; label = String.fromCharCode(65 + column % 26) + label; column = Math.floor(column / 26); }
  return label + row;
};

export function applySheetFormat(sheet:ExcelJS.Worksheet,source:{cells?:string[][];styles?:Record<string,Record<string,string|number|boolean>>;columnWidths?:number[];rowHeights?:number[];merges?:string[];hiddenRows?:boolean[];hiddenColumns?:boolean[];printSettings?:SheetPrint}){
 /** Typed values are written through the shared studio cell model; the grid keeps text and the workbook gets native types. */
  for(const [rowIndex,row] of (source.cells||[]).entries())for(const [columnIndex,value] of row.entries())applyCellType(sheet.getCell(rowIndex+1,columnIndex+1),typedCellValue(value),source.styles?.[cellAddress(columnIndex+1,rowIndex+1)]);
  for(const [address,style] of Object.entries(source.styles||{})){
  const cell=sheet.getCell(address);
  applyBorders(cell,style);
  cell.font={...cell.font,...(style.fontFamily?{name:String(style.fontFamily)}:{}),...(style.fontSize?{size:Number(style.fontSize)}:{}),...(style.bold!==undefined?{bold:Boolean(style.bold)}:{}),...(style.italic!==undefined?{italic:Boolean(style.italic)}:{}),...(style.color?{color:{argb:'FF'+String(style.color).slice(1)}}:{})};
  if(style.background)cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF'+String(style.background).slice(1)}};
  if(style.alignment){const alignment=style.alignment==='both'?'justify':style.alignment==='start'?'left':style.alignment==='end'?'right':style.alignment;if(alignment==='general'){const next={...cell.alignment};delete next.horizontal;cell.alignment=next;}else cell.alignment={...cell.alignment,horizontal:alignment as ExcelJS.Alignment['horizontal']};}
  if(style.numberFormat!==undefined)cell.numFmt=String(style.numberFormat);
  if(style.wrapText!==undefined)cell.alignment={...cell.alignment,wrapText:Boolean(style.wrapText)};
  if(style.verticalAlignment)cell.alignment={...cell.alignment,vertical:style.verticalAlignment as ExcelJS.Alignment['vertical']};
 }
 source.columnWidths?.forEach((width,index)=>{sheet.getColumn(index+1).width=width;});
 source.rowHeights?.forEach((height,index)=>{sheet.getRow(index+1).height=height;});
 source.hiddenRows?.forEach((hidden,index)=>{sheet.getRow(index+1).hidden=hidden;});
 source.hiddenColumns?.forEach((hidden,index)=>{sheet.getColumn(index+1).hidden=hidden;});
 for(const range of source.merges||[]){
  const match=/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);if(!match)throw new StudioError('Invalid merged cells: '+range);
  const index=(s:string)=>[...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0),left=index(match[1]!),right=index(match[3]!),top=Number(match[2]),bottom=Number(match[4]);
  if(left>right||top>bottom||right>100||bottom>2000)throw new StudioError('Invalid merged cells: '+range);
  for(let r=top;r<=bottom;r++)for(let c=left;c<=right;c++)if(r!==top||c!==left){const value=sheet.getCell(r,c).value;if(value!==null&&value!==undefined&&value!=='')throw new StudioError('Merging would discard a populated cell: '+sheet.getCell(r,c).address);}
  try{sheet.mergeCells(range);}catch{throw new StudioError('Overlapping or invalid merged cells: '+range);}
 }
 sheet.pageSetup={paperSize:9,orientation:sheet.columnCount>6?'landscape':'portrait',fitToPage:true,fitToWidth:1,fitToHeight:0,margins:{left:.3,right:.3,top:.5,bottom:.5,header:.2,footer:.2}};
 if(source.printSettings){const settings=validatePrintSettings(source.printSettings);sheet.pageSetup={...sheet.pageSetup,...settings,paperSize:settings.paperSize||undefined};}
 sheet.headerFooter={oddFooter:'&L'+sheet.name+'&R&P / &N'};
}
