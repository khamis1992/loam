import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';
const base='http://127.0.0.1:3941',task='task_mvdb5dyx6cb1a5e47e9a',dir='release/mobile-live/screen-links';fs.mkdirSync(dir,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1110,height:884},permissions:['clipboard-read','clipboard-write']});const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(base+'/?mobileTask='+task+'&mobileScreen=screen_task_details#/studios/mobile');const studio=page.frameLocator('#embedFrame'),app=studio.frameLocator('#preview');await app.getByRole('heading',{name:'تفاصيل المهمة',exact:true}).waitFor();
 assert.deepEqual(await studio.locator('#screen-path a').allTextContents(),['مشاريعي','مهمة اليوم']);
 await studio.locator('#screen-link').click();await studio.locator('#screen-link-dialog[open]').waitFor();const url=await studio.locator('#screen-link-url').inputValue();assert.equal(new URL(url).searchParams.get('mobileScreen'),'screen_task_details');
 await studio.locator('#copy-screen-link').click();await studio.locator('#screen-link-status').filter({hasText:'تم نسخ'}).waitFor();assert.equal(await page.locator('html').evaluate(n=>n.ownerDocument.defaultView!.navigator.clipboard.readText()),url);
 const opened=context.waitForEvent('page');await studio.locator('#open-screen-link').click();const second=await opened;await second.frameLocator('#embedFrame').frameLocator('#preview').getByRole('heading',{name:'تفاصيل المهمة',exact:true}).waitFor();await second.close();
 await studio.locator('#close-screen-link').click();await studio.getByRole('link',{name:'مهمة اليوم',exact:true}).click();await app.getByRole('heading',{name:'مهمة اليوم',exact:true}).waitFor();await page.waitForURL(u=>u.searchParams.get('mobileScreen')==='screen_daily_task');await page.reload();await app.getByRole('heading',{name:'مهمة اليوم',exact:true}).waitFor();
 await studio.getByRole('link',{name:'مشاريعي',exact:true}).click();assert.equal(await studio.locator('#screen-path').innerText(),'مشاريعي');await app.getByRole('button',{name:'تفاصيل المهمة',exact:true}).click();await page.waitForURL(u=>u.searchParams.get('mobileScreen')==='screen_task_details');
 await app.getByRole('button',{name:'رجوع',exact:true}).click();await page.waitForURL(u=>u.searchParams.get('mobileScreen')==='screen_projects');
 await page.goto(base+'/?mobileTask='+task+'&mobileScreen=deleted_page#/studios/mobile');await studio.locator('#status').filter({hasText:'لم تعد موجودة'}).waitFor();assert.equal(await app.locator('h1').innerText(),'تعلمي');
 // Without URL parameters the last project is still restored from local storage.
 await page.goto(base+'/#/studios/mobile');await studio.locator('#open-explorer').filter({hasText:'20'}).waitFor();
 if(await page.locator('#collapseBtn').getAttribute('aria-expanded')==='true')await page.locator('#collapseBtn').click();
 await app.getByRole('button',{name:'مشاريعي',exact:true}).click();await app.getByRole('button',{name:'تفاصيل المهمة',exact:true}).click();await studio.locator('#screen-link').click();await page.screenshot({path:dir+'/dialog.png'});await studio.locator('#close-screen-link').click();
 await page.setViewportSize({width:320,height:740});assert.equal(await studio.locator('html').evaluate(n=>n.scrollWidth>n.clientWidth+1),false);assert.deepEqual(errors,[]);
 fs.writeFileSync(dir+'/verification.json',JSON.stringify({directLink:'passed',copy:'passed',newTab:'passed',breadcrumb:'passed',previewSync:'passed',reload:'passed',missingScreen:'safe fallback',rememberedProject:'passed',narrowWidth:320,errors},null,2));console.log('PASS direct screen links, copy/open, breadcrumb navigation, reload, missing-screen fallback, local project restore, responsive');
}finally{await browser.close();}
