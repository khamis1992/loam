import fs from 'node:fs';
import assert from 'node:assert/strict';
import {BackendSandbox} from '../agent/backendSandbox.js';
import {parseAppContract} from '../agent/appVerification.js';
import {runInstalledCase} from './installed-bot-case.js';

const previous=JSON.parse(fs.readFileSync('docs/evidence/bot-tickets-test-spec.json','utf8'));
assert.ok(previous.prompt.includes('احفظ عقد الاختبار التالي دون تغيير:'));
const contract=structuredClone(previous.contract);
const scenario=structuredClone(contract.scenarios.find((s:{name:string})=>s.name==='Update version'));
assert.ok(scenario);
scenario.name='Updated ticket survives two backend process restarts';
scenario.steps.push({action:'restartBackend'},{action:'textExact',selector:'.ticket[data-id="a"] [data-version]',value:'2'},{action:'restartBackend'},{action:'textExact',selector:'.ticket[data-id="a"] [data-title]',value:'محدثة'});
contract.scenarios.push(scenario);
parseAppContract(JSON.stringify(contract));
const requirements=previous.prompt.split('احفظ عقد الاختبار التالي دون تغيير:')[0].replace('يبدأ فارغًا.','عند إنشاء قاعدة جديدة تبدأ فارغة؛ لا تحذف بيانات موجودة عند الإقلاع.');
const prompt=`${requirements}
يجب أن تبقى التذاكر وعناوينها وحالتها وإصداراتها بعد إعادة تشغيل عملية الخادم داخل الحاوية نفسها، مع استمرار رفض الإصدار القديم بعد الاستئناف. تهيئة SQLite غير مدمرة: CREATE TABLE IF NOT EXISTS دون حذف قاعدة موجودة. لا تدع بقاء البيانات بعد حذف الحاوية.
احفظ app-verification.json بهذا العقد بالضبط: ${JSON.stringify(contract)}
استخدم أدوات الملفات فقط ولا تشغّل الخادم على Windows. تشغيل التطبيق وطلبات API والفحص البصري وفحص SQLite تتولاها المنظومة داخل Docker.`;

async function probe(workspace:string){
 const sandbox=await BackendSandbox.start(workspace,'server.mjs');
 try{
  const request=async(method:string,route:string,body?:unknown)=>{
   const r=await sandbox.request(route,method,{'content-type':'application/json'},body===undefined?'':Buffer.from(JSON.stringify(body)).toString('base64'));
   return {status:r.status,json:JSON.parse(Buffer.from(r.body,'base64').toString())};
  };
  const initial={id:'holdout',title:'first',status:'open',version:1};
  assert.deepEqual(await request('POST','/api/tickets',{id:'holdout',title:'  first  '}),{status:201,json:{item:initial}});
  assert.deepEqual(await request('POST','/api/tickets',{id:'holdout',title:'overwrite'}),{status:409,json:{error:'duplicate'}});
  const competing=await Promise.all(['alpha','beta'].map(title=>request('PATCH','/api/tickets/holdout',{title,status:'closed',version:1})));
  assert.deepEqual(competing.map(r=>r.status).sort(),[200,409]);
  const winner=competing.find(r=>r.status===200)!.json.item;
  assert.ok(['alpha','beta'].includes(winner.title));
  assert.deepEqual(winner,{id:'holdout',title:winner.title,status:'closed',version:2});
  assert.deepEqual(competing.find(r=>r.status===409)!.json,{error:'version_conflict'});
  const first=await sandbox.restart();
  assert.deepEqual(await request('GET','/api/tickets'),{status:200,json:{items:[winner]}});
  for(const version of [0,-1,1.5,'2',null,Number.MAX_SAFE_INTEGER+1])assert.deepEqual(await request('PATCH','/api/tickets/holdout',{title:'invalid',status:'open',version}),{status:400,json:{error:'invalid'}});
  assert.deepEqual(await request('PATCH','/api/tickets/holdout',{title:'stale',status:'open',version:1}),{status:409,json:{error:'version_conflict'}});
  const final={id:'holdout',title:'after restart',status:'open',version:3};
  assert.deepEqual(await request('PATCH','/api/tickets/holdout',{title:final.title,status:final.status,version:2}),{status:200,json:{item:final}});
  const second=await sandbox.restart();
  assert.deepEqual(await request('GET','/api/tickets'),{status:200,json:{items:[final]}});
  const rows=await sandbox.readSqlite({database:'/tmp/tickets.sqlite',table:'tickets',columns:['id','title','status','version'],rows:[]});
  assert.deepEqual(rows,[['holdout','after restart','open',3]]);
  return {pass:true,competing,restarts:[first,second],rows,scope:'two application process replacements inside one container; no host/container-deletion durability claim'};
 }finally{await sandbox.close();}
}
if(process.argv.includes('--dry-run')){
 fs.writeFileSync('docs/evidence/bot-tickets-fresh-full-gate-spec.json',JSON.stringify({prompt,contract,status:'prepared; supplied baseline plus runtime independent acceptance'},null,2));
 console.log('PASS fresh ticket persistence/concurrency contract parses');
}else if(process.argv.includes('--probe-archive')){
 console.log(JSON.stringify(await probe('output/verification/bot-tickets-restart-pass-20261019')));
}else{
 const observeTaskId=process.argv.find(arg=>arg.startsWith('--observe-task='))?.slice('--observe-task='.length);
 await runInstalledCase({title:'اختبار BOT — تذاكر متزامنة وحفظ بعد إعادة التشغيل',prompt,contract,output:'docs/evidence/bot-installed-tickets-fresh-full-gate.json',...(observeTaskId?{observeTaskId}:{}),probe});
}
