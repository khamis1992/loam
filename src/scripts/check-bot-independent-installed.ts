import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {BackendSandbox} from '../agent/backendSandbox.js';

const prompt=`أنشئ تطبيق عروض أسعار عربي RTL متجاوب بالتدرجات السماوية والبنفسجية، بخادم Node بوحداته المدمجة فقط على المنفذ 3000. يضيف المستخدم أصنافًا ويحذفها ويحدد سعر الوحدة بالسنت والكمية ونسبة الخصم ورسوم الشحن بالسنت، ثم يحسب الخادم المجاميع وتعرضها الواجهة بوضوح ورسائل خطأ مفهومة.
واجهة API المطلوبة POST /api/quote تستقبل {items:[{sku,unitPriceCents,quantity}],discountPercent,shippingCents}. الأصناف 1 إلى 100؛ sku نص غير فارغ بعد trim ولا يتكرر؛ unitPriceCents عدد صحيح آمن من 0 إلى 10000000؛ quantity عدد صحيح من 1 إلى 10000؛ discountPercent عدد صحيح من 0 إلى 100؛ shippingCents عدد صحيح من 0 إلى 1000000. لا تحول النصوص أو null إلى أرقام. مجموع الأسعار قبل الخصم يجب ألا يزيد عن 1000000000 سنت وإلا الطلب غير صالح.
احسب subtotalCents بجمع سعر الوحدة مضروبًا بالكمية. discountCents هو تقريب subtotalCents*discountPercent/100 إلى أقرب سنت والنصف للأعلى. totalCents=subtotalCents-discountCents+shippingCents. الرد الناجح 200 بكائن هذه الحقول الأربعة فقط: subtotalCents وdiscountCents وshippingCents وtotalCents. المدخلات المخالفة وJSON المعطوب ترجع 400 مع {error:"invalid"}. الرسوم لا تدخل في حساب الخصم. لا يلزم تخزين أو خدمات خارجية. نفّذ اختبار قبول مناسبًا من اختيارك في app-verification.json؛ لم أزودك بعقد اختبار جاهز. استخدم أدوات الملفات فقط ولا تشغّل الخادم على Windows.`;
const outputIndex=process.argv.indexOf('--output');
const outputName=outputIndex<0?'bot-independent-installed-quote.json':process.argv[outputIndex+1];
assert.ok(outputName && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(outputName),'--output must be a JSON filename inside docs/evidence');
const output=path.join('docs/evidence',outputName);
const observeIndex=process.argv.indexOf('--observe');
const observeTaskId=observeIndex<0?undefined:process.argv[observeIndex+1];
if(observeIndex>=0)assert.ok(observeTaskId && /^task_[a-zA-Z0-9]+$/.test(observeTaskId),'--observe requires an existing task ID');
if(process.argv.includes('--dry-run')){fs.writeFileSync('docs/evidence/bot-independent-quote-spec.json',JSON.stringify({prompt,status:'prepared; no acceptance contract supplied'},null,2));console.log('Prepared quote task without supplied acceptance contract');process.exit(0);}
const started=Date.now(),base='http://127.0.0.1:3939';
assert.ok(!fs.existsSync(output),'Preserve earlier evidence: select a new --output filename for each trial');
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
assert.ok(process.env.LOCALAPPDATA,'Installed Windows runtime location required');
const runtimePath=path.join(process.env.LOCALAPPDATA,'Programs/loam/resources/app/dist/server.cjs');
const evidence:Record<string,any>={startedAt:new Date().toISOString(),request:prompt,pass:false,events:[],provenance:{runtimePath,runtimeSha256:hash(fs.readFileSync(runtimePath)),promptSha256:hash(prompt),observerSha256:hash(fs.readFileSync(fileURLToPath(import.meta.url))),model:'glm-5.3-flash:cloud',operatorSourceEdits:false,costUsd:null}};
const save=()=>fs.writeFileSync(output,JSON.stringify({...evidence,elapsedMs:Date.now()-started},null,2));
const read=async(route:string)=>{const r=await fetch(base+route,{signal:AbortSignal.timeout(15000)});assert.ok(r.ok);return r.json() as Promise<any>;};
try{
 const queue=await read('/api/queue');if(!observeTaskId)assert.equal(queue.actives.length+queue.queued.length,0);
 evidence.capabilities=await read('/api/bot/capabilities');assert.ok(evidence.capabilities.revision>=11&&evidence.capabilities.acceptanceIntegrity.independentMandatoryForApplications);save();
 if(observeTaskId){
  evidence.taskId=observeTaskId;
  evidence.observationMode='reattached-to-persisted-task-events-after-interruption';
  evidence.streamingObservation='persisted events only; original live SSE timing is not observed';
  while(true){
   const task:any=(await read('/api/tasks/'+encodeURIComponent(observeTaskId))).task;
   assert.equal(task.prompt,prompt,'Do not mix another task into this evaluation');
   assert.equal(task.messages.filter((m:any)=>m.role==='user').length,1,'Multiple user turns require a separately scoped evaluator');
   evidence.events=task.steps.map((s:any)=>({...s.data,observedAt:s.at}));evidence.task=task;save();
   if(['done','error','cancelled','interrupted'].includes(task.status))break;
   if(Date.now()-started>=1800000)throw new Error('Observation timeout; inspect the existing task before resuming observation');
   await new Promise(resolve=>setTimeout(resolve,5000));
  }
 }else{
 const response=await fetch(base+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt,title:'اختبار BOT — قبول مستقل لعروض الأسعار',mode:'build',workMode:'loam',model:'glm-5.3-flash:cloud'}),signal:AbortSignal.timeout(1800000)});
 assert.ok(response.ok&&response.body);const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
 for(;;){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});let end:number;
  while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const line=block.split('\n').find(l=>l.startsWith('data: '));if(!line)continue;const e={...JSON.parse(line.slice(6)),observedAt:new Date().toISOString()};evidence.events.push(e);if(e.type==='task')evidence.taskId=e.taskId;if(['task','verify','revise','done','error'].includes(e.type)){save();console.log(JSON.stringify({type:e.type,taskId:e.taskId,verdict:e.verdict,message:e.message}));}}
 }
 }
 assert.ok(evidence.taskId);evidence.task=(await read('/api/tasks/'+encodeURIComponent(evidence.taskId))).task;save();assert.equal(evidence.task.status,'done');
 const events=evidence.events as any[];const baseline=events.findLastIndex(e=>e.type==='tool_result'&&e.name==='application_verification'&&e.ok);const independent=events.findLastIndex(e=>e.type==='tool_result'&&e.name==='independent_application_verification'&&e.ok);const final=events.findLastIndex(e=>e.type==='verify'&&e.verdict==='pass');
 assert.ok(baseline>=0&&independent>baseline&&final>independent);assert.ok(events.findIndex(e=>e.type==='assistant_message')>final&&events.findIndex(e=>e.type==='done')>final);assert.ok(!events.slice(0,final).some(e=>e.type==='assistant_token'));
 assert.ok(events.filter(e=>e.type==='tool_call').every(e=>['file_read','file_write','file_edit','file_stat','file_search','file_list','file_mkdir','file_view_image'].includes(e.name)));
 const reports=[];
 for(const index of [baseline,independent]){const reportPath=String(events[index].summary).match(/\nReport: (.+)$/)?.[1]?.trim();assert.ok(reportPath);const relative=path.relative(path.join(evidence.task.workspace,'.verification'),path.resolve(reportPath));assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));assert.ok(report.pass&&report.visual?.verdict?.verdict==='pass');assert.ok(report.checks.length>=2&&report.checks.every((c:any)=>c.pass));reports.push(report);}
 if(evidence.capabilities.applicationVerification.visualReviewCoverage?.allCapturedScreenshots){for(const report of reports){assert.equal(report.visual.complete,true);assert.deepEqual(report.visual.reviewedScreenshots,report.screenshots);}}
 assert.equal(reports[1].contractOrigin,'runtime-owned-independent');assert.ok(reports[1].executedContract.scenarios.length<=4);for(const [file,hash] of Object.entries(reports[0].sourceHashes))assert.equal(reports[1].sourceHashes[file],hash);evidence.reports=reports;save();
 const sandbox=await BackendSandbox.start(evidence.task.workspace,JSON.parse(fs.readFileSync(path.join(evidence.task.workspace,'app-verification.json'),'utf8')).runtime.entry);
 const observations:any[]=[];
 try{
  const quote=async(body:unknown,raw=false)=>{const r=await sandbox.request('/api/quote','POST',{'content-type':'application/json'},Buffer.from(raw?String(body):JSON.stringify(body)).toString('base64'));const observed={status:r.status,json:JSON.parse(Buffer.from(r.body,'base64').toString())};observations.push(observed);return observed;};
  const valid={items:[{sku:'one',unitPriceCents:199,quantity:3},{sku:'two',unitPriceCents:250,quantity:2}],discountPercent:15,shippingCents:99};
  assert.deepEqual(await quote(valid),{status:200,json:{subtotalCents:1097,discountCents:165,shippingCents:99,totalCents:1031}});
  assert.deepEqual(await quote({items:[{sku:'half',unitPriceCents:101,quantity:1}],discountPercent:50,shippingCents:0}),{status:200,json:{subtotalCents:101,discountCents:51,shippingCents:0,totalCents:50}});
  for(const invalid of [null,{}, {...valid,items:[]},{...valid,discountPercent:'15'},{...valid,shippingCents:null},{...valid,discountPercent:101},{...valid,items:[{sku:' ',unitPriceCents:1,quantity:1}]},{...valid,items:[{sku:'one',unitPriceCents:1,quantity:0}]},{...valid,items:[{sku:'one',unitPriceCents:1,quantity:1.5}]},{...valid,items:[{sku:'dup',unitPriceCents:1,quantity:1},{sku:'dup',unitPriceCents:1,quantity:1}]},{...valid,items:[{sku:'large',unitPriceCents:10000000,quantity:101}]}])assert.deepEqual(await quote(invalid),{status:400,json:{error:'invalid'}});
  assert.deepEqual(await quote('{broken',true),{status:400,json:{error:'invalid'}});assert.deepEqual(await quote(valid),{status:200,json:{subtotalCents:1097,discountCents:165,shippingCents:99,totalCents:1031}});
  evidence.independentProbe={pass:true,observations};
 }finally{await sandbox.close();}
 evidence.provenance.runtimeSha256After=hash(fs.readFileSync(runtimePath));
 assert.equal(evidence.provenance.runtimeSha256After,evidence.provenance.runtimeSha256,'Installed runtime changed during evaluation');
 evidence.pass=true;console.log('PASS installed task with no supplied contract, both acceptance gates and independent quote probe');
}catch(error){evidence.error=String(error);process.exitCode=1;console.error(String(error));}finally{save();}
