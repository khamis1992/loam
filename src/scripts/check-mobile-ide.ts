import assert from 'node:assert/strict';
import type {Browser} from 'playwright';
import JSZip from 'jszip';
import {recordsFixture} from './mobile-records-fixture.js';
import {more} from './mobile-builder-test.js';

export async function checkMobileIDE(browser:Browser,base:string){
 const post=(route:string,body:unknown)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const {task}=await(await post('/api/tasks/draft',{mode:'build',title:'اختبار محرر التطبيق'})).json() as {task:{id:string}};
 await post('/api/mobile',{taskId:task.id,expectedRevision:0,project:recordsFixture});
 const get=async(route:string)=>await(await fetch(base+'/api/mobile/'+route+'?taskId='+task.id)).json() as any;
 const browserContext=await browser.newContext({viewport:{width:1440,height:1000}}),page=await browserContext.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(base+'/mobile.html?taskId='+task.id);await page.locator('#status').filter({hasText:'استعادة'}).waitFor();
  await page.locator('#collapse-chat').click();assert.equal(await page.locator('.workspace>.side').isVisible(),false);await page.locator('#collapse-chat').click();
  await page.locator('#preview-device').selectOption('tablet');assert.equal(await page.locator('.canvas').getAttribute('data-preview-size'),'tablet');await page.locator('#preview-device').selectOption('phone');
  await page.locator('#preview-address').fill('/tasks_home');await page.locator('#preview-address').press('Enter');await page.frameLocator('#preview').locator('h1').filter({hasText:'المهام'}).waitFor();
  await page.locator('#tab-code').click();await page.locator('[data-file="web/styles.css"]').waitFor();
  const initial=await get('source'),versions=await get('versions'),original=versions.versions[0];assert.ok(initial.files['expo/App.js']);assert.ok(Object.keys(initial.files).some(x=>x.endsWith('MainActivity.kt')));
  for(const path of ['../escape.js','web/../bad.js','.env','web/.hidden.js','C:/outside.js'])assert.equal((await post('/api/mobile/source',{taskId:task.id,path,content:'bad',expectedRevision:1,tag:initial.tag})).status,400);
  assert.equal((await post('/api/mobile/source',{taskId:task.id,path:'web/styles.css',content:'bad',expectedRevision:99,tag:initial.tag})).status,409);
  assert.equal((await post('/api/mobile/source',{taskId:task.id,path:'web/styles.css',content:'bad',expectedRevision:1,tag:initial.tag})).status,200);
  // Reload the editor after an external save; it must not overwrite the current CAS.
  await page.reload();await page.locator('#tab-code').click();await page.locator('[data-file="web/styles.css"]').click();
  const css=initial.files['web/styles.css'].replace(/\r\n/g,'\n')+'\nh1 {color: rgb(123, 45, 67) !important;}\n';
  await page.locator('#source-editor').fill(css);await page.locator('#source-apply').click();await page.locator('#source-status').filter({hasText:'حُفظ web/styles.css'}).waitFor();
  assert.equal((await get('source')).files['web/styles.css'],css);
  await page.locator('#undo').click();await page.locator('#status').filter({hasText:'النسخة السابقة'}).waitFor();assert.equal((await get('source')).files['web/styles.css'],'bad');await more(page,'redo');await page.locator('#status').filter({hasText:'النسخة التالية'}).waitFor();assert.equal((await get('source')).files['web/styles.css'],css);
  await page.locator('#tab-preview').click();const frame=page.frameLocator('#preview');await frame.locator('h1').waitFor();assert.equal(await frame.locator('h1').evaluate((n:any)=>(globalThis as any).getComputedStyle(n).color),'rgb(123, 45, 67)');
  assert.equal(await frame.locator('body').evaluate(()=>{try{void (globalThis as any).parent.document;return false;}catch{return true;}}),true,'custom source must have opaque origin');
  // Saved JavaScript and later visual edits must use this same default frame.
  await page.locator('#tab-code').click();await page.locator('[data-file="web/app.js"]').click();
  const sourceBeforeJS=await get('source'),js=sourceBeforeJS.files['web/app.js']+'\nconst savedRender=window.__loamRender;window.__loamRender=context=>{savedRender(context);document.getElementById("mobile-app").dataset.savedSource="running";};window.__loamRender(window.__loamContext||{});\n';
  await page.locator('#source-editor').fill(js).catch(async error=>{console.error('JS editor visibility',await page.locator('#source-editor').evaluate((n:any)=>({disabled:n.disabled,readOnly:n.readOnly,rect:n.getBoundingClientRect().toJSON(),pane:n.closest('[role=tabpanel]')?.hidden,body:(globalThis as any).document.body.className})));throw error;});await page.locator('#source-apply').click();await page.locator('#source-status').filter({hasText:'حُفظ web/app.js'}).waitFor();await page.locator('#tab-preview').click();await frame.locator('#mobile-app[data-saved-source="running"]').waitFor();
  await page.locator('#title').fill('مشروع بشيفرة وتصميم موحّدين');await page.locator('#save').click();await page.locator('#status').filter({hasText:'محفوظ على الجهاز'}).waitFor();await frame.locator('header').filter({hasText:'مشروع بشيفرة وتصميم موحّدين'}).waitFor();await frame.locator('#mobile-app[data-saved-source="running"]').waitFor();
  // The unified preview preserves the selected route; explicitly open projects.
  await frame.getByRole('button',{name:'المشاريع',exact:true}).click();
  // The storage bridge validates and persists records on the local server.
  await frame.getByRole('button',{name:'إضافة مشروع',exact:true}).click();await frame.locator('[data-field-id="name"]').fill('سجل من معاينة الشيفرة');await frame.getByRole('button',{name:'حفظ مشروع',exact:true}).click();await frame.getByRole('heading',{name:'سجل من معاينة الشيفرة',exact:true}).waitFor();
  await page.locator('#preview-refresh').click();await frame.getByRole('heading',{name:'سجل من معاينة الشيفرة',exact:true}).waitFor();
  // Publishing after undo/redo in Preview must read current saved files, even with the editor hidden.
  await page.locator('#undo').click();await page.locator('#status').filter({hasText:'النسخة السابقة'}).waitFor();await more(page,'redo');await page.locator('#status').filter({hasText:'النسخة التالية'}).waitFor();await frame.locator('#mobile-app[data-saved-source="running" ]').waitFor();
  await page.locator('.preview-more>summary').click();await page.locator('#open-publish').click();await page.locator('#publish-now').click();await page.locator('#local-publish output').filter({hasText:'جاهزة'}).waitFor();
  const release=await get('releases');assert.ok(release.active);assert.match(await page.locator('#console-publish').textContent()||'',/حُفظت نسخة ثابتة/);
  const published=await page.context().newPage();await published.goto(base+release.url);await published.frameLocator('#published-app').getByRole('heading',{name:'سجل من معاينة الشيفرة',exact:true}).waitFor();await published.close();
  await page.locator('#local-publish-close').click();
  await page.locator('#open-history').click();await page.locator('#version-list article').first().waitFor();await page.locator('#version-search').fill('styles.css');assert.ok(await page.locator('#version-list article').count()>0);await page.locator('#version-search').fill('');
  await page.locator('#bookmark-'+original.id).click();assert.equal((await get('versions')).versions.find((v:any)=>v.id===original.id).bookmarked,true);
  page.once('dialog',d=>d.accept());await page.locator('#restore-'+original.id).first().click();await page.locator('#version-status').filter({hasText:'استُعيد'}).waitFor();assert.notEqual((await get('source')).files['web/styles.css'],css);
  assert.equal(await page.locator('body').evaluate((_body,taskId)=>JSON.parse(localStorage.getItem('loam-mobile-'+taskId+'-records')!).collections.projects[0].values.name,task.id),'سجل من معاينة الشيفرة');
  // Published versions are immutable even after a source restore.
  const publishedAgain=await page.context().newPage();await publishedAgain.goto(base+release.url);assert.equal(await publishedAgain.frameLocator('#published-app').locator('h1').evaluate((n:any)=>(globalThis as any).getComputedStyle(n).color),'rgb(123, 45, 67)');await publishedAgain.close();
  await page.locator('#version-history-close').click();
  await page.locator('#open-git').click();await page.locator('#git-init').click();await page.locator('#git-init').waitFor({state:'hidden'});await page.getByLabel('وصف Commit').fill('Initial local mobile source');await page.locator('#git-commit').click();await page.locator('#local-git pre').filter({hasText:'Initial local mobile source'}).waitFor();await page.locator('#local-git-close').click();
  // Use the actual PTY, scoped to the generated application worktree.
  await page.locator('.preview-more>summary').click();await page.locator('#open-console').click();await page.locator('#console-terminal').click();const terminal=page.frameLocator('.console-terminal-host iframe');await terminal.locator('#status').filter({hasText:'node-pty loaded'}).waitFor();await terminal.locator('#start').click();await terminal.locator('#status').filter({hasText:'جلسة '}).waitFor().catch(async e=>{throw Error(e.message+' Terminal status: '+await terminal.locator('#status').innerText());});
  const sessions=await(await fetch(base+'/api/pty?taskId='+task.id)).json() as {sessions:{id:string;cwd:string}[]};assert.equal(sessions.sessions.length,1);const session=sessions.sessions[0]!;assert.match(session.cwd,/mobile-worktree$/);
  await post('/api/pty/'+session.id+'/input?taskId='+task.id,{data:'echo LOAM_IDE_TERMINAL_OK\r'});
  const until=Date.now()+8000;let terminalOutput='';while(Date.now()<until){terminalOutput=(await(await fetch(base+'/api/pty/'+session.id+'/output?taskId='+task.id)).json() as {data:string}).data;if(terminalOutput.includes('LOAM_IDE_TERMINAL_OK'))break;await new Promise(r=>setTimeout(r,100));}assert.match(terminalOutput,/LOAM_IDE_TERMINAL_OK/);await page.locator('[id^="console-close-terminal-"]').click();assert.equal((await(await fetch(base+'/api/pty?taskId='+task.id)).json() as {sessions:unknown[]}).sessions.length,0);
  const zip=await JSZip.loadAsync(await(await fetch(base+'/api/mobile/export?taskId='+task.id)).arrayBuffer());assert.ok(zip.file('web/app.js'));assert.ok(zip.file('expo/App.js'));
  await page.locator('#console-hide').click();for(const width of [1110,768,320]){await page.setViewportSize({width,height:884});if(await page.locator('#view-preview').isVisible())await page.locator('#view-preview').click();await page.locator('#tab-code').click();assert.equal(await page.locator('html').evaluate(n=>n.scrollWidth>n.clientWidth+1),false,'IDE overflow '+width);}
  assert.deepEqual(errors,[]);console.log('PASS mobile IDE: actual web/Expo/Kotlin files, CAS/path isolation, source undo/redo, edited CSS preview, opaque sandbox, shared validated records/reload, bookmarks/restore, immutable local publish, local Git commit, real scoped PTY and 320px layout');
  return {taskId:task.id,releaseId:release.active,bookmarkedId:original.id};
 }finally{await browserContext.close();}
}
