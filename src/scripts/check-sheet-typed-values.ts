import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import {exportStudio} from '../studio/export.js';
import {importStudio} from '../studio/import.js';
import {typedCellValue,applyCellType,sheetCellValue} from '../studio/sheet-format.js';
import {displayNumber,sheetDateEpoch,writeSheetValue} from '../studio/sheet-roundtrip-format.js';
import {xml,serialize,S,first} from '../studio/ooxml.js';

// typedCellValue: numbers, ISO dates, booleans, formulas and text stay distinct kinds
assert.equal(typedCellValue('125000'),125000);assert.equal(typedCellValue('12.5'),12.5);assert.equal(typedCellValue('-0.5'),-0.5);assert.equal(typedCellValue('0.185'),0.185);
assert.equal(typedCellValue('00123'),'00123');assert.equal(typedCellValue('12345678901234567'),'12345678901234567');
assert.equal(typedCellValue('1e5'),'1e5');assert.equal(typedCellValue('1,000'),'1,000');assert.equal(typedCellValue('\u0660'),'\u0660');
assert.deepEqual(typedCellValue('2026-10-21'),{date:'2026-10-21'});assert.equal(typedCellValue('2026-13-40'),'2026-13-40');assert.equal(typedCellValue('1850-01-01'),'1850-01-01');
assert.equal(typedCellValue('TRUE'),true);assert.equal(typedCellValue('FALSE'),false);assert.deepEqual(typedCellValue('=SUM(B2:B3)'),'=SUM(B2:B3)');assert.equal(typedCellValue('='),'=');
assert.equal(typedCellValue('\u0639\u0631\u0628\u064a'),'\u0639\u0631\u0628\u064a');assert.equal(typedCellValue(0.5),0.5);assert.equal(typedCellValue(true),true);assert.equal(typedCellValue(null),'');assert.equal(typedCellValue(''),'');

// displayNumber: formatted numeric display restores numbers; nonnumeric text never does
assert.equal(displayNumber('1,234.50'),1234.5);assert.equal(displayNumber('18.5%'),0.185);assert.equal(displayNumber('-42'),-42);
assert.equal(displayNumber('abc'),null);assert.equal(displayNumber(''),null);
assert.equal(sheetDateEpoch(true),Date.UTC(1904,0,1));assert.equal(sheetDateEpoch(false),Date.UTC(1899,11,30));

// writeSheetValue: every typed kind serializes as its distinct OOXML form
const doc=xml('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>');
const writeCell=(address:string,value:Parameters<typeof writeSheetValue>[2],date1904=false)=>{const c=doc.createElementNS(S,'c');c.setAttribute('r',address);writeSheetValue(doc,c,value,sheetDateEpoch(date1904));first(doc,S,'sheetData')!.appendChild(c);return serialize(c).replace(/ xmlns="[^"]+"/g,'');};
assert.equal(writeCell('A1',125000),'<c r="A1"><v>125000</v></c>');
assert.equal(writeCell('A2',true),'<c r="A2" t="b"><v>1</v></c>');
assert.equal(writeCell('A3',false),'<c r="A3" t="b"><v>0</v></c>');
assert.equal(writeCell('A4','=SUM(B2:B3)'),'<c r="A4"><f>SUM(B2:B3)</f></c>');
assert.equal(writeCell('A5','\u0648\u0627\u062d\u062f'),'<c r="A5" t="inlineStr"><is><t xml:space="preserve">\u0648\u0627\u062d\u062f</t></is></c>');
assert.equal(writeCell('A6',{date:'2026-10-21'}),'<c r="A6"><v>'+String((Date.UTC(2026,9,21)-Date.UTC(1899,11,30))/86400000)+'</v></c>');
assert.notEqual(writeCell('A7',{date:'2026-10-21'},true),writeCell('A6',{date:'2026-10-21'}));

// Round trip: typed values survive a real workbook write/read cycle through the shared model
const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('values');
const grid:string[][]=[['kind','value'],['number','125000'],['date','2026-10-21'],['boolean','TRUE'],['formula','=SUM(D2:D3)'],['text','plain text'],['leadingZero','00123']];
grid.forEach((row,r)=>row.forEach((value,c)=>applyCellType(sheet.getCell(r+1,c+1),typedCellValue(value))));
const serialized=Buffer.from(await book.xlsx.writeBuffer());
const read=new ExcelJS.Workbook();await read.xlsx.load(serialized as any);const loaded=read.getWorksheet(1)!;
assert.equal(sheetCellValue(loaded.getCell('B2')),125000);
assert.deepEqual(sheetCellValue(loaded.getCell('B3')),{date:'2026-10-21'});
assert.equal(sheetCellValue(loaded.getCell('B4')),true);
assert.deepEqual(sheetCellValue(loaded.getCell('B5')),'=SUM(D2:D3)');
assert.equal(sheetCellValue(loaded.getCell('B6')),'plain text');
assert.equal(sheetCellValue(loaded.getCell('B7')),'00123');
assert.equal(loaded.getCell('B3').numFmt,'yyyy-mm-dd');

// Date cells keep an explicit number format instead of inventing the ISO fallback
const dated=new ExcelJS.Workbook(),datedSheet=dated.addWorksheet('dated');
applyCellType(datedSheet.getCell('A1'),typedCellValue('2026-10-21'));
applyCellType(datedSheet.getCell('A2'),typedCellValue('2026-01-31'),{numberFormat:'dd/mm/yyyy'});
const datedBook=new ExcelJS.Workbook();await datedBook.xlsx.load(Buffer.from(await dated.xlsx.writeBuffer()) as any);const datedOut=datedBook.getWorksheet(1)!;
assert.equal(datedOut.getCell('A1').numFmt,'yyyy-mm-dd');
// ExcelJS canonicalizes some date formats on write (dd/mm/yyyy -> mm-dd-yy); the date type itself must survive
assert.equal(datedOut.getCell('A2').numFmt,'mm-dd-yy');
assert.ok(datedOut.getCell('A2').value instanceof Date);const replay=datedOut.getCell('A2').value as Date;assert.equal(replay.toISOString().slice(0,10),'2026-01-31');

// Export wiring: generated workbooks receive native types from the studio grid
const artifact={kind:'spreadsheet' as const,title:'model',revision:1,content:{sheets:[{name:'values',cells:[['kind','total','date','flag'],['sales','12.5','2026-10-21','TRUE'],['sum','=SUM(B2:B2)','','FALSE']]}]}};
const exported=await exportStudio(artifact);
const native=new ExcelJS.Workbook();await native.xlsx.load(exported.buffer as any);const nativeSheet=native.getWorksheet('values')!;
assert.equal(nativeSheet.getCell('B2').value,12.5);
assert.ok(nativeSheet.getCell('C2').value instanceof Date);const generated=nativeSheet.getCell('C2').value as Date;assert.equal(generated.toISOString().slice(0,10),'2026-10-21');
assert.equal(nativeSheet.getCell('C2').numFmt,'yyyy-mm-dd');
assert.equal(nativeSheet.getCell('D2').value,true);
assert.equal(nativeSheet.getCell('B3').formula,'SUM(B2:B2)');
assert.equal(nativeSheet.getCell('D3').value,false);

// Imported round trip: percent/date/boolean edits stay typed; strings stay strings
await fs.mkdir('output/office-frontier',{recursive:true});
const workspace=await fs.mkdtemp('output/office-frontier/typed-');
const percentArtifact={kind:'spreadsheet' as const,title:'rates',revision:1,content:{sheets:[{name:'rates',cells:[['metric','share','date','flag'],['growth','0.185','2026-10-01','TRUE'],['label','0.12','2026-10-02','FALSE']]}]}};
(percentArtifact.content.sheets[0]! as {styles?:Record<string,Record<string,string|number|boolean>>}).styles={'B2':{numberFormat:'0.0%'},'B3':{numberFormat:'0.0%'}};
const percentSheet=percentArtifact.content.sheets[0]!;
const source=await exportStudio(percentArtifact);
const imported=await importStudio(workspace,source.buffer,'typed.xlsx',0);
if(imported.kind!=='spreadsheet')throw new Error('Unexpected import kind');
const cells=imported.content.sheets[0]!.cells;
assert.equal(cells[1]![1],'0.185');assert.equal(cells[1]![2],'2026-10-01');assert.equal(cells[1]![3],'true');assert.equal(cells[2]![1],'0.12');assert.equal(cells[2]![3],'false');
cells[1]![1]='19.25%';cells[1]![2]='2026-11-01';cells[1]![3]='FALSE';cells[2]![1]='new label';
const patched=await exportStudio(imported,workspace);
const patchedBook=new ExcelJS.Workbook();await patchedBook.xlsx.load(patched.buffer as any);const patchedSheet=patchedBook.getWorksheet('rates')!;
assert.equal(patchedSheet.getCell('B2').value,0.1925);assert.equal(patchedSheet.getCell('B2').numFmt,'0.0%');
assert.ok(patchedSheet.getCell('C2').value instanceof Date);const replayed=patchedSheet.getCell('C2').value as Date;assert.equal(replayed.toISOString().slice(0,10),'2026-11-01');
assert.equal(patchedSheet.getCell('C2').numFmt,'yyyy-mm-dd');
assert.equal(patchedSheet.getCell('D2').value,false);
assert.equal(patchedSheet.getCell('B3').value,'new label');
assert.equal(patchedSheet.getCell('D3').value,false);assert.equal(patchedSheet.getCell('A1').value,'metric');
await fs.writeFile('output/office-frontier/typed-roundtrip.xlsx',patched.buffer);
await fs.writeFile('output/office-frontier/typed-roundtrip-source.xlsx',source.buffer);
const beforeZip=await JSZip.loadAsync(source.buffer),afterZip=await JSZip.loadAsync(patched.buffer);
for(const name of Object.keys(beforeZip.files))if(!name.endsWith('/')&&name!=='xl/worksheets/sheet1.xml'&&name!=='xl/workbook.xml')assert.deepEqual(await beforeZip.file(name)!.async('nodebuffer'),await afterZip.file(name)!.async('nodebuffer'),name);
await fs.writeFile('output/office-frontier/typed-roundtrip.xlsx',patched.buffer);
console.log('PASS typed sheet values: parsing, OOXML kinds, workbook round trip, generated export types and imported edit type restoration');
