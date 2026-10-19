import assert from 'node:assert/strict';
import { createTaskModel, applyTaskEvent } from '../../ui/task-view.js';

const stamp = '2026-10-17T12:00:00Z';
const events = [
  {type:'plan', steps:[{id:'s1', title:'كتابة التقرير', success_criteria:'حفظ تقرير قابل للقراءة'}]},
  {type:'plan_step', id:'s1', phase:'start'},
  {type:'tool_call', name:'file_write', args:{path:'report.md'}},
  {type:'tool_result', name:'file_write', ok:true, summary:'saved'},
  {type:'plan_step', id:'s1', phase:'done'},
  {type:'critique', id:'s1', verdict:'pass', reason:'تم فحص التقرير'},
  {type:'assistant_message', text:'تم إعداد التقرير.\n\n'+'نص طويل للاختبار '.repeat(30)},
  {type:'verify', verdict:'pass', reason:'الملف موجود ويحتوي النتيجة'},
  {type:'done'},
];
const task = {id:'fixture', title:'إعداد تقرير العمل', status:'done', createdAt:stamp, updatedAt:stamp, messages:[{role:'user',content:'أعد تقريرًا مختصرًا',at:stamp}], steps:events.map(data=>({at:stamp,data}))};
const model = createTaskModel(task);
assert.equal(model.plan[0].phase,'pass');
assert.deepEqual([...model.files],['report.md']);
applyTaskEvent(model,{type:'error', message:'temporary'});
assert.equal(model.status,'done', 'warnings must not change persisted completion');
const next = createTaskModel({...task,status:'running',messages:[...task.messages,{role:'user',content:'طلب جديد',at:'2026-10-17T13:00:00Z'}]});
assert.equal(next.result,''); assert.equal(next.verification,null); assert.equal(next.files.size,0);
applyTaskEvent(next,{type:'tool_call',name:'file_write',args:{path:'failed.md'}});
applyTaskEvent(next,{type:'tool_result',name:'file_write',ok:false});
assert.equal(next.files.size,0);
applyTaskEvent(next,{type:'verification_progress',stage:'independent_application'});
assert.equal(next.verificationProgress,'independent_application');
assert.equal(next.verification,null,'progress is not a successful verdict');
assert.equal(next.status,'running');
for (const type of ['verify','error','cancelled','done']) {
  applyTaskEvent(next,{type:'verification_progress',stage:'final_review'});
  applyTaskEvent(next,{type,verdict:'revise'});
  assert.equal(next.verificationProgress,null);
}

console.log('PASS task view model: latest-turn isolation, verified steps, successful file outputs');
