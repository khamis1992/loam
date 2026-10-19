import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const base='http://127.0.0.1:3939',out='output/word-original-edit';
const identity=await (await fetch(base+'/api/identity')).json();assert.equal(identity.version,'0.5.9');
const r=await fetch(base+'/api/tasks/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'write',title:'تحرير عناصر Word الأصلية — اختبار 0.5.9'})});const {task}=await r.json();
const response=await fetch(base+'/api/studio/import?taskId='+task.id+'&name=original-rich.docx&expectedRevision=0',{method:'POST',headers:{'content-type':'application/octet-stream'},body:await fs.readFile(out+'/source.docx')});assert.ok(response.ok,await response.clone().text());
const {artifact}=await response.json();await fs.writeFile(out+'/installed-task.json',JSON.stringify({taskId:task.id,version:identity.version,artifact},null,2));console.log(JSON.stringify({taskId:task.id,blocks:artifact.content.blocks.map((b,i)=>({i,type:b.type,sourceNode:b.sourceNode,text:b.text.slice(0,50)}))},null,2));
