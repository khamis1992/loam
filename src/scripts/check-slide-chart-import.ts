import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {importStudio} from '../studio/import.js';
import {exportStudio} from '../studio/export.js';
import {saveStudio,validateStudio} from '../studio/store.js';
import {safeZip,part,all,first,serialize,R} from '../studio/ooxml.js';
import {C} from '../studio/slide-chart-data.js';
import {renderSlidePreview} from '../studio/slide-preview.js';
const out='output/office-frontier',source=await fs.readFile(out+'/slides-chart-column.pptx'),work=await fs.mkdtemp(out+'/chart-import-');
let artifact=await importStudio(work,source,'native-chart.pptx',0);if(artifact.kind!=='presentation')throw Error();
assert.deepEqual((await exportStudio(artifact,work)).buffer,source);
const chart=artifact.content.slides[0]!.sourceCharts![0]!;assert.ok(chart);assert.equal(chart.series.length,2);assert.equal(chart.labels.length,4);
chart.labels[0]='الربع الأول';chart.series[0]!.name='النتيجة المعدّلة';chart.series[0]!.values[0]=27.5;chart.series[1]!.values[3]=92;
artifact=saveStudio(work,artifact,1);
const output=await exportStudio(artifact,work),before=await safeZip(source),after=await safeZip(output.buffer);
const chartName=Object.keys(after.files).find(n=>/^ppt\/charts\/loam-chart-.*\.xml$/.test(n))!,newChart=await part(after,chartName),oldChart=await part(before,'ppt/charts/chart1.xml');
const values=(doc:any)=>all(doc,C,'ser').map(s=>first(first(s,C,'val'),C,'numCache'));
assert.equal(first(values(newChart)[0],C,'v').textContent,'27.5');assert.equal(first(first(all(newChart,C,'ser')[0],C,'tx'),C,'v').textContent,'النتيجة المعدّلة');
for(const name of ['valAx','catAx','title'])assert.equal(serialize(first(newChart,C,name)),serialize(first(oldChart,C,name)));
let preserved=0;for(const name of Object.keys(before.files)){if(before.files[name]!.dir||['ppt/slides/slide1.xml','ppt/slides/_rels/slide1.xml.rels','ppt/presentation.xml','[Content_Types].xml'].includes(name))continue;assert.deepEqual(await after.file(name)!.async('nodebuffer'),await before.file(name)!.async('nodebuffer'));preserved++;}
const workbookName=Object.keys(after.files).find(n=>/^ppt\/embeddings\/loam-chart-.*\.xlsx$/.test(n))!,book=new ExcelJS.Workbook();await book.xlsx.load(await after.file(workbookName)!.async('nodebuffer') as any);const sheet=book.worksheets[0]!;assert.equal(sheet.getCell('A2').value,'الربع الأول');assert.equal(sheet.getCell('B1').value,'النتيجة المعدّلة');assert.equal(sheet.getCell('B2').value,27.5);assert.equal(sheet.getCell('C5').value,92);
const oldBook=await safeZip(await before.file('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx')!.async('nodebuffer')),newBook=await safeZip(await after.file(workbookName)!.async('nodebuffer'));for(const name of Object.keys(oldBook.files)){if(oldBook.files[name]!.dir||name.startsWith('xl/worksheets/sheet'))continue;assert.deepEqual(await newBook.file(name)!.async('nodebuffer'),await oldBook.file(name)!.async('nodebuffer'));}
await fs.writeFile(out+'/original-chart-edited.pptx',output.buffer);await fs.writeFile(out+'/original-chart-native.png',await renderSlidePreview(output.buffer,1));
const reopened=await importStudio(await fs.mkdtemp(out+'/chart-reimport-'),output.buffer,'edited.pptx',0);assert.equal((reopened.content as any).slides[0].sourceCharts[0].series[0].values[0],27.5);
const bad=structuredClone(artifact);(bad.content as any).slides[0].sourceCharts[0].series[0].values[0]=NaN;assert.throws(()=>validateStudio(bad));await assert.rejects(()=>exportStudio(bad,work));
const resized=structuredClone(artifact);(resized.content as any).slides[0].sourceCharts[0].labels.push('extra');await assert.rejects(()=>exportStudio(resized,work));
const external=await safeZip(source),rels=await part(external,'ppt/charts/_rels/chart1.xml.rels');first(rels,'*','Relationship').setAttribute('TargetMode','External');first(rels,'*','Relationship').setAttribute('Target','https://example.test/data.xlsx');external.file('ppt/charts/_rels/chart1.xml.rels',serialize(rels));const externalBytes=await external.generateAsync({type:'nodebuffer'}),externalWork=await fs.mkdtemp(out+'/chart-external-'),unsupported=await importStudio(externalWork,externalBytes,'external.pptx',0);assert.equal((unsupported.content as any).slides[0].sourceCharts.length,0);assert.deepEqual((await exportStudio(unsupported,externalWork)).buffer,externalBytes);
await fs.writeFile(out+'/original-chart-result.json',JSON.stringify({cacheAndWorkbook:true,stylePreserved:true,reimport:true,externalPreserved:true,preservedParts:preserved},null,2));console.log('PASS original chart cache + embedded workbook editing, formatting preservation, reimport and unsupported external preservation');
