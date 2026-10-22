/** Install a verified local-model artifact into the local studio and export native source. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {androidFiles} from '../mobile/android/generate.js';
import {validateProject} from '../mobile/store.js';
const domain=process.argv[2];assert.ok(domain==='library'||domain==='bookings');
assert.ok(!process.argv[3]||process.argv[3]==='--audited');
const out=path.resolve('release/mobile-live/domains',process.argv[3]?'rule-audit':'.'),file=path.join(out,domain+'-live.json');
const proof=JSON.parse(fs.readFileSync(path.join(out,domain+'-rules-proof.json'),'utf8'));
const raw=JSON.parse(fs.readFileSync(path.join(out,domain+'.json'),'utf8'));validateProject(raw);
assert.deepEqual(raw.collections,proof.schemas,'Only publish the schema that passed domain acceptance');
const base='http://127.0.0.1:3941';
const post=async(url:string,body:unknown)=>{const r=await fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data:any=await r.json();if(!r.ok)throw Error(JSON.stringify(data));return data;};
let info=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):undefined;
if(!info){const {task}=await post('/api/tasks/draft',{mode:'build',title:raw.title+' · اختبار قواعد العمل'});info={taskId:task.id};fs.writeFileSync(file,JSON.stringify(info,null,2));}
if(!info.revision){const saved=await post('/api/mobile',{taskId:info.taskId,project:raw,expectedRevision:0});info.revision=saved.project.revision;fs.writeFileSync(file,JSON.stringify(info,null,2));}
const response=await fetch(base+'/api/mobile?taskId='+encodeURIComponent(info.taskId));assert.ok(response.ok);
const {project}=await response.json() as {project:typeof raw};
assert.deepEqual(validateProject(project),validateProject(raw),'Existing studio project differs: preserve it and create a separately named proof');
const generated=androidFiles(project,info.taskId),root=path.join(out,domain+'-android');
for(const [name,content]of Object.entries(generated.files)){const dest=path.join(root,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,content);}
fs.writeFileSync(path.join(root,'local.properties'),'sdk.dir='+path.join(process.env.LOCALAPPDATA!,'Android/Sdk').replaceAll('\\','/')+'\n');
// Acceptance assets are test-only and do not enter the application APK.
const testAssets=path.join(root,'app/src/androidTest/assets');fs.mkdirSync(testAssets,{recursive:true});
fs.copyFileSync(path.join(out,domain+'-native-cases.json'),path.join(testAssets,'domain-contract.json'));
fs.copyFileSync('src/scripts/fixtures/MobileDomainContractTest.kt',path.join(root,'app/src/androidTest/java/app/loam/generated/MobileDomainContractTest.kt'));
info={...info,root,applicationId:generated.applicationId,sourceHash:generated.sourceHash,url:base+'/?mobileTask='+info.taskId+'&mobileScreen='+project.screens[0].id+'#/studios/mobile'};
fs.writeFileSync(file,JSON.stringify(info,null,2));console.log(JSON.stringify(info,null,2));
