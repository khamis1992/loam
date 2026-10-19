import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {exportStudio} from '../studio/export.js';
import type {StudioArtifact} from '../studio/store.js';
// @ts-expect-error Shared browser formatting module.
import {sheetFormatAction,formatSheetValue} from '../../ui/studio-sheet-format.js';
// @ts-expect-error Shared browser border controls.
import {applySheetBorder} from '../../ui/studio-sheet-borders.js';
const artifact:StudioArtifact={kind:'spreadsheet',title:'تقرير الأداء',revision:1,content:{sheets:[{name:'الأداء',cells:[['القسم','الإيرادات','النمو'],['التطوير','125000','0.185'],['التشغيل','98000','0.12'],['الإجمالي','=SUM(B2:B3)','']]}]}};
const sheet=artifact.content.sheets[0]!;sheetFormatAction(sheet,[0,0],'professional');sheetFormatAction(sheet,[1,1],'numberFormat','#,##0.00');sheetFormatAction(sheet,[1,2],'numberFormat','0.0%');sheetFormatAction(sheet,[3,0],'bold');
sheetFormatAction(sheet,[1,0],'wrapText');sheetFormatAction(sheet,[1,0],'verticalAlignment','middle');
sheetFormatAction(sheet,[1,0],'alignment','general');
sheet.printSettings={orientation:'landscape',paperSize:9,fitToPage:true,fitToWidth:1,fitToHeight:0,scale:85};
applySheetBorder(sheet,'B2','all','double','#187665');applySheetBorder(sheet,'B2','Left','none','#187665');
const output=await exportStudio(artifact),book=new ExcelJS.Workbook();await book.xlsx.load(output.buffer as any);const loaded=book.getWorksheet(1)!;
assert.equal(loaded.getCell('A2').alignment.horizontal,undefined);
assert.equal(loaded.pageSetup.orientation,'landscape');assert.equal(loaded.pageSetup.fitToWidth,1);assert.equal(loaded.pageSetup.fitToHeight,0);assert.equal(loaded.pageSetup.scale,85);
assert.equal(loaded.getCell('B2').border.bottom!.style,'double');assert.equal(loaded.getCell('B2').border.right!.color!.argb,'FF187665');assert.equal(loaded.getCell('B2').border.left,undefined);
assert.equal(loaded.getCell('A2').alignment.wrapText,true);assert.equal(loaded.getCell('A2').alignment.vertical,'middle');assert.equal(loaded.getCell('A1').font.bold,true);assert.equal(loaded.getCell('A1').font.color?.argb,'FFFFFFFF');assert.equal((loaded.getCell('A1').fill as any).fgColor.argb,'FF173F43');assert.equal(loaded.getCell('B2').numFmt,'#,##0.00');assert.equal(loaded.getCell('C2').numFmt,'0.0%');assert.equal(loaded.getCell('B2').value,125000);assert.equal(loaded.getCell('B4').formula,'SUM(B2:B3)');assert.equal(loaded.getRow(1).height,30);assert.equal(loaded.getColumn(1).width,sheet.columnWidths![0]);assert.equal(loaded.views[0]?.rightToLeft,true);
assert.equal(formatSheetValue('0.185',{numberFormat:'0.0%'}),'18.5%');assert.equal(formatSheetValue('125000',{numberFormat:'#,##0.00'}),'125,000.00');assert.equal(formatSheetValue('61',{numberFormat:'yyyy-mm-dd'}),'1900-03-01');
const invalid=structuredClone(artifact);invalid.content.sheets[0]!.merges=['A1:B1'];await assert.rejects(exportStudio(invalid),/discard a populated cell/);
await fs.mkdir('output/office-frontier',{recursive:true});await fs.writeFile('output/office-frontier/performance.xlsx',output.buffer);await fs.writeFile('output/office-frontier/sheet-artifact.json',JSON.stringify(artifact,null,2));console.log('PASS native XLSX styles, number formats, dimensions, formulas, RTL, safe merge rejection and display formatting');
