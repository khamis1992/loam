import assert from 'node:assert/strict';
import type {Browser} from 'playwright';
import {recordsFixture} from './mobile-records-fixture.js';
import {more} from './mobile-builder-test.js';

export async function checkWorkbench(browser:Browser,base:string){
 const post=(url:string,body:unknown)=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const {task}=await (await post('/api/tasks/draft',{mode:'build',title:'اختبار أدوات البناء'})).json() as {task:{id:string}};
 assert.equal((await post('/api/mobile',{taskId:task.id,project:recordsFixture,expectedRevision:0})).status,200);
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(base+'/mobile.html?taskId='+task.id);await page.locator('#status').filter({hasText:'استعادة'}).waitFor();
  await page.locator('#tab-code').click();const source=JSON.parse(await page.locator('#source-editor').inputValue()) as typeof recordsFixture;
  await page.locator('#source-editor').fill('{invalid');await page.locator('#source-apply').click();await page.locator('#source-status').filter({hasText:'JSON غير صالح'}).waitFor();
  const invalid={...source,screens:[{...source.screens[0],blocks:[{id:'broken_link',type:'button',text:'Invalid',target:'missing'}]}]};
  await page.locator('#source-editor').fill(JSON.stringify(invalid));await page.locator('#source-apply').click();await page.locator('#notice').waitFor();assert.equal(await page.locator('#source-editor').inputValue(),JSON.stringify(invalid));
  const changed={...source,title:'مخطط حقيقي محفوظ'};await page.locator('#source-editor').fill(JSON.stringify(changed));await page.locator('#source-apply').click();await page.locator('#source-status').filter({hasText:'اجتاز المخطط الفحص'}).waitFor();
  assert.equal(await page.locator('#title').inputValue(),changed.title);await page.locator('#undo').click();await page.waitForFunction("document.querySelector('#title').value === "+JSON.stringify(source.title));await more(page,'redo');
  await page.waitForFunction("document.querySelector('#title').value === 'مخطط حقيقي محفوظ'");
  // Unapplied source drafts survive leaving the editor and cannot silently replace a project.
  await page.locator('#source-editor').fill('{draft');let confirmSeen=false;page.once('dialog',async d=>{confirmSeen=true;await d.dismiss();});await page.locator('#new').click();assert.equal(confirmSeen,true);assert.equal(await page.locator('#source-editor').inputValue(),'{draft');
  page.once('dialog',d=>d.accept());await page.locator('#source-reset').click();
  await page.locator('#tab-database').click();assert.deepEqual(await page.locator('#database-nav button').allTextContents(),['الجداول','الأمان','المصادقة','إدارة المستخدمين','وظائف الخادم','تخزين الملفات','الأسرار','السجلات','متقدم']);
  await page.locator('#database-collection').selectOption('projects');const records=page.locator('#database-records');await records.getByRole('button',{name:'إضافة مشروع',exact:true}).click();await records.locator('[data-field-id="name"]').fill('سجل مشترك مع المعاينة');await records.getByRole('button',{name:'حفظ مشروع',exact:true}).click();await records.getByRole('heading',{name:'سجل مشترك مع المعاينة',exact:true}).waitFor();
  await page.locator('#tab-preview').click();const frame=page.frameLocator('#preview');await frame.getByRole('button',{name:/المشاريع/,exact:false}).last().click();await frame.getByRole('heading',{name:'سجل مشترك مع المعاينة',exact:true}).waitFor();
  await page.reload();await page.locator('#tab-database').click();await page.locator('#database-collection').selectOption('projects');await records.getByRole('heading',{name:'سجل مشترك مع المعاينة',exact:true}).waitFor();
  await page.locator('#database-nav [data-service="authentication"]').click();await page.locator('#database-availability').filter({hasText:'محلي'}).waitFor();assert.equal(await records.isVisible(),false);
  await page.locator('#open-services').click();assert.deepEqual(await page.locator('#service-nav section').first().getByRole('button').allTextContents(),['عام','النطاقات والاستضافة','التحليلات','معرفة المشروع','المهارات','النسخ الاحتياطية']);await page.locator('#close-services').click();
  for(const width of [1440,768,320]){await page.setViewportSize({width,height:1000});await page.locator('#view-preview').isVisible().then(async visible=>{if(visible)await page.locator('#view-preview').click();});for(const pane of ['preview','code','database']){await page.locator('#tab-'+pane).click();assert.equal(await page.locator('html').evaluate(n=>n.scrollWidth>n.clientWidth+1),false,`workbench overflow ${width} ${pane}`);}await page.locator('#open-services').click();assert.equal(await page.locator('#services-dialog').evaluate(n=>n.scrollWidth>n.clientWidth+1),false,'service dialog overflow '+width);await page.locator('#close-services').click();}
  assert.deepEqual(errors,[]);console.log('PASS builder workbench: source validation/save/undo/redo, draft protection, live shared records, ordered services and 320px layout');
 }finally{await page.close();}
}
