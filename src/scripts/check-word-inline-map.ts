import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {importStudio} from '../studio/import.js';
import {exportStudio} from '../studio/export.js';
import {interactiveWordCopy} from '../studio/word-preview-links.js';
import {renderWordPreview} from '../studio/word-preview.js';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {safeZip,part,all,first,textOf,W,attr} from '../studio/ooxml.js';
const out='output/word-inline-preview';await fs.mkdir(out,{recursive:true});const work=await fs.mkdtemp(out+'/workspace-');const buffer=await fs.readFile('output/word-native-preview/complex-source.docx');const artifact=await importStudio(work,buffer,'complex.docx',0);if(artifact.kind!=='document')throw Error();
const tagged=await interactiveWordCopy(buffer,artifact);const pdf=await renderWordPreview(tagged);await fs.writeFile(out+'/interactive.pdf',pdf);await fs.writeFile(out+'/artifact.json',JSON.stringify(artifact));const doc=await getDocument({data:new Uint8Array(pdf)}).promise;
const reference=await getDocument({data:new Uint8Array(await renderWordPreview(buffer))}).promise;assert.equal(doc.numPages,reference.numPages);const targets=new Set<string>();
for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i),original=await reference.getPage(i);const mapped=(await page.getTextContent()).items.map((x:any)=>[x.str,x.transform]),baseline=(await original.getTextContent()).items.map((x:any)=>[x.str,x.transform]);assert.deepEqual(mapped,baseline,'Interactive overlays must not move any text');for(const a of await page.getAnnotations())if(a.url)targets.add(a.url);}
for(const target of ['0/text','2/stat/0/value','4/cell/23/2','8/image','24/text'])assert.ok(targets.has('https://loam.invalid/edit/'+target),target);
assert.ok((await exportStudio(artifact,work)).buffer.equals(buffer),'No preview markup leaks into export');
const modified=structuredClone(artifact);modified.content.blocks.splice(6,0,{type:'stats',text:'',items:[{value:'100',label:'Landscape inserted card',tone:'teal'}]});modified.content.blocks.push({type:'stats',text:'',items:[{value:'200',label:'Column inserted card',tone:'blue'}]});const edited=await exportStudio(modified,work),zip=await safeZip(edited.buffer),xml=await part(zip,'word/document.xml'),tables=all(xml,W,'tbl');const width=(label:string)=>Number(attr(first(tables.find(t=>textOf(t,W).includes(label)),W,'tblW'),'w:w'));
assert.ok(width('Landscape inserted card')>width('Column inserted card')*2,'Inserted elements must respect their containing section width');
await fs.writeFile(out+'/mapping-verification.json',JSON.stringify({pages:doc.numPages,targets:targets.size,allTextPositionsIdentical:true,originalExportUnchanged:true,landscapeWidth:width('Landscape inserted card'),columnWidth:width('Column inserted card')},null,2));
console.log('PASS precise PDF targets, image/card/cell mapping, identical Word text positions, unchanged export, section-aware insertion widths');
