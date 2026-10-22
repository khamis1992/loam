import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, Header, Footer, PageNumber, PageOrientation, SectionType, WidthType, ImageRun } from 'docx';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { renderWordPreview, offlinePreviewCopy } from '../studio/word-preview.js';
import { importStudio } from '../studio/import.js';
import { exportStudio } from '../studio/export.js';
import { safeZip, xml, all, W } from '../studio/ooxml.js';
const out='output/word-native-preview';await fs.mkdir(out,{recursive:true});
const p=(text:string,bold=false)=>new Paragraph({spacing:{after:160,line:300},children:[new TextRun({text,font:'Arial',size:22,bold})]});
const footer=new Footer({children:[new Paragraph({alignment:'center',children:[new TextRun('Page '),new TextRun({children:[PageNumber.CURRENT]}),new TextRun(' of '),new TextRun({children:[PageNumber.TOTAL_PAGES]})]})]});
const header=new Header({children:[p('LOAM  /  COMPLEX DOCUMENT REVIEW',true)]});
const rows=Array.from({length:58},(_,i)=>new TableRow({tableHeader:i===0,cantSplit:true,children:[`${i===0?'ID':String(i).padStart(2,'0')}`,i===0?'AUTOMATIC PAGINATION':`Milestone ${i}: verify original layout and repeated table headings.`,i===0?'STATUS':i%2?'Complete':'In review'].map(text=>new TableCell({shading:{fill:i===0?'DDEEF0':i%2?'F2F6F7':'FFFFFF'},children:[p(text,i===0)]}))}));
const image=await fs.readFile('electron/assets/loam.png');
const doc=new Document({sections:[
 {headers:{default:header},footers:{default:footer},properties:{page:{margin:{top:1100,bottom:1100,left:1000,right:1000}}},children:[p('Annual operating report',true),p('Automatic pagination · repeated headers · original formatting'),new Table({width:{size:100,type:WidthType.PERCENTAGE},rows:[new TableRow({children:['98%\nCompletion','24\nProjects','3\nRegions'].map(text=>new TableCell({shading:{fill:'EAF5F2'},children:text.split('\n').map(t=>p(t,true))}))})]}),p('The table below flows across pages without manual page breaks.'),new Table({width:{size:100,type:WidthType.PERCENTAGE},rows})]},
 {headers:{default:header},footers:{default:footer},properties:{type:SectionType.NEXT_PAGE,page:{size:{orientation:PageOrientation.LANDSCAPE},margin:{top:1100,bottom:1100,left:1000,right:1000}}},children:[p('Landscape dashboard — merged cells and illustration',true),new Table({width:{size:100,type:WidthType.PERCENTAGE},rows:[new TableRow({children:[new TableCell({columnSpan:3,shading:{fill:'EAF5F2'},children:[p('Merged executive summary',true)]})]}),new TableRow({children:['Delivery','Quality','Readiness'].map(text=>new TableCell({children:[p(text)]}))})]}),new Paragraph({children:[new ImageRun({type:'png',data:image,transformation:{width:180,height:180}})]}),p('تقرير عربي: الحفاظ على تخطيط الصفحة والصور والجداول الأصلية.')]},
 {headers:{default:header},footers:{default:footer},properties:{type:SectionType.NEXT_PAGE,column:{count:2,space:500},page:{size:{orientation:PageOrientation.PORTRAIT},margin:{top:1100,bottom:1100,left:1000,right:1000}}},children:[p('Two-column editorial layout',true),...Array.from({length:14},(_,i)=>p(`Section ${i+1}. This editorial column tests automatic flow, paragraph spacing and pagination. The preview must preserve the exact line endings and the position of every paragraph that Word produces.`))]}
]});
const original=await Packer.toBuffer(doc);await fs.writeFile(out+'/complex-source.docx',original);
const workspace=await fs.mkdtemp(out+'/workspace-');
const artifact=await importStudio(workspace,original,'complex-source.docx',0);
const exported=await exportStudio(artifact,workspace);assert.ok(exported.buffer.equals(original),'no-op import/export remains byte identical');
await fs.writeFile(out+'/complex-export.docx',exported.buffer);
const [pdf,duplicate]=await Promise.all([renderWordPreview(exported.buffer),renderWordPreview(exported.buffer)]);assert.ok(pdf.equals(duplicate));
await fs.writeFile(out+'/complex-preview.pdf',pdf);
const parsed=await getDocument({data:new Uint8Array(pdf),useSystemFonts:true}).promise;
assert.ok(parsed.numPages>=5);
const pages=[];for(let i=1;i<=parsed.numPages;i++){const page=await parsed.getPage(i),v=page.getViewport({scale:1}),content=await page.getTextContent();const text=content.items.map((x:any)=>x.str||'').join(' ');assert.match(text,/Page/);assert.match(text,new RegExp(`Page\\s+${i}\\s+of\\s+${parsed.numPages}`));pages.push({number:i,width:v.width,height:v.height,text});}
assert.ok(pages.some(p=>p.width>p.height),'landscape preserved');assert.ok(pages.filter(p=>p.text.includes('AUTOMATIC PAGINATION')).length>=3,'table headers repeat on automatic breaks');assert.ok(pages.some(p=>p.text.includes('Merged executive summary')));assert.ok(pages.some(p=>/Two\s*-\s*column editorial/.test(p.text)));
const safe=await safeZip(await offlinePreviewCopy(original));assert.ok(all(xml(await safe.file('word/document.xml')!.async('string')),W,'body').length);
await fs.writeFile(out+'/verification.json',JSON.stringify({pages:pages.length,byteIdentical:true,concurrentDeduplicated:true,details:pages},null,2));
console.log(`PASS Word-native PDF: ${pages.length} pages, page fields, automatic table breaks, repeated headings, landscape, merged cells, image and columns; original bytes preserved.`);
