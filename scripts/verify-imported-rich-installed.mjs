import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
const base='http://127.0.0.1:3939',out='output/word-import-review';
async function json(p,b){const r=await fetch(base+p,b?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}:{});if(!r.ok)throw Error(await r.text());return r.json();}
const identity=await json('/api/identity'),settings=await json('/api/settings');assert.equal(identity.version,'0.5.8');assert.equal(settings.model,'glm-5.3-flash:cloud');
const {task}=await json('/api/tasks/draft',{title:'Word المستورد — مراجعة الإضافات',mode:'write'});
const original=await fs.readFile(out+'/original-template.docx');
const importedResponse=await fetch(base+'/api/studio/import?taskId='+task.id+'&name=original-template.docx&expectedRevision=0',{method:'POST',headers:{'content-type':'application/octet-stream'},body:original});if(!importedResponse.ok)throw Error(await importedResponse.text());const {artifact:imported}=await importedResponse.json();
const imageResponse=await fetch(base+'/api/upload?taskId='+task.id+'&name=loam.png',{method:'POST',headers:{'content-type':'application/octet-stream'},body:await fs.readFile('electron/assets/loam.png')});if(!imageResponse.ok)throw Error(await imageResponse.text());const image=await imageResponse.json();
await fs.writeFile(out+'/installed-task.json',JSON.stringify({taskId:task.id,version:identity.version,model:settings.model,sourceId:imported.sourceId},null,2));
console.log('Testing installed import with GLM: '+task.id);
const prompt=`الاستوديو يحتوي ملف Word مستوردًا. حافظ على جميع فقراته وsourceIndex وتنسيقه. اقرأ loam_studio ثم append فقط بالـ expectedRevision الصحيح: أضف مجموعة stats بثلاث بطاقات (92% الإنجاز teal، 24 المهام blue، 3 المراحل amber) وتعليق يوضح أن الأرقام توضيحية؛ ثم table بثلاثة أعمدة المرحلة والمخرج والحالة وثلاثة صفوف قصيرة؛ ثم image path="${image.path}" وalt وتعليق قصير. لا تضف sourceIndex للعناصر الجديدة. لا تستخدم أدوات أخرى أو بحثًا ولا تعِد إنشاء الملف الأصلي. جميعها بيانات اختبار. أكمل العناصر الثلاثة داخل المستند ثم أكد الإنجاز باختصار.`;
const chat=await fetch(base+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId:task.id,mode:'write',prompt,attachments:[]})});if(!chat.ok)throw Error(await chat.text());await fs.writeFile(out+'/generation.log',await chat.text());
const {artifact}=await json('/api/studio?taskId='+task.id);assert.equal(artifact.sourceId,imported.sourceId);assert.deepEqual(artifact.content.blocks.slice(0,imported.content.blocks.length),imported.content.blocks);for(const type of ['stats','table','image'])assert.equal(artifact.content.blocks.filter(b=>b.type===type).length,1,'Expected exactly one '+type);
const response=await fetch(base+'/api/studio/export?taskId='+task.id);if(!response.ok)throw Error(await response.text());const result=Buffer.from(await response.arrayBuffer());await fs.writeFile(out+'/loam-imported-rich-final.docx',result);
const before=await JSZip.loadAsync(original),after=await JSZip.loadAsync(result);const preserved=[];
const parser=new DOMParser(),serializer=new XMLSerializer(),w='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const originalDoc=parser.parseFromString(await before.file('word/document.xml').async('string'),'application/xml'),updatedDoc=parser.parseFromString(await after.file('word/document.xml').async('string'),'application/xml');
const children=doc=>Array.from(doc.getElementsByTagNameNS(w,'body')[0].childNodes).filter(n=>n.nodeType===1&&n.localName!=='sectPr');
children(originalDoc).forEach((node,i)=>assert.equal(serializer.serializeToString(children(updatedDoc)[i]),serializer.serializeToString(node)));
assert.equal(serializer.serializeToString(updatedDoc.getElementsByTagNameNS(w,'sectPr')[0]),serializer.serializeToString(originalDoc.getElementsByTagNameNS(w,'sectPr')[0]));
for(const name of Object.keys(before.files).filter(n=>!before.files[n].dir&&!['word/document.xml','word/_rels/document.xml.rels','[Content_Types].xml'].includes(n))){assert.deepEqual(await before.file(name).async('nodebuffer'),await after.file(name).async('nodebuffer'),name);preserved.push(name);}
await fs.writeFile(out+'/installed-verification.json',JSON.stringify({version:identity.version,model:settings.model,taskId:task.id,sourceId:artifact.sourceId,revision:artifact.revision,originalBlocksUnchanged:true,preservedParts:preserved,addedTypes:artifact.content.blocks.slice(imported.content.blocks.length).map(b=>b.type)},null,2));
console.log('PASS installed import → GLM append → DOCX. Original blocks and supporting parts unchanged. '+task.id);
