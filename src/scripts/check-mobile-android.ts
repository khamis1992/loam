/** Lifecycle safety checks in a disposable workspace. --cancel exercises the real local compiler process. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import JSZip from 'jszip';
import {saveMobile} from '../mobile/store.js';
import {androidFiles} from '../mobile/android/generate.js';
import {androidBuildStatus,androidArtifact,startAndroidBuild,cancelAndroidBuild} from '../mobile/android/build.js';
import {createRorkTools} from '../tools/rork.js';
import {PreviewService} from '../preview/serve.js';
import {loadConfig} from '../config.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-android-test-'));
const project=saveMobile(root,{version:1,title:'@عربي "&<\\ اختبار',accent:'#267965',direction:'rtl',screens:[{id:'home',title:'الرئيسية',kind:'primary',blocks:[{id:'note',type:'input',text:'ملاحظة'},{id:'save',type:'button',text:'حفظ'}]}]},0);
const generated=androidFiles(project,'stable-task');
assert.equal(androidFiles(project,'stable-task').applicationId,generated.applicationId);
assert.notEqual(androidFiles(project,'other-task').applicationId,generated.applicationId);
assert.deepEqual(JSON.parse(generated.files['app/src/main/assets/project.json']!),project);
assert.match(generated.files['app/src/main/res/values/strings.xml']!,/>"@عربي/);
assert.match(generated.files['app/src/main/res/values/strings.xml']!,/&amp;&lt;/);
assert.doesNotMatch(generated.files['app/src/main/java/app/loam/generated/MainActivity.kt']!,/WebView/);
assert.equal(androidBuildStatus(root).build,null);
assert.throws(()=>androidBuildStatus(root,'../outside'));
await assert.rejects(startAndroidBuild(root,'stable-task',0),/تغيّر المشروع/);
const id=randomUUID(),dir=path.join(root,'.loam/android/builds',id);fs.mkdirSync(path.join(dir,'source'),{recursive:true});
const job={id,status:'building',revision:1,applicationId:generated.applicationId,sourceHash:generated.sourceHash,startedAt:new Date().toISOString(),files:['project.json']};
const write=()=>fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(job));write();
assert.equal(androidBuildStatus(root,id).build?.status,'interrupted');
await assert.rejects(androidArtifact(root,id,'apk'),/لم يكتمل/);
fs.writeFileSync(path.join(dir,'source/project.json'),JSON.stringify(project));
const zip=await JSZip.loadAsync(await androidArtifact(root,id,'source'));assert.deepEqual(JSON.parse(await zip.file('project.json')!.async('string')),project);assert.equal(zip.file('local.properties'),null);
const bytes=Buffer.from('fixture artifact integrity only');fs.writeFileSync(path.join(dir,'app-debug.apk'),bytes);
Object.assign(job,{status:'succeeded',apk:{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}});write();assert.deepEqual(await androidArtifact(root,id,'apk'),bytes);
fs.appendFileSync(path.join(dir,'app-debug.apk'),'tampered');await assert.rejects(androidArtifact(root,id,'apk'),/تغيّر ملف/);
const preview=new PreviewService(),legacy=createRorkTools(preview),ctx={workspace:root,taskId:'task_test',cfg:loadConfig(),emit:()=>{}};
try{
 const exported=await legacy[0]!.run({action:'export'},ctx);assert.equal(exported.ok,true,exported.content);const result=JSON.parse(exported.content);assert.equal(result.compiled,false);assert.equal(result.expUrl,undefined);
 const artifact=await JSZip.loadAsync(fs.readFileSync(result.sourceArchive));assert.equal(JSON.parse(await artifact.file('mobile.json')!.async('string')).title,project.title);assert.ok(artifact.file('android/app/src/main/java/app/loam/generated/MainActivity.kt'));
 const unsupported=await legacy[1]!.run({sourceDir:'.'},ctx);assert.equal(unsupported.ok,false);assert.match(unsupported.content,/mobile.json/);
}finally{preview.stop();}
if(process.argv.includes('--cancel')){
 const running=await startAndroidBuild(root,'stable-task',1);
 await assert.rejects(startAndroidBuild(root,'stable-task',1),/بناء Android جار/);
 assert.throws(()=>cancelAndroidBuild(root,randomUUID()));
 const launched=Date.now()+20000;while(Date.now()<launched&&!/Daemon will be stopped|> Task/.test(androidBuildStatus(root,running.id).log))await new Promise(r=>setTimeout(r,200));
 assert.equal(androidBuildStatus(root,running.id).build?.status,'building');
 cancelAndroidBuild(root,running.id);
 const end=Date.now()+30000;let state='building';while(Date.now()<end){state=androidBuildStatus(root,running.id).build!.status;if(state!=='building')break;await new Promise(r=>setTimeout(r,200));}
 assert.equal(state,'cancelled');await assert.rejects(androidArtifact(root,running.id,'apk'),/لم يكتمل/);
}
console.log(JSON.stringify({ok:true,root,checks:['stable identity','literal source assets','Android resource escaping','revision conflict','interrupted state','unfinished APK denied','source export','APK integrity',...(process.argv.includes('--cancel')?['real process cancellation','concurrent build rejection']:[])]}));
