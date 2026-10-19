import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Document,Packer,Paragraph,TextRun,Textbox,Table,TableRow,TableCell,Header,Footer,WidthType} from 'docx';
import sharp from 'sharp';
import JSZip from 'jszip';
import {importStudio} from '../studio/import.js';
import {exportStudio} from '../studio/export.js';
import {validateStudio} from '../studio/store.js';
import {safeZip,part,all,first,attr,W,A,R} from '../studio/ooxml.js';
import {children} from '../studio/word-import.js';

const out='output/word-special-regions';await fs.mkdir(out,{recursive:true});
const p=(text:string,bold=false)=>new Paragraph({children:[new TextRun({text,font:'Arial',size:22,bold})]});
const headerText='LOAM SPECIAL REGIONS REVIEW';
const footerText='Page footer · تذييل الصفحة';
const boxText='مربع نص قابل للتحرير';
const source=await Packer.toBuffer(new Document({
 sections:[{headers:{default:new Header({children:[p(headerText),p('Second header line')]})},footers:{default:new Footer({children:[p(footerText)]})},children:[
  p('Body paragraph before the table.'),
  new Table({width:{size:6000,type:WidthType.DXA},rows:[
   new TableRow({children:['Alpha','Beta','Gamma'].map(t=>new TableCell({children:[p(t)]}))}),
   new TableRow({children:['One','Two','Three'].map(t=>new TableCell({children:[p(t)]}))}),
  ]}),
  new Paragraph({children:[new TextRun('Text box host paragraph '),new Textbox({children:[new Paragraph({children:[new TextRun(boxText)]})],style:{size:{width:2400,height:700},position:{x:100,y:100}} as any})]}),
 ]}],
}));
await fs.writeFile(out+'/special-source.docx',source);
const work=await fs.mkdtemp(out+'/model-');
const artifact=await importStudio(work,source,'special.docx',0);
if(artifact.kind!=='document')throw Error('expected document');
const regions=artifact.content.regions!;
assert.ok(regions.some(r=>r.kind==='header'&&r.text===headerText+'\nSecond header line'),'header region captured with both paragraphs');
assert.ok(regions.some(r=>r.kind==='footer'&&r.text===footerText),'footer region captured');
assert.ok(regions.some(r=>r.kind==='textbox'&&r.text===boxText),'text box region captured with its body node');

// Unchanged artifact round-trips byte-identically.
assert.ok((await exportStudio(artifact,work)).buffer.equals(source),'no-op export must keep the original bytes');

// Editing header/footer/text-box text patches only those parts, preserving structure.
const edited=structuredClone(artifact);
const header=edited.content.regions!.find(r=>r.kind==='header')!;
header.text=headerText+' — تعديل الرأس\nSecond header line';
const textbox=edited.content.regions!.find(r=>r.kind==='textbox')!;
textbox.text='مربع نص بعد التعديل';
const editedOutput=await exportStudio(edited,work);
const editedZip=await safeZip(editedOutput.buffer);
const headerPart=await part(editedZip,String(header.part));
assert.ok(all(headerPart,W,'p').length===2,'header paragraphs are patched in place');
assert.ok(all(headerPart,W,'t').map(t=>t.textContent).join('').includes('تعديل الرأس'));
const bodyDoc=await part(editedZip,'word/document.xml');
assert.ok(all(bodyDoc,W,'t').some(t=>t.textContent.includes('مربع نص بعد التعديل')),'text box patched in the body');
assert.ok(all(bodyDoc,W,'t').some(t=>t.textContent==='Body paragraph before the table.'),'untouched body text stays');
// Re-exporting the same edited artifact appends nothing new and keeps the patched text.
const again=await exportStudio(edited,work);
assert.ok(all(await part(await safeZip(again.buffer),'word/document.xml'),W,'t').some(t=>t.textContent.includes('مربع نص بعد التعديل')));
assert.equal(all(await part(await safeZip(again.buffer),String(header.part)),W,'p').length,2,'repeated export stays structural');

// Removing or reshaping regions is rejected to protect the original structure.
const removed=structuredClone(edited);removed.content.regions=removed.content.regions!.slice(0,1);
await assert.rejects(()=>exportStudio(removed,work),/Keep (every|the original) header/);
const reshaped=structuredClone(edited);reshaped.content.regions![0]!.kind='textbox' as any;
assert.throws(()=>validateStudio(reshaped),/regions need/,'reshaped regions are rejected before export');

// An image inserted into a cell becomes a drawing inside that cell with its own media part.
const png=`data:image/png;base64,${(await sharp({create:{width:56,height:28,channels:3,background:'#2a8868'}}).png().toBuffer()).toString('base64')}`;
const withImage=structuredClone(edited);
const table=withImage.content.blocks.find(b=>b.type==='table')!;
(table as any).cellImages=[{row:0,column:1,src:png,alt:'Cell marker'}];
const imageOutput=await exportStudio(withImage,work);
const imageZip=await safeZip(imageOutput.buffer);
const imageDoc=await part(imageZip,'word/document.xml');
const tableNode=children(first(imageDoc,W,'body')).find(n=>n.localName==='tbl')!;
const cell=children(children(tableNode,'tr')[1]!,'tc')[1]!;
const blips=all(cell,A,'blip');
assert.equal(blips.length,1,'exactly one image drawing inside the target cell');
const embed=blips[0]!.getAttributeNS(R,'embed');
const rels=await part(imageZip,'word/_rels/document.xml.rels');
const rel=all(rels,'*','Relationship').find(n=>attr(n,'Id')===embed)!;
assert.match(attr(rel,'Target'),/^media\/loam-[\w.-]+\.png$/);
assert.ok(Object.keys(imageZip.files).some(name=>/^word\/media\/loam-[\w.-]+\.png$/.test(name)),'new media part created');
assert.ok((await imageZip.file('[Content_Types].xml')!.async('string')).includes('/word/media/loam-'),'content type override added');
// Re-export stays idempotent: still exactly one drawing in the target cell.
const twice=await exportStudio(withImage,work);
assert.equal(all(children(children(children(first(await part(await safeZip(twice.buffer),'word/document.xml'),W,'body')).find(n=>n.localName==='tbl')!,'tr')[1]!,'tc')[1]!,A,'blip').length,1,'no duplicate cell image on repeated export');

// Validation guards for cell images.
const badPosition=structuredClone(withImage);(badPosition.content.blocks.find(b=>b.type==='table')! as any).cellImages=[{row:9,column:0,src:png,alt:''}];
assert.throws(()=>validateStudio(badPosition),/inside the table grid/);
const badSource=structuredClone(withImage);(badSource.content.blocks.find(b=>b.type==='table')! as any).cellImages=[{row:0,column:0,src:'data:image/png;base64,AAAA',alt:''}];
assert.throws(()=>validateStudio(badSource),/embedded PNG or JPEG|cell image signature/);
const tooMany=structuredClone(withImage);(tooMany.content.blocks.find(b=>b.type==='table')! as any).cellImages=[0,1,2,3,4].map(i=>({row:0,column:i%3,src:png,alt:''}));
assert.throws(()=>validateStudio(tooMany),/at most 4 items/);

await fs.writeFile(out+'/special-edited.docx',imageOutput.buffer);
await fs.writeFile(out+'/artifact.json',JSON.stringify(withImage,null,2));
console.log('PASS special regions import, header/footer/textbox patching with preserved structure, cell image insertion with media/rel/content-type, idempotent re-export, region protection, validation guards');
