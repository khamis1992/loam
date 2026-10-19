import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import {Document,Packer,Paragraph,TextRun,Header,Footer,PageNumber,Table,TableRow,TableCell,ImageRun,WidthType} from 'docx';
import {importStudio} from '../studio/import.js';
import {exportStudio} from '../studio/export.js';
import {saveStudio,type DocumentBlock} from '../studio/store.js';
import {all,first,part,serialize,W,R,attr} from '../studio/ooxml.js';

const out='output/word-import-review';fs.mkdirSync(out,{recursive:true});
const logo=fs.readFileSync('electron/assets/loam.png');
const source=await Packer.toBuffer(new Document({styles:{default:{document:{run:{font:'Arial',size:24,color:'243A52'}}}},sections:[{
 properties:{page:{size:{width:11906,height:16838},margin:{top:1100,bottom:1100,left:1800,right:1800}}},
 headers:{default:new Header({children:[new Paragraph({children:[new TextRun({text:'القالب الأصلي | LOAM',color:'8C5365',bold:true})]})]})},
 footers:{default:new Footer({children:[new Paragraph({children:[new TextRun('المراجعة الأصلية — '),new TextRun({children:[PageNumber.CURRENT]})]})]})},
 children:[new Paragraph({alignment:'right',bidirectional:true,children:[new TextRun({text:'تقرير الفريق — القالب الأصلي',bold:true,boldComplexScript:true,size:36,sizeComplexScript:36,color:'8C5365'})]}),
 new Paragraph({alignment:'right',bidirectional:true,children:[new TextRun({text:'هذه الصفحة جزء من الملف المستورد. ',bold:true}),new TextRun({text:'يجب الحفاظ على ألوانها وخطوطها وجدولها وصورتها الأصلية.',italics:true})]}),
 new Table({width:{size:8306,type:WidthType.DXA},columnWidths:[4153,4153],rows:[new TableRow({children:['بند أصلي','تنسيق محفوظ'].map(text=>new TableCell({shading:{fill:'F6EAF0'},children:[new Paragraph(text)]}))})]}),
 new Paragraph({children:[new ImageRun({type:'png',data:logo,transformation:{width:100,height:100},altText:{name:'original',title:'الشعار الأصلي',description:'صورة أصلية يجب الحفاظ عليها'}})]}),
 new Paragraph({pageBreakBefore:true,alignment:'right',bidirectional:true,children:[new TextRun({text:'إضافات التقرير',bold:true,color:'8C5365'})]})]}]}));
fs.writeFileSync(path.join(out,'original-template.docx'),source);
const blocks:DocumentBlock[]=[
 {type:'stats',text:'بيانات توضيحية للاختبار',items:[{value:'92%',label:'الإنجاز',tone:'teal'},{value:'24',label:'المهام',tone:'blue'},{value:'3',label:'المراحل',tone:'amber'}]},
 {type:'table',text:'جدول متابعة جديد',columns:['المرحلة','المخرج','الحالة'],rows:[['التحليل','المتطلبات','مكتملة'],['التصميم','النموذج','مكتملة'],['التنفيذ','التجربة','جارية']]},
 {type:'image',text:'صورة جديدة مضمنة',alt:'شعار مضاف',src:'data:image/png;base64,'+logo.toString('base64')},
];
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-rich-import-'));
try{
 const artifact=await importStudio(root,source,'original-template.docx',0);if(artifact.kind!=='document')throw Error();
 artifact.content.blocks.push(...blocks);const saved=saveStudio(root,artifact,1);
 const result=await exportStudio(saved,root);fs.writeFileSync(path.join(out,'imported-rich-test.docx'),result.buffer);
 const before=await JSZip.loadAsync(source),after=await JSZip.loadAsync(result.buffer);
 for(const name of Object.keys(before.files).filter(n=>!before.files[n]!.dir&&!['word/document.xml','word/_rels/document.xml.rels','[Content_Types].xml'].includes(n)))assert.deepEqual(await after.file(name)!.async('nodebuffer'),await before.file(name)!.async('nodebuffer'),name+' must remain identical');
 const original=await part(before,'word/document.xml'),updated=await part(after,'word/document.xml');
 const oldBody=first(original,W,'body'),newBody=first(updated,W,'body');
 const oldNodes=Array.from(oldBody.childNodes as ArrayLike<any>).filter(n=>n.nodeType===1&&n.localName!=='sectPr');
 const newNodes=Array.from(newBody.childNodes as ArrayLike<any>).filter(n=>n.nodeType===1&&n.localName!=='sectPr');
 oldNodes.forEach((node,i)=>assert.equal(serialize(newNodes[i]),serialize(node),'Original body unchanged'));
 assert.equal(serialize(first(updated,W,'sectPr')),serialize(first(original,W,'sectPr')));
 assert.equal(all(updated,W,'tbl').length,3);
 const ids=all(updated,'*','docPr').map(n=>attr(n,'id'));assert.equal(new Set(ids).size,ids.length);
 const rels=await part(after,'word/_rels/document.xml.rels');
 for(const node of all(updated,'*','blip')){const id=node.getAttributeNS(R,'embed');const rel=all(rels,'*','Relationship').find(r=>attr(r,'Id')===id);assert.ok(rel);assert.ok(after.file('word/'+attr(rel,'Target')));}
 for(const table of all(updated,W,'tbl').slice(1))assert.equal(attr(first(table,W,'tblW'),'w:w'),'8306');
 // Re-export from the original template must not accumulate duplicate additions.
 const again=await JSZip.loadAsync((await exportStudio(saved,root)).buffer);assert.equal(all(await part(again,'word/document.xml'),W,'tbl').length,3);
 const reimportRoot=path.join(root,'reimport');fs.mkdirSync(reimportRoot);const reimport=await importStudio(reimportRoot,result.buffer,'again.docx',0);assert.ok((await exportStudio(reimport,reimportRoot)).buffer.equals(result.buffer));
 console.log('PASS imported rich additions: original body/sections/styles/headers/footer/media preserved, narrow width, unique drawing IDs, valid image relationships, repeat export/reimport.');
}finally{fs.rmSync(root,{recursive:true,force:true});}
