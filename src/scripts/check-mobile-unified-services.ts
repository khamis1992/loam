import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {chromium,type Browser,type Page} from 'playwright';
import {recordsFixture} from './mobile-records-fixture.js';

/** Actual sandbox, trusted bridge, SQLite, admin UI and browser downloads; no mocked service responses. */
export async function checkMobileUnifiedServices(browser:Browser,base:string){
 const post=async(route:string,body:unknown,headers:Record<string,string>={})=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 const {task}=await(await post('/api/tasks/draft',{mode:'build',title:'Unified local services browser acceptance'})).json() as {task:{id:string}};
 const taskId=task.id,fixture=structuredClone(recordsFixture);fixture.screens[0]!.blocks.push({id:'project_note',type:'input',text:'ملاحظة المشروع'},{id:'save_note',type:'button',text:'حفظ الملاحظة'});
 assert.equal((await post('/api/mobile',{taskId,expectedRevision:0,project:fixture})).status,200);
 const contextA=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true}),contextB=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 const page=await contextA.newPage(),second=await contextB.newPage(),errors:string[]=[];
 page.on('pageerror',e=>errors.push('A: '+e.message));second.on('pageerror',e=>errors.push('B: '+e.message));
 const app=(p:Page)=>p.frameLocator('#preview');
 const token=(p:Page)=>p.evaluate(id=>localStorage.getItem('loam-mobile-session-'+id)||'',taskId);
 const state=async(p:Page)=>await(await fetch(base+'/api/mobile/local/state?taskId='+taskId,{headers:{authorization:'Bearer '+await token(p)}})).json() as any;
 async function register(p:Page,email:string){const frame=app(p);await frame.getByLabel('البريد الإلكتروني',{exact:true}).fill(email);await frame.getByLabel('كلمة المرور',{exact:true}).fill('Local-password-123');await frame.getByRole('button',{name:'إنشاء حساب',exact:true}).click();await frame.locator('h1').filter({hasText:'المشاريع'}).waitFor();}
 async function add(p:Page,name:string){const frame=app(p);await frame.getByRole('button',{name:'إضافة مشروع',exact:true}).click();await frame.getByLabel('عنوان المشروع',{exact:true}).fill(name);await frame.getByRole('button',{name:'حفظ مشروع',exact:true}).click();await frame.getByRole('heading',{name,exact:true}).waitFor();}
 async function policy(value:'owner'|'shared'){await page.locator('#tab-database').click();await page.locator('#database-nav [data-service="security"]').click();await page.getByLabel('سياسة البيانات',{exact:true}).selectOption(value);await page.getByRole('button',{name:'حفظ سياسة الوصول',exact:true}).click();await page.locator('.local-service>output').filter({hasText:'حُفظت سياسة الوصول'}).waitFor();await page.locator('#tab-preview').click();const until=Date.now()+8000;while(Date.now()<until){if(await app(page).locator('body').evaluate(()=>(globalThis as any).__loamContext?.services?.policy)===value)return;await new Promise(r=>setTimeout(r,50));}throw Error('Preview did not receive current policy '+value);}
 try{
  await page.goto(base+'/mobile.html?taskId='+taskId);await app(page).locator('h1').filter({hasText:'المشاريع'}).waitFor();
  await policy('owner');await app(page).getByLabel('البريد الإلكتروني',{exact:true}).waitFor();
  assert.equal(await app(page).getByRole('button',{name:'إضافة مشروع',exact:true}).count(),0,'Policy change must close anonymous access immediately');
  await register(page,'alice-browser@example.test');await add(page,'مشروع أليس الخاص');
  await app(page).getByLabel('ملاحظة المشروع',{exact:true}).fill('ملاحظة محفوظة في SQLite');await app(page).getByRole('button',{name:'حفظ الملاحظة',exact:true}).click();await app(page).locator('output').filter({hasText:'تم حفظ البيانات'}).waitFor();
  assert.equal((await state(page)).values.project_note,'ملاحظة محفوظة في SQLite');
  await app(page).getByRole('button',{name:'حسابي',exact:true}).click();await app(page).locator('summary').filter({hasText:'ملفاتي'}).click();
  await app(page).getByLabel('إرفاق ملف',{exact:true}).setInputFiles({name:'local-note.txt',mimeType:'text/plain',buffer:Buffer.from('Persisted local file from preview')});await app(page).locator('output').filter({hasText:'حُفظ الملف محليًا'}).waitFor();
  const downloaded=page.waitForEvent('download');await app(page).getByRole('button',{name:'local-note.txt',exact:true}).click();const download=await downloaded;assert.equal(download.suggestedFilename(),'local-note.txt');assert.equal(await download.failure(),null);assert.equal(fs.readFileSync((await download.path())!,'utf8'),'Persisted local file from preview');
  await second.goto(base+'/mobile.html?taskId='+taskId);await register(second,'bob-browser@example.test');
  assert.equal(await app(second).getByRole('heading',{name:'مشروع أليس الخاص',exact:true}).count(),0);assert.equal(await app(second).getByLabel('ملاحظة المشروع',{exact:true}).inputValue(),'');
  await add(second,'مشروع بوب الخاص');await app(second).getByRole('button',{name:'حسابي',exact:true}).click();const bobFiles=second.waitForResponse(r=>r.url().includes('/api/mobile/local/files?')&&r.request().method()==='GET');await app(second).locator('summary').filter({hasText:'ملفاتي'}).click();assert.equal((await bobFiles).status(),200);assert.equal(await app(second).getByRole('button',{name:'local-note.txt',exact:true}).count(),0);
  const alice=await state(page),bob=await state(second);assert.equal(alice.state.collections.projects.length,1);assert.equal(bob.state.collections.projects.length,1);assert.equal(alice.state.collections.projects[0].values.name,'مشروع أليس الخاص');assert.equal(bob.state.collections.projects[0].values.name,'مشروع بوب الخاص');
  // A stale or forged other-scope browser cache must never become authoritative.
  const authoritativeRefresh=page.waitForResponse(r=>r.url().includes('/api/mobile/local/state?')&&r.request().method()==='GET');await page.evaluate(({taskId,bob})=>{const key='loam-mobile-'+taskId+'-records';localStorage.setItem(key,JSON.stringify(bob.state));const win=globalThis as any;win.dispatchEvent(new win.StorageEvent('storage',{key,newValue:JSON.stringify(bob.state),storageArea:localStorage}));},{taskId,bob});assert.equal((await authoritativeRefresh).status(),200);
  await app(page).getByRole('heading',{name:'مشروع أليس الخاص',exact:true}).waitFor();assert.equal(await app(page).getByRole('heading',{name:'مشروع بوب الخاص',exact:true}).count(),0);
  await page.evaluate(id=>{localStorage.removeItem('loam-mobile-'+id);localStorage.removeItem('loam-mobile-'+id+'-records');},taskId);await page.reload();await app(page).getByRole('heading',{name:'مشروع أليس الخاص',exact:true}).waitFor();assert.equal(await app(page).getByLabel('ملاحظة المشروع',{exact:true}).inputValue(),'ملاحظة محفوظة في SQLite');
  await app(page).getByRole('button',{name:'حسابي',exact:true}).click();await app(page).locator('summary').filter({hasText:'ملفاتي'}).click();await app(page).getByRole('button',{name:'local-note.txt',exact:true}).waitFor();
  await app(page).getByRole('button',{name:'تسجيل الخروج',exact:true}).click();await app(page).getByLabel('البريد الإلكتروني',{exact:true}).waitFor();assert.equal(await app(page).getByRole('heading',{name:'مشروع أليس الخاص',exact:true}).count(),0);
  await app(page).getByLabel('البريد الإلكتروني',{exact:true}).fill('alice-browser@example.test');await app(page).getByLabel('كلمة المرور',{exact:true}).fill('Local-password-123');const loginResponse=page.waitForResponse(r=>r.url().includes('/api/mobile/local/auth')&&r.request().method()==='POST',{timeout:10000});await app(page).getByRole('button',{name:'دخول',exact:true}).click();assert.equal((await loginResponse).status(),200);await app(page).getByRole('heading',{name:'مشروع أليس الخاص',exact:true}).waitFor();
  await policy('shared');await app(page).locator('h1').filter({hasText:'المشاريع'}).waitFor();assert.equal(await app(page).getByRole('heading',{name:'مشروع أليس الخاص',exact:true}).count(),0,'Changing policy preserves private scope without exposing it in shared scope');
  await policy('owner');await app(page).getByRole('heading',{name:'مشروع أليس الخاص',exact:true}).waitFor();
  await app(page).getByRole('button',{name:'حسابي',exact:true}).click();await app(page).getByRole('button',{name:'تسجيل الخروج',exact:true}).click();await app(page).getByLabel('البريد الإلكتروني',{exact:true}).waitFor();
  await app(page).getByLabel('البريد الإلكتروني',{exact:true}).fill('bob-browser@example.test');await app(page).getByLabel('كلمة المرور',{exact:true}).fill('Local-password-123');const switchLogin=page.waitForResponse(r=>r.url().includes('/api/mobile/local/auth')&&r.request().method()==='POST');await app(page).getByRole('button',{name:'دخول',exact:true}).click();assert.equal((await switchLogin).status(),200);await app(page).getByRole('heading',{name:'مشروع بوب الخاص',exact:true}).waitFor();assert.equal(await app(page).getByRole('heading',{name:'مشروع أليس الخاص',exact:true}).count(),0);assert.equal(await app(page).getByLabel('ملاحظة المشروع',{exact:true}).inputValue(),'');
  await app(page).getByRole('button',{name:'حسابي',exact:true}).click();const switchedFiles=page.waitForResponse(r=>r.url().includes('/api/mobile/local/files?')&&r.request().method()==='GET');await app(page).locator('summary').filter({hasText:'ملفاتي'}).click();assert.equal((await switchedFiles).status(),200);assert.equal(await app(page).getByRole('button',{name:'local-note.txt',exact:true}).count(),0);
  assert.deepEqual(errors,[]);console.log('PASS unified local services browser: live policy refresh, real sandbox register/login/logout, two-user records/value/file isolation, host download bytes, forged-cache rejection, SQLite reload after cache removal, preserved scopes');return {taskId};
 }catch(error){console.error('Unified preview diagnostic:',await app(page).locator('body').innerText().catch(()=>'(frame unavailable)'));console.error('Signin email:',await app(page).getByLabel('البريد الإلكتروني',{exact:true}).inputValue({timeout:500}).catch(()=>'(none)'));console.error('Password validity:',await app(page).getByLabel('كلمة المرور',{exact:true}).evaluate((n:any)=>({length:n.value.length,valid:n.validity.valid,message:n.validationMessage}),{},{timeout:500}).catch(()=>'(none)'));console.error('Unified host errors:',errors);throw error;}finally{await contextA.close();await contextB.close();}
}

async function isolated(){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'loam-mobile-unified-services-')),workspace=path.join(temp,'workspace'),config=path.join(temp,'config.json');fs.mkdirSync(workspace);fs.writeFileSync(config,JSON.stringify({model:'fixture',workspace,computerUse:{enabled:false,screenshotDir:path.join(temp,'screenshots')},memory:{enabled:false},screen:{enabled:false},selfImprove:{enabled:false},mcpServers:{}}));
 const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=(probe.address() as import('node:net').AddressInfo).port;await new Promise<void>(r=>probe.close(()=>r()));
 const base='http://127.0.0.1:'+port,child=spawn(process.execPath,['--import','tsx','src/index.ts'],{cwd:process.cwd(),windowsHide:true,env:{...process.env,MANUS_LOCAL_CONFIG:config,MANUS_LOCAL_DATA_DIR:path.join(temp,'data'),MANUS_LOCAL_PORT:String(port),MANUS_LOCAL_EVALS_DIR:path.join(temp,'evals'),MANUS_LOCAL_SKILLS_DIR:path.join(temp,'skills')},stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);let browser:Browser|undefined;
 try{let ready=false;const until=Date.now()+30000;while(Date.now()<until){if(await fetch(base+'/api/tasks').then(r=>r.ok).catch(()=>false)){ready=true;break;}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,logs);browser=await chromium.launch({channel:'chrome',headless:true});await checkMobileUnifiedServices(browser,base);}
 catch(error){console.error('Isolated test workspace:',temp);throw error;}
 finally{await browser?.close();if(child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await isolated();
