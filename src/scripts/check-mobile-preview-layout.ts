import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';
const base='http://127.0.0.1:3941',taskId='task_mvdb5dyx6cb1a5e47e9a',dir='release/mobile-live/preview-layout';
fs.mkdirSync(dir,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1110,height:884}}),errors:string[]=[];
page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);
try{
 await page.goto(base+'/#/studios/mobile');const studio=page.frameLocator('#embedFrame'),app=studio.frameLocator('#preview');
 await studio.locator('#projects').selectOption(taskId);await studio.locator('#open-explorer').filter({hasText:'20'}).waitFor();
 if(await page.locator('#collapseBtn').getAttribute('aria-expanded')==='true')await page.locator('#collapseBtn').click();
 const cardsVisible=()=>app.locator('.destination-card').evaluateAll(cards=>{const nav=cards[0]!.ownerDocument.querySelector('#mobile-app>nav')!.getBoundingClientRect();return cards.filter(n=>{const b=n.getBoundingClientRect();return b.top>=0&&b.bottom<=Math.min(cards[0]!.ownerDocument.defaultView!.innerHeight,nav.top)+1;}).length;});
 const normal=await studio.locator('#preview').boundingBox();assert.ok(normal&&normal.height>=500,'Preview should exceed 500px at the supplied desktop viewport');
 for(const name of ['تعلمي','مشاريعي','عاداتي','مراجعاتي']){await app.locator('nav button').filter({hasText:name}).click();assert.equal(await cardsVisible(),4,'Four visible destinations in '+name);}
 await page.screenshot({path:dir+'/normal.png'});
 await studio.locator('#preview-fullscreen').click();await page.locator('#embedFrame.mobile-preview-expanded').waitFor();
 const expanded=await studio.locator('#preview').boundingBox();assert.ok(expanded&&expanded.height>normal.height+150);
 assert.equal(await app.locator('h1').innerText(),'مراجعاتي');assert.equal(await cardsVisible(),4);
 await app.locator('.guidance-card summary').click();assert.equal(await app.locator('.guidance-card').getAttribute('open'),'');
 await app.locator('nav button').filter({hasText:'مشاريعي'}).click();await app.getByRole('button',{name:'تفاصيل المهمة',exact:true}).click();
 const field=app.locator('[data-block-id="block_task_details_note"] input');await field.fill('اختبار بقاء البيانات عند تكبير المعاينة');
 await app.getByRole('button',{name:'حفظ تفاصيل المهمة',exact:true}).click();assert.match(await app.locator('output').innerText(),/تم حفظ/);
 await field.press('Escape');await page.locator('#embedFrame.mobile-preview-expanded').waitFor({state:'detached'});assert.equal(await field.inputValue(),'اختبار بقاء البيانات عند تكبير المعاينة');
 assert.equal(await studio.locator('#preview-fullscreen').evaluate(n=>n===n.ownerDocument.activeElement),true);
 await studio.locator('#preview-fullscreen').click();await studio.locator('#preview-fullscreen').click();assert.equal(await app.locator('h1').innerText(),'تفاصيل المهمة');
 await app.getByRole('button',{name:'رجوع',exact:true}).click();assert.equal(await app.locator('h1').innerText(),'مشاريعي');
 await studio.locator('#preview-fullscreen').click();await studio.locator('#select-mode').click();await page.locator('#embedFrame.mobile-preview-expanded').waitFor({state:'detached'});await app.getByRole('button',{name:'تعديل: مشروع الأسبوع',exact:true}).click();await studio.locator('#element-text').waitFor();await studio.locator('#interact').click();
 for(const size of [{width:768,height:884},{width:320,height:740},{width:740,height:400}]){
  await page.setViewportSize(size);await studio.locator('#preview-fullscreen').click();
  assert.equal(await studio.locator('html').evaluate(n=>n.scrollWidth>n.clientWidth+1),false,'Studio overflow '+size.width);
  assert.equal(await app.locator('html').evaluate(n=>n.scrollWidth>n.clientWidth+1),false,'App overflow '+size.width);
  assert.equal(await studio.locator('#preview-fullscreen').isVisible(),true);
  await studio.locator('#preview-fullscreen').press('Escape');
 }
 await page.setViewportSize({width:1110,height:884});await studio.locator('#preview-fullscreen').click();await page.screenshot({path:dir+'/fullscreen.png'});await studio.locator('#preview-fullscreen').click();
 await page.reload();await studio.locator('#projects').selectOption(taskId);await app.locator('nav button').filter({hasText:'مشاريعي'}).click();await app.getByRole('button',{name:'تفاصيل المهمة',exact:true}).click();assert.equal(await field.inputValue(),'اختبار بقاء البيانات عند تكبير المعاينة');
 assert.deepEqual(errors,[]);
 const result={normalHeight:normal.height,expandedHeight:expanded.height,visibleCards:4,sections:4,escape:'passed from nested preview and toolbar',modeSwitch:'page, back trail and data preserved',saveReload:'passed',responsive:[768,320,740],browserErrors:errors};fs.writeFileSync(dir+'/verification.json',JSON.stringify(result,null,2));console.log('PASS '+JSON.stringify(result));
}catch(error){console.log('DIAGNOSTIC',page.viewportSize(),await page.locator('body').getAttribute('class'),await page.locator('#embedFrame').boundingBox(),await page.locator('#embedFrame').getAttribute('src'),await page.locator('#sidebar').getAttribute('class'),await page.locator('#content').getAttribute('inert'));console.log('FRAMES',page.frames().map(f=>f.url()));await page.screenshot({path:dir+'/failure.png'});throw error;}finally{await browser.close();}
