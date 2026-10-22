import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {BackendSandbox} from '../agent/backendSandbox.js';
import {parseAppContract} from '../agent/appVerification.js';
import {runInstalledCase} from './installed-bot-case.js';

const previous=JSON.parse(fs.readFileSync('docs/evidence/bot-tickets-fresh-full-gate-spec.json','utf8'));
const contract=structuredClone(previous.contract);
const updated=structuredClone(contract.scenarios.find((s:{name:string})=>s.name==='Update version'));
assert.ok(updated);updated.name='Filter updated tickets without changing their state';
updated.steps.push({action:'select',selector:'#filterStatus',value:'open'},{action:'count',selector:'.ticket',count:0},{action:'select',selector:'#filterStatus',value:'closed'},{action:'count',selector:'.ticket',count:1},{action:'textExact',selector:'.ticket[data-id="a"] [data-version]',value:'2'});
updated.expectedResponses=[{method:'GET',path:'/api/tickets?status=open',status:200,count:1},{method:'GET',path:'/api/tickets?status=closed',status:200,count:1}];
updated.apiChecks=[{requests:[{method:'GET',path:'/api/tickets?status=open',expectedJson:{items:[]}},{method:'GET',path:'/api/tickets?status=closed',expectedJson:{items:[{id:'a',title:'محدثة',status:'closed',version:2}]}}],statuses:[200,200]}];
contract.scenarios.push(updated);
contract.scenarios.push({name:'Reject invalid or duplicate status filter',steps:[{action:'visible',selector:'#filterStatus'}],apiChecks:[{requests:['?status=archived','?status=','?status=open&status=closed'].map(query=>({method:'GET',path:'/api/tickets'+query,expectedJson:{error:'invalid'}})),statuses:[400,400,400]}],sqliteChecks:[{database:'/tmp/tickets.sqlite',table:'tickets',columns:['id','title','status','version'],rows:[]}]});
parseAppContract(JSON.stringify(contract));
assert.deepEqual(contract.scenarios.slice(0,previous.contract.scenarios.length),previous.contract.scenarios);
const prompt=`طوّر تطبيق التذاكر الحالي بإضافة التصفية حسب الحالة دون كسر أي مطلب سابق أو تغيير صيغ JSON السابقة أو سلوك الإصدار والتزامن وحفظ SQLite بعد إعادة تشغيل الخادم. لا تستخدم localStorage أو مكتبات خارجية.
GET /api/tickets يبقى كما هو: كل السجلات مرتبة حسب id. أضف معامل status الاختياري بقيم all أو open أو closed؛ all أو غياب المعامل يعيدان جميع السجلات، وopen/closed يعيدان السجلات المطابقة فقط، بنفس {items:[{id,title,status,version}]} دون حقول إضافية. قيمة غير ذلك أو فارغة أو تكرار معامل status يرجع 400 {error:"invalid"} ولا يغيّر البيانات.
أضف عنصر select بمعرف #filterStatus وخيارات all/open/closed بعناوين عربية، والقيمة الافتراضية all. عند تغييره أرسل طلب GET واحدًا إلى /api/tickets?status=<القيمة> وحدّث الصفوف بالرد. تستمر الإنشاءات والتعديلات ورسائل الأخطاء كما كانت؛ لا تعدّل حالة أو إصدار سجل لمجرد تصفيته. احتفظ بالتدرجات السماوية والبنفسجية وRTL والتجاوب.
احفظ app-verification.json بالعقد التالي بالضبط: ${JSON.stringify(contract)}
السيناريوهات السبعة الأولى تبقى دون تغيير، والسيناريوهان الأخيران للإضافة الجديدة. استخدم أدوات الملفات فقط ولا تشغّل الخادم على Windows؛ الاختبار الفعلي تنفذه المنظومة داخل Docker.`;
async function probe(workspace:string){
 const sandbox=await BackendSandbox.start(workspace,'server.mjs');
 try{
  const request=async(method:string,route:string,body?:unknown)=>{
   const r=await sandbox.request(route,method,{'content-type':'application/json'},body===undefined?'':Buffer.from(JSON.stringify(body)).toString('base64'));
   return {status:r.status,json:JSON.parse(Buffer.from(r.body,'base64').toString())};
  };
  for(const id of ['c','a','b'])assert.equal((await request('POST','/api/tickets',{id,title:id})).status,201);
  for(const id of ['b','c'])assert.equal((await request('PATCH','/api/tickets/'+id,{title:id,status:'closed',version:1})).status,200);
  const items=[{id:'a',title:'a',status:'open',version:1},{id:'b',title:'b',status:'closed',version:2},{id:'c',title:'c',status:'closed',version:2}];
  for(const [query,expected] of [['',items],['?status=all',items],['?status=open',items.slice(0,1)],['?status=closed',items.slice(1)]] as const)assert.deepEqual(await request('GET','/api/tickets'+query),{status:200,json:{items:expected}});
  for(const query of ['?status=archived','?status=','?status=open&status=closed'])assert.deepEqual(await request('GET','/api/tickets'+query),{status:400,json:{error:'invalid'}});
  const restart=await sandbox.restart();
  assert.deepEqual(await request('GET','/api/tickets?status=closed'),{status:200,json:{items:items.slice(1)}});
  const rows=await sandbox.readSqlite({database:'/tmp/tickets.sqlite',table:'tickets',columns:['id','title','status','version'],rows:[]});
  rows.sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  assert.deepEqual(rows,[['a','a','open',1],['b','b','closed',2],['c','c','closed',2]]);
  return {pass:true,restart,rows,scope:'new filter plus preserved data/version after process restart'};
 }finally{await sandbox.close();}
}
if(process.argv.includes('--dry-run')){
 fs.writeFileSync('docs/evidence/bot-tickets-filter-continuation-spec.json',JSON.stringify({prompt,contract,status:'prepared; not executed'},null,2));
 console.log('PASS nine-scenario continuation contract parses; seven original scenarios preserved exactly');
}else{
 const taskId='task_mveumcvtdbf76a7e226c';
 const observe=process.argv.includes('--observe');
 const response=await fetch('http://127.0.0.1:3939/api/tasks/'+taskId);assert.ok(response.ok);
 const {task}=await response.json() as any;
 if(!observe){assert.equal(task.status,'done','Do not extend an incomplete initial task');assert.equal(task.messages.filter((m:any)=>m.role==='user').length,1,'Do not repeat a continuation or overwrite later user work');}
 const priorName=process.argv.find(arg=>arg.startsWith('--prior-evidence='))?.slice('--prior-evidence='.length)??'bot-installed-tickets-fresh-full-gate.json';
 assert.equal(path.basename(priorName),priorName,'Prior evidence must be a filename inside docs/evidence');
 assert.match(priorName,/^bot-installed-tickets-fresh-full-gate(?:-\d+)?\.json$/);
 const prior=JSON.parse(fs.readFileSync(path.join('docs/evidence',priorName),'utf8'));assert.equal(prior.pass,true);assert.equal(prior.taskId,taskId);
 assert.deepEqual(prior.contract,previous.contract,'Continuation must follow the unchanged baseline contract');
 console.log('Prior successful evidence: '+priorName+'; the original attempt retains its own result');
 await runInstalledCase({title:'اختبار BOT — تطوير تصفية التذاكر دون كسر الوظائف السابقة',prompt,contract,taskId,...(observe?{observeTaskId:taskId}:{}),output:'docs/evidence/bot-tickets-filter-continuation-live.json',probe});
}
