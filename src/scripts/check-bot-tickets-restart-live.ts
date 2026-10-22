import fs from 'node:fs';
import assert from 'node:assert/strict';
import { BackendSandbox } from '../agent/backendSandbox.js';
import { parseAppContract } from '../agent/appVerification.js';
import { runInstalledCase } from './installed-bot-case.js';

const previous = JSON.parse(fs.readFileSync('docs/evidence/bot-tickets-test-spec.json', 'utf8'));
const contract = structuredClone(previous.contract);
const scenario = structuredClone(contract.scenarios.find((s: {name:string}) => s.name === 'Update version'));
assert.ok(scenario);
scenario.name = 'Updated ticket survives two backend restarts';
scenario.steps.push({action:'restartBackend'}, {action:'textExact',selector:'.ticket[data-id="a"] [data-version]',value:'2'}, {action:'restartBackend'}, {action:'textExact',selector:'.ticket[data-id="a"] [data-title]',value:'محدثة'});
contract.scenarios.push(scenario);
const prompt = `أصلح التطبيق الحالي: يجب أن تبقى التذاكر وإصداراتها بعد إعادة تشغيل عملية الخادم. اختبار مستقل أثبت أن البيانات تختفي لأن التهيئة تحذف قاعدة البيانات عند الإقلاع. اجعل التهيئة غير مدمرة واحفظ كل وظائف التطبيق السابقة والواجهة العربية. لا تعدّل اختبارات السيناريوهات الستة السابقة؛ أضف السيناريو السابع وفق العقد التالي. استخدم أدوات الملفات فقط ولا تشغل الخادم على Windows. لا تدع بقاء البيانات بعد حذف الحاوية؛ المطلوب بقاء البيانات بعد إعادة تشغيل عملية الخادم داخل الحاوية نفسها.\nاحفظ app-verification.json بهذا العقد بالضبط:\n${JSON.stringify(contract)}`;
parseAppContract(JSON.stringify(contract));
async function probe(workspace: string) {
  const sandbox = await BackendSandbox.start(workspace,'server.mjs');
  try {
    const request = async (method:string, route:string, body?:unknown) => {
      const r=await sandbox.request(route,method,{'content-type':'application/json'},body===undefined?'':Buffer.from(JSON.stringify(body)).toString('base64'));
      return {status:r.status,json:JSON.parse(Buffer.from(r.body,'base64').toString())};
    };
    assert.equal((await request('POST','/api/tickets',{id:'persist',title:'before restart'})).status,201);
    assert.equal((await request('PATCH','/api/tickets/persist',{title:'persisted',status:'closed',version:1})).status,200);
    const first = await sandbox.restart();
    assert.deepEqual(await request('GET','/api/tickets'),{status:200,json:{items:[{id:'persist',title:'persisted',status:'closed',version:2}]}});
    assert.equal((await request('PATCH','/api/tickets/persist',{title:'stale',status:'open',version:1})).status,409);
    assert.equal((await request('PATCH','/api/tickets/persist',{title:'after restart',status:'open',version:2})).status,200);
    const second = await sandbox.restart();
    const rows=await sandbox.readSqlite({database:'/tmp/tickets.sqlite',table:'tickets',columns:['id','title','status','version'],rows:[]});
    assert.deepEqual(rows,[['persist','after restart','open',3]]);
    assert.deepEqual(await request('GET','/api/tickets'),{status:200,json:{items:[{id:'persist',title:'after restart',status:'open',version:3}]}});
    return {pass:true,restarts:[first,second],rows,scope:'application process restart within one ephemeral container; not container deletion'};
  } finally { await sandbox.close(); }
}
if(process.argv.includes('--dry-run')) {
  fs.writeFileSync('docs/evidence/bot-tickets-restart-spec.json',JSON.stringify({prompt,contract,status:'prepared'},null,2));
  console.log('PASS seven-scenario ticket restart specification');
} else {
  const caps=await(await fetch('http://127.0.0.1:3939/api/bot/capabilities')).json() as any;
  assert.ok(caps.revision>=10 && caps.applicationVerification.backendRuntime.processRestart);
  await runInstalledCase({title:'اختبار BOT — حفظ التذاكر بعد إعادة تشغيل الخادم',prompt,contract,taskId:'task_mvelv6se9c37881f3c13',output:'docs/evidence/bot-tickets-restart-live.json',probe});
}
