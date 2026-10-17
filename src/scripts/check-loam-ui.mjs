import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { LOAM_MODES } from '../modes/catalog.ts';
const stamp='2026-10-17T12:00:00Z';
const tasks=new Map(); const uploads=new Map(); const requests=[]; const posts=[];let count=0;
function addTask(id,mode='write',status='done') { const task={id,mode,status,title:'تقرير المهمة '+id,createdAt:stamp,updatedAt:stamp,messages:[{role:'user',content:'اكتب تقريرًا',at:stamp},{role:'assistant',content:'نتيجة خاصة بالمهمة '+id,at:stamp}],steps:[{at:stamp,data:{type:'assistant_message',text:'نتيجة خاصة بالمهمة '+id}},{at:stamp,data:{type:'verify',verdict:'pass',reason:'تم فحص النتيجة'}}]};tasks.set(id,task);uploads.set(id,[]);return task;}
addTask('previous');addTask('other');addTask('builder','build');addTask('builder-two','build');
let resumes=0;const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://localhost');const p=url.pathname;requests.push(req.url);
  if(p.startsWith('/api/')) {
    let body={};if(req.method==='POST'&&!p.startsWith('/api/upload')){let text='';for await(const chunk of req)text+=chunk;body=text?JSON.parse(text):{};}
    let data={};
    if(p==='/api/modes')data={modes:LOAM_MODES.map(m=>({...m,availableTools:m.tools,unavailableTools:[]}))};
    if(p==='/api/settings')data={theme:'light',model:'fixture'};
    if(p==='/api/mcp/status')data={servers:[{name:'fixture-bridge',connected:false,toolCount:0}]};
    if(p==='/api/models')data={models:['fixture']};
    if(p==='/api/tasks')data={tasks:[...tasks.values()].map(t=>({...t,messageCount:t.messages.length}))};
    if(p==='/api/tasks/draft'){const id='draft'+(++count);const task=addTask(id,body.mode,'cancelled');task.title=body.title;task.messages=[];task.steps=[];task.projectId=body.projectId;data={task};}
    if(p==='/api/upload'){assert.ok(url.searchParams.get('taskId'));const id=url.searchParams.get('taskId');data={name:url.searchParams.get('name'),path:'uploads/'+url.searchParams.get('name')};uploads.get(id).push(data.path);for await(const _ of req){} }
    if(p==='/api/files'){assert.ok(url.searchParams.get('taskId'));data={entries:(uploads.get(url.searchParams.get('taskId'))||[]).map(path=>({path,dir:false}))};}
    if(p==='/api/file'){assert.ok(url.searchParams.get('taskId'));data={content:'file text'};}
    if(p==='/api/preview')data=req.method==='POST'?{url:`http://127.0.0.1:${server.address().port}/preview-fixture?task=${body.taskId}`}:{running:false};
    if(p==='/api/chat'){posts.push(body);const task=tasks.get(body.taskId);assert.ok(task);task.title=body.title||task.title;task.mode=body.mode;task.status='done';task.messages.push({role:'user',content:body.prompt,at:stamp});task.steps.push({at:stamp,data:{type:'assistant_message',text:'أنجزت '+body.mode}});res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({type:'task',taskId:body.taskId})+'\n\ndata: '+JSON.stringify({type:'assistant_message',text:'أنجزت '+body.mode})+'\n\ndata: '+JSON.stringify({type:'done'})+'\n\n');return;}
    const match=p.match(/^\/api\/tasks\/([^/]+)(?:\/(.*))?$/);
    if(match && match[1]!=='draft'){const task=tasks.get(decodeURIComponent(match[1]));if(match[2]==='resume'){resumes++;task.status='queued';}else if(match[2]==='cancel')task.status='cancelled';else if(match[2]==='stream'){res.writeHead(200,{'Content-Type':'text/event-stream'});for(const step of task.steps)res.write('data: '+JSON.stringify({type:'step-record',step})+'\n\n');res.write('data: '+JSON.stringify({type:'task-status',status:task.status})+'\n\n');req.on('close',()=>res.end());return;}else data={task,recovery:{resumable:task.status==='interrupted',requiresConfirmation:true,completedSteps:1}};}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));return;
  }
  if(p==='/preview-fixture'){res.setHeader('Content-Type','text/html');res.end('<h1>Application preview</h1>');return;}
  const file=p==='/'?'index.html':p.slice(1);if(file.includes('..'))throw new Error('bad path');const content=await readFile(new URL('../../ui/'+file,import.meta.url));res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');res.end(content);
}catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try {
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const origin=`http://127.0.0.1:${server.address().port}`;await page.goto(origin);await page.locator('.mode-card').first().waitFor();assert.equal(await page.locator('.mode-card').count(),6);
  await page.locator('#sideSearch').fill('builder-two');assert.equal(await page.locator('#sideTasks a').count(),1);await page.locator('#sideSearch').fill('');
  await page.keyboard.press('Control+k');assert.equal(await page.locator('#sideSearch').evaluate(el=>document.activeElement===el),true);
  assert.equal(await page.locator('.rail').count(),1);assert.equal(await page.locator('#homeModes button').count(),7);
  await page.locator('#collapseBtn').click();assert.equal(await page.locator('#sidebar').evaluate(el=>el.getBoundingClientRect().width),62);assert.equal(await page.locator('#collapseBtn').getAttribute('aria-expanded'),'false');await page.locator('#collapseBtn').click();
  await page.locator('#theme').click();assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');assert.match(await page.locator('html').evaluate(el=>getComputedStyle(el).getPropertyValue('--bg')),/10.5%/);
  await page.locator('#homePrompt').fill('طلب محفوظ من مركز Loam');await page.locator('[data-home-mode="write"]').click();await page.locator('#homeForm [type=submit]').click();await page.locator('#modeForm').waitFor();assert.equal(await page.locator('#modeForm [data-field]').first().inputValue(),'طلب محفوظ من مركز Loam');assert.equal(posts.length,0,'home composer must review mode details before executing');await page.goto(origin+'/#/home');await page.locator('#homeForm').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  const shots=join(tmpdir(),'loam-ui-review');await mkdir(shots,{recursive:true});await page.screenshot({path:join(shots,'home.png')});
  await page.setViewportSize({width:1900,height:980});await page.evaluate(async()=>{await document.fonts.ready;});
  assert.equal(await page.locator('#sidebar').evaluate(el=>Math.round(el.getBoundingClientRect().width)),332);
  assert.equal(await page.locator('#modeCards').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),3);
  assert.ok(await page.evaluate(()=>document.fonts.check('400 14px "Readex Pro"')));
  await page.screenshot({path:join(shots,'reference-1900.png')});await page.setViewportSize({width:1440,height:1000});
  await page.goto(origin+'/#/services');await page.locator('.service-card').filter({hasText:'اتصالات MCP'}).locator('.pill.error').waitFor();await page.goto(origin+'/#/home');
  for(const mode of LOAM_MODES){await page.goto(origin+'/#/modes/'+mode.id);await page.locator('#modeForm').waitFor();assert.equal(await page.locator('[data-tool]').count(),mode.tools.length);assert.equal(await page.locator('#modeForm [data-field]').count(),mode.fields.length);assert.match(await page.locator('#modePage').getAttribute('class'),new RegExp('mode-'+mode.id));if(mode.id==='ask')assert.equal(await page.locator('[data-tool="shell_run"]').count(),0);if(mode.id==='data')assert.equal(await page.locator('[data-tool="loam_dataset"]').count(),1);}
  await page.goto(origin+'/#/modes/write');await page.locator('#modeForm').waitFor();await page.locator('#modeForm [data-field]').first().fill('موجز مقال خاص');
  await page.locator('#uploadPicker').setInputFiles({name:'private-a.txt',mimeType:'text/plain',buffer:Buffer.from('PRIVATE-A')});await page.locator('#modeAttachments .attachment').waitFor();
  const uploadReq=requests.find(u=>u.startsWith('/api/upload'));assert.match(uploadReq,/taskId=draft/);
  await page.locator('#modeSubmit').click();await page.waitForURL(/#\/tasks\/draft/);await page.locator('#taskResult').getByText('أنجزت write').waitFor();assert.equal(posts[0].mode,'write');assert.equal(posts[0].attachments.length,1);
  await page.locator('#taskWorkspace').click();await page.locator('[data-file]').waitFor();assert.match(await page.locator('#filesList').textContent(),/private-a/);await page.locator('[data-file]').click();await page.locator('#fileView pre').waitFor();
  await page.locator('#closeWorkspace').click();await page.locator('#promptChat').fill('توجيه جديد');await page.locator('#sendChat').click();await page.waitForFunction(()=>document.querySelector('#sendChat').disabled===false);assert.equal(posts[1].taskId,posts[0].taskId);
  await page.goto(origin+'/#/tasks/other');await page.locator('#taskTitle').waitFor({timeout:1}).catch(()=>{});await page.locator('#taskResult').getByText('نتيجة خاصة بالمهمة other').waitFor();await page.locator('#taskWorkspace').click();await page.locator('#filesList .empty').waitFor();assert.doesNotMatch(await page.locator('#filesList').textContent(),/private-a/);await page.locator('#closeWorkspace').click();
  await page.locator('#activityTab').click();assert.equal(await page.locator('#timeline').isVisible(),true);await page.locator('#activityTab').press('ArrowRight');assert.equal(await page.locator('#taskOverview').isVisible(),true);
  for(const status of ['queued','running','error','cancelled','interrupted']){tasks.get('other').status=status;await page.reload();await page.locator('#chatStatus.'+status).waitFor();assert.equal(await page.locator('#taskRecovery button').count(),status==='interrupted'?1:0);}
  await page.locator('#taskRecovery button').click();await page.locator('#confirmDialog').waitFor();await page.locator('#confirmDialog [value=cancel]').click();assert.equal(resumes,0);await page.locator('#taskRecovery button').click();await page.locator('#confirmDialog [value=confirm]').click();await page.locator('#chatStatus.queued').waitFor();assert.equal(resumes,1);
  for(const width of [1440,768,320]){await page.setViewportSize({width,height:1000});for(const path of ['home','modes/ask','modes/research','modes/build','modes/write','modes/data','modes/media','modes/automate','tasks/other','services']){await page.goto(origin+'/#/'+path);await page.waitForTimeout(80);for(const dir of ['rtl','ltr']){await page.evaluate(dir=>document.documentElement.dir=dir,dir);const over=await page.evaluate(()=>{const view=document.querySelector('.view.active');return view.scrollWidth>view.clientWidth+1;});if(over)console.log(await page.locator('.view.active').evaluate(root=>[...root.querySelectorAll('*')].filter(el=>el.getBoundingClientRect().right>root.getBoundingClientRect().right+1).map(el=>({tag:el.tagName,class:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right,root:root.getBoundingClientRect().right})).slice(0,15)));assert.equal(over,false,`${path} ${width} ${dir} overflow`);}}}
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(origin+'/#/modes/build');await page.locator('.build-start-stage').waitFor();await page.screenshot({path:join(shots,'build-start.png')});
  await page.goto(origin+'/#/tasks/builder');await page.locator('#buildStage').waitFor();assert.equal(await page.locator('#timeline').isVisible(),true);
  await page.locator('#buildStartPreview').click();await page.locator('#buildFrame').waitFor();assert.match(await page.locator('#buildFrame').getAttribute('src'),/task=builder$/);
  await page.locator('#buildSize').click();assert.equal(await page.locator('#buildSize').getAttribute('aria-pressed'),'true');await page.locator('#buildSize').click();
  await page.locator('#buildFiles').click();await page.locator('#filesList .empty').waitFor();await page.locator('#closeWorkspace').click();
  await page.screenshot({path:join(shots,'build-workspace.png')});
  await page.goto(origin+'/#/tasks/builder-two');await page.waitForFunction(()=>document.querySelector('#buildFrame').getAttribute('src')==='about:blank');assert.equal(await page.locator('#buildEmpty').isVisible(),true);
  for(const width of [320,768,1440]){await page.setViewportSize({width,height:1000});assert.equal(await page.locator('#view-chat').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);}
  await page.goto(origin+'/#/tasks/other');await page.locator('#taskResult').waitFor();assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('build-studio')),false);
  await page.goto(origin+'/#/modes/media');await page.locator('#modeForm').waitFor();await page.screenshot({path:join(shots,'mobile.png')});
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>{document.documentElement.dir='rtl';document.body.style.zoom='2';document.documentElement.dataset.theme='dark';});assert.equal(await page.locator('.view.active').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);await page.evaluate(()=>document.body.style.zoom='1');await page.screenshot({path:join(shots,'studio-dark.png')});
  // Bundled studios have distinct routes, preserve the shell, and hand real prompts
  // to task preparation without executing sample content or trusting other frames.
  const studioCases=[['mobile','build'],['swarm','research'],['creative','media'],['security','build']];
  await page.goto(origin+'/#/home');await page.locator('#modeCards a').first().waitFor();
  assert.equal(new Set(await page.locator('#modeCards a').evaluateAll(els=>els.map(el=>el.hash))).size,6);
  assert.equal(await page.locator('#sideStudios a').count(),5);
  for(const [studio,mode] of studioCases){
    await page.goto(origin+'/#/home');await page.locator(`#modeCards a[href="#/studios/${studio}"]`).click();
    const frame=page.frameLocator('#embedFrame');await frame.locator('#studioPrepare').waitFor({timeout:10000}).catch(async error=>{console.log('STUDIO LOAD',studio,page.frames().map(f=>f.url()),errors);throw error;});
    assert.ok(page.frames().some(f=>f.url().endsWith('/studios/index.html?studio='+studio+'#'+studio)));
    const before=posts.length;
    await page.evaluate(studio=>window.postMessage({type:'loam:studio:prepare',studio,prompt:'untrusted'},location.origin),studio);
    await page.waitForTimeout(50);assert.ok(page.url().endsWith('/studios/'+studio));
    for(const tab of [1,2,0]){await frame.locator(`[data-tab="${tab}"]`).click();assert.equal(await frame.locator('[role=tab][aria-selected=true]').count(),1);}
    await page.setViewportSize({width:1600,height:1100});await page.screenshot({path:join(shots,'integrated-'+studio+'.png')});
    for(const width of [768,320]){await page.setViewportSize({width,height:1000});assert.equal(await frame.locator('html').evaluate(el=>el.scrollWidth>el.clientWidth+1),false,studio+' embedded overflow '+width);}
    await page.setViewportSize({width:1440,height:1000});
    await frame.locator('#prompt').fill('طلب حقيقي مستقل '+studio);await frame.locator('.send').click();
    await page.waitForURL('**/#/modes/'+mode);await page.locator('.studio-task-context').waitFor();
    assert.match(await page.locator('#modeForm [data-field]').first().inputValue(),new RegExp('طلب حقيقي مستقل '+studio));
    assert.equal(posts.length,before,'studio preview must not run sample prompts');
    await page.locator('#modeSubmit').click();await page.waitForURL(/#\/tasks\/draft/);await page.locator('#chatStatus.done').waitFor();
    assert.equal(posts.at(-1).mode,mode);assert.match(posts.at(-1).prompt,new RegExp('طلب حقيقي مستقل '+studio));assert.equal(posts.at(-1).attachments.length,0);
  }
  await page.goto(origin+'/#/studios/office');await page.locator('.office-studio').waitFor();await page.locator('#modeForm').waitFor();
  await page.reload();await page.locator('.office-studio').waitFor();
  assert.deepEqual(errors,[]);assert.ok(!await page.locator('body').innerText().then(t=>/manus|grok|frontier/i.test(t)));
  console.log('PASS Loam UI: seven routes/toolsets, scoped uploads/files, follow-up identity, terminal states/resume confirmation, keyboard tabs, 320/768/1440 RTL/LTR, 200% zoom, branding. Screenshots: '+shots);
} finally {await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}


