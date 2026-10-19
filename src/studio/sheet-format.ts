import {validatePrintSettings,type SheetPrint} from './sheet-print.js';
import type ExcelJS from 'exceljs';
import {applyBorders} from './sheet-borders.js';
import {StudioError} from './store.js';

export function applySheetFormat(sheet:ExcelJS.Worksheet,source:{styles?:Record<string,Record<string,string|number|boolean>>;columnWidths?:number[];rowHeights?:number[];merges?:string[];hiddenRows?:boolean[];hiddenColumns?:boolean[];printSettings?:SheetPrint}){
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
