import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { extractFile } from '@electron/asar';
const expectedVersion=JSON.parse(await fs.readFile('package.json','utf8')).version;
const executable=path.resolve(process.argv[2]||'release/win-unpacked/Loam.exe');
const profile=process.env.LOAM_PACKAGED_PROFILE||await fs.mkdtemp(path.join(os.tmpdir(),'loam-packaged-'));
const env={...process.env,LOAM_USER_DATA_DIR:profile,LOAM_PORT:'13939',LOAM_MCP_BRIDGE_PORT:'13003',LOAM_AUTH_DISABLED:'true',AGENT_STUDIO_LEGACY_UI:'1',LOAM_ACCEPTANCE_DEBUG_PORT:'19222'};
delete env.ELECTRON_RUN_AS_NODE;delete env.LOAM_CONFIG;delete env.MANUS_LOCAL_CONFIG;delete env.LOAM_DATA_DIR;delete env.MANUS_LOCAL_DATA_DIR;delete env.AS_PROTOCOL_PORT;
let child;let browser;let diagnostics='';
try {
 child=spawn(executable,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>{diagnostics+=b.toString();});child.stderr.on('data',b=>{diagnostics+=b.toString();});
 const windowDeadline=Date.now()+90000;
 for(;;){try{const response=await fetch('http://127.0.0.1:19222/json/version',{signal:AbortSignal.timeout(1000)});if(response.ok)break;}catch{}if(Date.now()>windowDeadline)throw new Error('Chromium debugging endpoint not found');await new Promise(r=>setTimeout(r,200));}
 browser=await chromium.connectOverCDP('http://127.0.0.1:19222');
 let win;
 while(!win){win=browser.contexts().flatMap(c=>c.pages()).find(w=>w.url().startsWith('http://127.0.0.1:13939/'));if(Date.now()>windowDeadline)throw new Error('Main Loam window not found');if(!win)await new Promise(r=>setTimeout(r,200));}
 win.on('pageerror',error=>console.error('UI error:',error.message));
 await win.locator('.mode-card').first().waitFor({timeout:30000});
 assert.equal(await win.locator('.mode-card').count(),7);
 const identity=await (await fetch('http://127.0.0.1:13939/api/identity')).json();assert.equal(identity.application,'Loam');assert.equal(identity.version,expectedVersion);
 const dataPath=path.resolve(profile,'data');assert.equal(identity.profileId,createHash('sha256').update(process.platform==='win32'?dataPath.toLowerCase():dataPath).digest('hex'));
 const info=JSON.parse(extractFile(path.join(path.dirname(executable),'resources','app.asar'),'package.json').toString());assert.equal(info.name,'loam');assert.equal(info.version,expectedVersion);
 assert.ok(await win.evaluate(()=>!!window.loam));assert.doesNotMatch(await win.locator('body').innerText(),/manus|grok|frontier/i);
 await win.setViewportSize({width:1900,height:980});await win.evaluate(async()=>{await document.fonts.ready;});
 assert.equal(await win.locator('#sidebar').evaluate(el=>Math.round(el.getBoundingClientRect().width)),280);
 assert.equal(await win.locator('#modeCards').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),3);
 await win.screenshot({path:path.resolve('release/loam-packaged-home.png')});
 const services=await (await fetch('http://127.0.0.1:13939/api/mcp/status')).json();console.log('MCP health',JSON.stringify(services));const coreServices=services.servers.filter(s=>['filesystem','memory','sequential-thinking','memory-skills','loam-bridge'].includes(s.name));assert.ok(coreServices.length>=5);assert.ok(coreServices.every(s=>s.connected),JSON.stringify(services));
 const pty=await (await fetch('http://127.0.0.1:13939/api/pty/status')).json();assert.equal(pty.available,true);
 const post=async(url,body)=>{const r=await fetch('http://127.0.0.1:13939'+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.ok(r.ok,JSON.stringify(d));return d;};
 const {task}=await post('/api/tasks/draft',{title:'Packaged PTY test',mode:'build'});const session=await post('/api/pty',{taskId:task.id,shell:'cmd',cols:80,rows:24});await post(`/api/pty/${session.id}/input?taskId=${task.id}`,{data:'echo LOAM_PACKAGED>proof.txt\r'});
 const file=path.join(session.cwd,'proof.txt');const limit=Date.now()+10000;while(true){try{assert.equal((await fs.readFile(file,'utf8')).trim(),'LOAM_PACKAGED');break;}catch(error){if(Date.now()>limit)throw error;await new Promise(r=>setTimeout(r,100));}}
 await post(`/api/pty/${session.id}/input?taskId=${task.id}`,{data:'exit\r'});

 const {task:office}=await post('/api/tasks/draft',{title:'Loam live studio verification',mode:'write'});
 const examples=[{kind:'document',title:'خطة المشروع',content:{blocks:[{type:'heading',text:'من الفكرة إلى التنفيذ'},{type:'paragraph',text:'مساحة عمل مباشرة تجمع المحادثة والكتابة والتحرير في مكان واحد.'},{type:'bullet',text:'توليد المحتوى ومراجعته مع الحفاظ على تعديلاتك.'}]}},{kind:'presentation',title:'عرض المشروع',content:{slides:[{id:'intro',title:'من الفكرة إلى التنفيذ',body:'مساحة عمل مباشرة\nمحتوى قابل للتحرير\nملفات خاصة بكل مهمة',notes:'مقدمة العرض',background:'#101827',accent:'#12c8ec'}]}},{kind:'spreadsheet',title:'ميزانية المشروع',content:{sheets:[{name:'الميزانية',cells:[['البند','التكلفة'],['التصميم','1200'],['التطوير','2400'],['الإجمالي','=SUM(B2:B3)']]}]}}];
 let revision=0;
 for(const artifact of examples){const saved=await post('/api/studio',{taskId:office.id,artifact,expectedRevision:revision});revision=saved.artifact.revision;await win.goto('http://127.0.0.1:13939/#/tasks/'+office.id);await win.locator('.office-studio [data-kind="'+artifact.kind+'"][aria-pressed="true"]').waitFor();await win.locator('.office-studio [data-title]').filter({visible:true}).waitFor();await win.waitForFunction(title=>document.querySelector('.office-studio [data-title]').value===title,artifact.title);await win.screenshot({path:path.resolve('release/loam-packaged-studio-'+artifact.kind+'.png')});const output=await fetch('http://127.0.0.1:13939/api/studio/export?taskId='+office.id);assert.equal(output.status,200);const officeBytes=Buffer.from(await output.arrayBuffer());assert.equal(officeBytes.subarray(0,2).toString(),'PK');
 const {task:importTask}=await post('/api/tasks/draft',{title:'Imported '+artifact.kind,mode:'write'});await win.goto('http://127.0.0.1:13939/#/tasks/'+importTask.id);await win.waitForFunction(title=>document.querySelector('#chatTitle')?.textContent===title,'Imported '+artifact.kind);await win.locator('[data-import-file]').setInputFiles({name:'example.'+({document:'docx',presentation:'pptx',spreadsheet:'xlsx'}[artifact.kind]),mimeType:'application/octet-stream',buffer:officeBytes});await win.locator('.office-import-info').waitFor({timeout:20000}).catch(async error=>{console.error('IMPORT UI',await win.locator('.office-studio').innerText());await win.screenshot({path:path.resolve('release/import-failure.png')});throw error;});
 const loaded=await(await fetch('http://127.0.0.1:13939/api/studio?taskId='+importTask.id)).json();assert.ok(loaded.artifact.sourceId);assert.equal(loaded.artifact.kind,artifact.kind);
 const editor=win.locator(artifact.kind==='document'?'[data-block-text]':artifact.kind==='presentation'?'[data-textbox]':'[data-cell="1,1"]');await editor.first().fill(artifact.kind==='spreadsheet'?'999':'تعديل مباشر بعد الاستيراد');await win.locator('[data-action=save]').click();await win.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('تم الحفظ'));
 const savedImport=await(await fetch('http://127.0.0.1:13939/api/studio?taskId='+importTask.id)).json();assert.ok(JSON.stringify(savedImport.artifact).includes(artifact.kind==='spreadsheet'?'999':'تعديل مباشر بعد الاستيراد'));const exportedImport=await fetch('http://127.0.0.1:13939/api/studio/export?taskId='+importTask.id);assert.equal(exportedImport.status,200,await exportedImport.clone().text());assert.equal(Buffer.from(await exportedImport.arrayBuffer()).subarray(0,2).toString(),'PK');await win.screenshot({path:path.resolve('release/loam-import-'+artifact.kind+'.png')});
 }
 const integrations=await(await fetch('http://127.0.0.1:13939/api/integrations')).json();assert.ok(integrations.tools.some(t=>t.name.startsWith('mcp__')));assert.ok(integrations.tools.some(t=>t.name==='mirofish_chat'));
 await win.goto('http://127.0.0.1:13939/#/services/integrations');await win.frameLocator('#embedFrame').locator('.tool').first().waitFor();
 for(const [studio,selector] of [['mobile','#build-form'],['swarm','#brief-form'],['security','#task']]){await win.goto('http://127.0.0.1:13939/#/studios/'+studio);await win.frameLocator('#embedFrame').locator(selector).waitFor();}
 // Three's examples/jsm folder contains runtime code and must survive packaging.
 for(const module of ['controls/OrbitControls.js','controls/TransformControls.js','loaders/GLTFLoader.js','exporters/GLTFExporter.js'])assert.equal((await fetch('http://127.0.0.1:13939/vendor/three/addons/'+module)).status,200,module);
 await win.goto('http://127.0.0.1:13939/#/modes/media');await win.locator('[data-viewport] canvas').waitFor();assert.equal(await win.locator('[data-transform]').count(),3);
 await win.goto('http://127.0.0.1:13939/#/services');await win.locator('#serviceCards .service-card').first().waitFor();await win.screenshot({path:path.resolve('release/loam-packaged-services.png')});
 console.log('PASS packaged Electron: Loam identity/version, seven pages, preload, live MCP ping, actual native PTY, app-only screenshots.');
} catch(error){console.error(diagnostics.slice(-7000));throw error;}
finally {await browser?.close();if(child&&child.exitCode===null)await new Promise(resolve=>{const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});killer.once('exit',resolve);killer.once('error',resolve);});}
