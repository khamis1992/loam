import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import { OllamaClient } from '../ollama.js';
import { authorIndependentAcceptance, IndependentAcceptanceGuard } from '../agent/independentAcceptance.js';
import { verifyApplication } from '../agent/appVerification.js';

const cfg=loadConfig();
cfg.workspace=fs.mkdtempSync(path.join(os.tmpdir(),'loam-independent-live-'));
cfg.model='glm-5.3-flash:cloud'; cfg.orchestrator.verifierModel=cfg.model; cfg.vision.model=cfg.model;
const ollama=new OllamaClient(cfg.ollamaUrl);
const request='أنشئ عدادًا عربيًا يبدأ بصفر. كل ضغطة على زر إضافة تزيد العدد بواحد بالضبط، وبعد ضغطتين يجب أن يعرض 2. لا تطلب حفظ العدد بعد تحديث الصفحة.';
const baseline={entry:'index.html',scenarios:[{name:'Visible heading',steps:[{action:'visible',selector:'h1'}]}]};
const html='<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:22px sans-serif;background:#eef6ff;color:#163050;margin:30px}main{max-width:500px;margin:auto;padding:30px;border-radius:20px;background:white}button{font:inherit;background:#6954df;color:white;padding:12px 30px;border:0;border-radius:10px}output{display:block;font-size:48px;margin:30px}</style><main><h1>العداد</h1><button id="add">إضافة</button><output id="count">0</output></main><script>let n=0;add.onclick=()=>count.textContent=(n+=2)</script></html>';
fs.writeFileSync(path.join(cfg.workspace,'index.html'),html);
fs.writeFileSync(path.join(cfg.workspace,'app-verification.json'),JSON.stringify(baseline));
const evidence:Record<string,unknown>={at:new Date().toISOString(),workspace:cfg.workspace,request,pass:false,scope:'Real-model independent test author and visual reviewer, controlled static fixture; not an installed autonomous task'};
const save=()=>fs.writeFileSync('docs/evidence/bot-independent-acceptance-live.json',JSON.stringify(evidence,null,2));
save();
try {
  const authored=await authorIndependentAcceptance({cfg,ollama,request}); evidence.authored=authored; save();
  const guard=new IndependentAcceptanceGuard(request); guard.freeze(authored);
  const bad=await verifyApplication({cfg,ollama,request,independentContract:guard.get()!.contract}); evidence.bad=bad; save();
  assert.equal(bad.pass,false,'independent author must catch two-per-click implementation despite visible title');
  assert.ok(bad.checks.some(c=>!c.pass),'must fail executable behavior, not merely a model opinion');
  fs.writeFileSync(path.join(cfg.workspace,'index.html'),html.replace('(n+=2)','(++n)'));
  const good=await verifyApplication({cfg,ollama,request,independentContract:guard.get()!.contract}); evidence.good=good; save();
  assert.equal(good.pass,true,good.reason);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg.workspace,'app-verification.json'),'utf8')),baseline);
  evidence.pass=true; console.log('PASS real independent author catches bug from user semantics; same frozen tests accept correction with actual visual review');
} catch(error) {evidence.error=String(error); throw error;} finally {save();}
