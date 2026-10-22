import {tools,more} from './mobile-builder-test.js';
/** Real server and browser integration; deterministic model fixture, not a model-quality evaluation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chromium, type Browser } from 'playwright';
import JSZip from 'jszip';
import { transform } from 'esbuild';
import { checkManyPages } from './check-mobile-many.js';
import { checkWorkbench } from './check-mobile-workbench.js';
import {checkMobileIDE} from './check-mobile-ide.js';
import {checkMobileUnifiedServices} from './check-mobile-unified-services.js';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'loam-mobile-test-')),workspace=path.join(tmp,'workspace');fs.mkdirSync(workspace);
const project={version:1,title:'دفتر القراءة',accent:'#267965',direction:'rtl',screens:[{id:'home',title:'الكتب',blocks:[{id:'heading',type:'heading',text:'كتب هذا الأسبوع'},{id:'name',type:'input',text:'اسم الكتاب'},{id:'done',type:'toggle',text:'اكتملت القراءة'},{id:'go',type:'button',text:'الملاحظات',target:'notes'}]},{id:'notes',title:'ملاحظاتي',blocks:[{id:'note',type:'input',text:'الملاحظة'},{id:'save',type:'button',text:'احفظ الملاحظة'}]}]};
let calls=0, expectedRevision=0, studioCalls=0;
const model=http.createServer(async(req,res)=>{if(req.url==='/api/tags'){res.end(JSON.stringify({models:[{name:'fixture'}]}));return;}let raw='';for await(const c of req)raw+=c;const messages=JSON.parse(raw).messages;const system=messages[0]?.content||'';let content='',tool_calls:unknown[]=[];
if(system.startsWith('RULE SUPPORT AUDIT')){content=JSON.stringify({decisions:JSON.parse(messages[1].content).candidateRules.map((r:any)=>({collectionId:r.collectionId,ruleId:r.rule.id,keep:false,quote:null,reason:'الأسماء المتكررة مسموحة'}))});}
else if(system.includes('DATA CONTRACT')){const draft=JSON.parse(messages[1].content);const removedRules=draft.collections.flatMap((c:any)=>(c.rules||[]).map((r:any)=>({collectionId:c.id,ruleId:r.id,reason:'السماح بالأسماء المتكررة حسب الطلب'})));const collections=draft.collections.map((c:any)=>({...c,rules:[],fields:c.fields.map((f:any)=>f.type==='number'?{required:false,min:null,max:null,integer:false,...f}:{required:false,...f})}));content=JSON.stringify({collections,removedRules,ruleEvidence:[]});}
else if(system.includes('Loam Mobile Studio')){studioCalls++;content=JSON.stringify(studioCalls===1?{...project,screens:[{id:'bad',title:'bad',blocks:[{id:'bad',type:'text',text:'duplicate'}]}]}:project);}
else if(system.includes('ONE mobile app block'))content=JSON.stringify({text:'عنوان محسّن بالنموذج'});
else if(system.includes('planner role'))content=JSON.stringify({goal:'Create mobile app',trivial:false,steps:[{id:'create',title:'Create app',instruction:'Use loam_mobile',success_criteria:'project saved'}]});
else if(system.includes('ONE executed plan step')||system.includes('COMPLETED task as a whole'))content=JSON.stringify({verdict:'pass',reason:'Saved'});
else if(messages.at(-1)?.role==='tool')content='Created mobile project';
else{calls++;tool_calls=[{function:{name:'loam_mobile',arguments:{action:'replace',expectedRevision,project}}}];}
res.setHeader('content-type','application/x-ndjson');res.end(JSON.stringify({model:'fixture',message:{role:'assistant',content,tool_calls},done:true})+'\n');});
model.listen(0,'127.0.0.1');await once(model,'listening');const modelPort=(model.address() as import('node:net').AddressInfo).port;
const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=(probe.address() as import('node:net').AddressInfo).port;await new Promise<void>(r=>probe.close(()=>r()));const base=`http://127.0.0.1:${port}`;
const config=path.join(tmp,'config.json');fs.writeFileSync(config,JSON.stringify({model:'fixture',fallbackModel:'fixture',ollamaUrl:`http://127.0.0.1:${modelPort}`,workspace,computerUse:{enabled:false,screenshotDir:path.join(tmp,'screenshots')},memory:{enabled:false},screen:{enabled:false},selfImprove:{enabled:false},mcpServers:{}}));
let child:ChildProcess|undefined,browser:Browser|undefined,logs='';
async function start(){child=spawn(process.execPath,process.argv.includes('--bundle')?['dist/server.cjs']:['--import','tsx','src/index.ts'],{cwd:process.cwd(),windowsHide:true,env:{...process.env,MANUS_LOCAL_CONFIG:config,MANUS_LOCAL_DATA_DIR:path.join(tmp,'data'),MANUS_LOCAL_PORT:String(port),MANUS_LOCAL_EVALS_DIR:path.join(tmp,'evals'),MANUS_LOCAL_SKILLS_DIR:path.join(tmp,'skills')},stdio:['ignore','pipe','pipe']});child.stdout?.on('data',c=>logs+=c);child.stderr?.on('data',c=>logs+=c);const until=Date.now()+30000;while(Date.now()<until){if(await fetch(base+'/api/tasks').then(r=>r.ok).catch(()=>false))return;await new Promise(r=>setTimeout(r,100));}throw Error(logs);}
async function stop(){if(child&&child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}}
const post=(url:string,body:unknown,headers={})=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
const draft=async(mode='build')=>((await(await post('/api/tasks/draft',{mode})).json()) as {task:{id:string}}).task.id;
try{
 await start();const first=await draft(),second=await draft(),denied=await draft('ask');
 assert.equal((await fetch(base+'/api/mobile')).status,400);
 const environment=await(await fetch(base+'/api/mobile/android/environment')).json() as Record<string,unknown>;assert.ok(Array.isArray(environment.checks));assert.equal(environment.java,undefined);assert.equal(environment.sdk,undefined);
 assert.equal((await fetch(base+'/api/mobile/android/build?taskId='+first)).status,405);
 assert.equal((await post('/api/mobile/android/build',{taskId:first,expectedRevision:0},{origin:'https://evil.example'})).status,403);
 assert.equal((await post('/api/mobile/android/build',{taskId:denied,expectedRevision:0})).status,403);
 assert.equal((await post('/api/mobile/android/build',{taskId:first,expectedRevision:99})).status,409);
 assert.equal((await fetch(base+'/api/mobile/android/artifact?taskId='+first+'&buildId=../escape&kind=apk')).status,400);
 assert.equal((await fetch(base+'/api/mobile/android/artifact?taskId='+second+'&buildId=00000000-0000-0000-0000-000000000000&kind=apk')).status,404);
 assert.equal(((await(await fetch(base+'/api/mobile/android?taskId='+first)).json()) as {build:unknown}).build,null);
 assert.equal((await post('/api/mobile',{taskId:denied,project,expectedRevision:0})).status,403);
 assert.equal((await post('/api/mobile',{taskId:first,project,expectedRevision:0},{origin:'https://evil.example'})).status,403);
 const chat=await post('/api/chat',{taskId:first,mode:'build',prompt:'Create mobile project with loam_mobile',attachments:[]});const chatResult=await chat.text();assert.equal(calls,1,chatResult);
 const read=async(id:string)=>((await(await fetch(base+'/api/mobile?taskId='+id)).json()) as {project:typeof project&{revision:number}}).project;
 assert.equal((await read(first)).title,project.title);assert.equal(await read(second),null);
 assert.equal((await post('/api/mobile',{taskId:first,project,expectedRevision:0})).status,409);
 const duplicate=await post('/api/mobile',{taskId:first,expectedRevision:1,project:{...project,screens:[{id:'home',title:'x',blocks:[{id:'home',type:'input',text:'duplicate'}]}]}});
 assert.equal(duplicate.status,400);assert.match(await duplicate.text(),/Duplicate ID/);assert.equal((await read(first)).revision,1);
 for(const bad of [{...project,accent:'red; color:red'},{...project,screens:[]},{...project,screens:[{id:'home',title:'x',blocks:[{id:'b',type:'button',text:'go',target:'missing'}]}]}])assert.equal((await post('/api/mobile',{taskId:first,project:bad,expectedRevision:1})).status,400);
 const zip=await JSZip.loadAsync(await(await fetch(base+'/api/mobile/export?taskId='+first)).arrayBuffer());
 assert.ok(zip.file('index.html'));assert.ok(zip.file('expo/App.js'));assert.ok(zip.file('expo/package.json'));
 assert.ok(zip.file('android/app/src/main/java/app/loam/generated/MainActivity.kt'));assert.ok(zip.file('android/loam-build.json'));assert.equal(zip.file('android/local.properties'),null);
 await transform(await zip.file('expo/App.js')!.async('string'),{loader:'jsx'});
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1600,height:1100}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/mobile.html?taskId='+first);await page.waitForFunction("document.querySelector('#status')?.textContent?.includes('استعادة')");
 const frame=page.frameLocator('#preview');await frame.getByLabel('اسم الكتاب').fill('كتاب حقيقي');await frame.getByLabel('اكتملت القراءة').check();await frame.getByRole('button',{name:'الملاحظات',exact:true}).click();await frame.getByLabel('الملاحظة').fill('فكرة جديدة');await frame.getByRole('button',{name:'احفظ الملاحظة'}).click();await frame.locator('output').filter({hasText:'تم حفظ'}).waitFor();
 await page.reload();await frame.getByLabel('الملاحظة').waitFor();assert.equal(await frame.getByLabel('الملاحظة').inputValue(),'فكرة جديدة');await frame.locator('nav button').filter({hasText:'الكتب'}).click();assert.equal(await frame.getByLabel('اسم الكتاب').inputValue(),'كتاب حقيقي');assert.equal(await frame.getByLabel('اكتملت القراءة').isChecked(),true);
 await page.locator('#title').fill('مشروع محفوظ');await page.locator('#save').click();await page.waitForFunction("document.querySelector('#status')?.textContent === 'محفوظ على الجهاز'");assert.equal((await read(first)).title,'مشروع محفوظ');
 await post('/api/mobile',{taskId:first,project:{...project,title:'Remote edit'},expectedRevision:2});await page.locator('#title').fill('Local conflict');await page.locator('#save').click();await page.locator('#notice').waitFor();assert.equal(await page.locator('#title').inputValue(),'Local conflict');assert.equal((await read(first)).title,'Remote edit');
 page.on('dialog',d=>d.accept());await tools(page,true);await page.getByText('الهوية والإعدادات',{exact:true}).click();await page.locator('#reload').click();await page.waitForFunction("document.querySelector('#title')?.value === 'Remote edit'");
 await tools(page,false);await page.locator('#select-mode').click();await frame.getByRole('button',{name:'تعديل: كتب هذا الأسبوع',exact:true}).click();await page.locator('#element-text').fill('قراءة ملهمة');
 await frame.locator('h2').filter({hasText:'قراءة ملهمة'}).waitFor();await tools(page,false);await page.locator('#undo').click();await frame.locator('h2').filter({hasText:'كتب هذا الأسبوع'}).waitFor();await more(page,'redo');await frame.locator('h2').filter({hasText:'قراءة ملهمة'}).waitFor();
 await page.locator('#save').click();await page.waitForFunction("document.querySelector('#status')?.textContent === 'محفوظ على الجهاز'");await page.reload();await page.locator('#undo').click();await frame.locator('h2').filter({hasText:'كتب هذا الأسبوع'}).waitFor();await more(page,'redo');await frame.locator('h2').filter({hasText:'قراءة ملهمة'}).waitFor();
 for(const width of [1600,768,320]){await page.setViewportSize({width,height:1000});assert.equal(await page.locator('html').evaluate(n=>n.scrollWidth>n.clientWidth+1),false,'overflow '+width);}
 await page.setViewportSize({width:1600,height:1100});fs.mkdirSync('release',{recursive:true});await page.screenshot({path:'release/loam-mobile-studio.png',fullPage:true});
 await page.goto(base+'/#/studios/mobile');const studio=page.frameLocator('#embedFrame');await studio.locator('#build-form').waitFor();
 await studio.locator('#new').click();expectedRevision=1;await studio.locator('#brief').fill('أنشئ تطبيق دفتر القراءة مع شاشات الكتب والملاحظات');await studio.locator('#build').click();
 await studio.locator('#status').filter({hasText:'اكتمل البناء'}).waitFor({timeout:30000}).catch(async error=>{console.error('Studio failure',await studio.locator('#status').innerText(),await studio.locator('#log').innerText(),await studio.locator('#notice').textContent());throw error;});assert.equal(studioCalls,2);assert.equal(await studio.locator('#screen-list [data-screen-id]').count(),2);assert.match(await studio.locator('#log').textContent()||'',/Duplicate ID/);
 await studio.locator('#select-mode').click();const built=studio.frameLocator('#preview');await built.getByRole('button',{name:'تعديل: كتب هذا الأسبوع',exact:true}).click();await tools(studio,false);await studio.locator('#brief').fill('حسّن عنوان هذا العنصر فقط');await studio.locator('#build').click();await studio.locator('#result').filter({hasText:'تم تحسين العنصر المحدد'}).waitFor();assert.equal(await built.locator('h2').innerText(),'عنوان محسّن بالنموذج');assert.equal(await studio.locator('#screen-list [data-screen-id]').count(),2);
 await studio.locator('#undo').click();await built.locator('h2').filter({hasText:'كتب هذا الأسبوع'}).waitFor();await more(studio,'redo');await built.locator('h2').filter({hasText:'عنوان محسّن بالنموذج'}).waitFor();
 await checkManyPages(browser,base);
 await checkWorkbench(browser,base);
 const ideProof=await checkMobileIDE(browser,base);
 await checkMobileUnifiedServices(browser,base);
 const dataTask=await draft();await post('/api/mobile',{taskId:dataTask,expectedRevision:0,project});await page.goto(base+'/mobile.html?taskId='+dataTask);await tools(page,true);await page.locator('#data-open').click();await page.locator('#data-add').click();await page.getByLabel('اسم المجموعة',{exact:true}).fill('الأفكار');await page.getByLabel('اسم السجل المفرد',{exact:true}).fill('فكرة');await page.locator('#data-apply').click();await page.locator('#save').click();await page.locator('#status').filter({hasText:'محفوظ على الجهاز'}).waitFor();
 const dataFrame=page.frameLocator('#preview');await dataFrame.getByRole('button',{name:'إضافة فكرة',exact:true}).click();await dataFrame.getByLabel('الاسم',{exact:true}).fill('فكرة من محرر البيانات');await dataFrame.getByRole('button',{name:'حفظ فكرة',exact:true}).click();await dataFrame.getByRole('heading',{name:'فكرة من محرر البيانات',exact:true}).waitFor();
 await page.locator('#undo').click();await dataFrame.getByRole('button',{name:'إضافة فكرة',exact:true}).waitFor({state:'hidden'});await more(page,'redo');await dataFrame.getByRole('heading',{name:'فكرة من محرر البيانات',exact:true}).waitFor();await page.reload();await dataFrame.getByRole('heading',{name:'فكرة من محرر البيانات',exact:true}).waitFor();
 await tools(page,true);await page.locator('#data-open').click();await page.getByRole('button',{name:'إضافة منع تكرار',exact:true}).click();await page.getByLabel('رسالة توضيح الخطأ',{exact:true}).fill('اسم الفكرة موجود بالفعل');await page.locator('#data-add-field').click();let numeric=page.locator('#data-fields>fieldset').last();await numeric.getByLabel('اسم الحقل',{exact:true}).fill('درجة الفكرة');await numeric.getByLabel('نوع البيانات',{exact:true}).selectOption('number');numeric=page.locator('#data-fields>fieldset').last();await numeric.getByLabel('أقل قيمة',{exact:true}).fill('0');await numeric.getByLabel('أكبر قيمة',{exact:true}).fill('5');await numeric.getByLabel('أعداد صحيحة فقط',{exact:true}).check();await page.locator('#data-apply').click();await page.locator('#save').click();await page.locator('#status').filter({hasText:'محفوظ على الجهاز'}).waitFor();
 await dataFrame.getByRole('button',{name:'إضافة فكرة',exact:true}).click();await dataFrame.getByLabel('الاسم',{exact:true}).fill('فكرة من محرر البيانات');await dataFrame.getByLabel('درجة الفكرة',{exact:true}).fill('3');await dataFrame.getByRole('button',{name:'حفظ فكرة',exact:true}).click();await dataFrame.getByText('اسم الفكرة موجود بالفعل',{exact:true}).waitFor();await dataFrame.getByLabel('الاسم',{exact:true}).fill('فكرة جديدة');await dataFrame.getByLabel('درجة الفكرة',{exact:true}).fill('6');await dataFrame.getByRole('button',{name:'حفظ فكرة',exact:true}).click();await dataFrame.getByText('أكبر قيمة مسموحة: 5',{exact:true}).waitFor();await dataFrame.getByLabel('درجة الفكرة',{exact:true}).fill('2.5');await dataFrame.getByRole('button',{name:'حفظ فكرة',exact:true}).click();await dataFrame.getByText('أدخل عددًا صحيحًا',{exact:true}).waitFor();await dataFrame.getByLabel('درجة الفكرة',{exact:true}).fill('3');await dataFrame.getByRole('button',{name:'حفظ فكرة',exact:true}).click();await dataFrame.getByRole('heading',{name:'فكرة جديدة',exact:true}).waitFor();await page.reload();await dataFrame.getByRole('heading',{name:'فكرة جديدة',exact:true}).waitFor();
 await page.locator('#brief').fill('اسمح بأسماء الأفكار المتكررة واحتفظ بحدود درجة الفكرة من صفر إلى خمسة والأعداد الصحيحة.');await tools(page,true);await page.locator('#review-data').click();await page.locator('#result').filter({hasText:'تمت مراجعة قواعد البيانات'}).waitFor();assert.match(await page.locator('#log').textContent()||'',/السماح بالأسماء المتكررة/);
 await dataFrame.getByRole('button',{name:'إضافة فكرة',exact:true}).click();await dataFrame.getByLabel('الاسم',{exact:true}).fill('فكرة جديدة');await dataFrame.getByLabel('درجة الفكرة',{exact:true}).fill('4');await dataFrame.getByRole('button',{name:'حفظ فكرة',exact:true}).click();await dataFrame.getByRole('heading',{name:'فكرة جديدة',exact:true}).nth(1).waitFor();
 await page.locator('#undo').click();await page.locator('#status').filter({hasText:'النسخة السابقة'}).waitFor();await dataFrame.getByRole('button',{name:'إضافة فكرة',exact:true}).click();await dataFrame.getByLabel('الاسم',{exact:true}).fill('فكرة جديدة');await dataFrame.getByLabel('درجة الفكرة',{exact:true}).fill('4');await dataFrame.getByRole('button',{name:'حفظ فكرة',exact:true}).click();await dataFrame.getByText('اسم الفكرة موجود بالفعل',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);await stop();await start();assert.equal((await read(first)).title,'Remote edit');
 const persistedVersions=await(await fetch(base+'/api/mobile/versions?taskId='+ideProof.taskId)).json() as {versions:{id:string;bookmarked:boolean}[]};assert.equal(persistedVersions.versions.find(v=>v.id===ideProof.bookmarkedId)?.bookmarked,true);
 const persistedReleases=await(await fetch(base+'/api/mobile/releases?taskId='+ideProof.taskId)).json() as {active:string};assert.equal(persistedReleases.active,ideProof.releaseId);
 console.log('PASS mobile: live tool execution, HTTP validation, isolation, revisions/conflicts, persistence after restart, web navigation/form storage, Expo source syntax, integrated route, responsive layout');
}finally{await browser?.close();await stop();model.closeAllConnections();await new Promise<void>(r=>model.close(()=>r()));/* Keep failed-test evidence in the uniquely created temp directory. */console.log('Test workspace:',tmp);}


