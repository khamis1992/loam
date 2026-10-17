import {chromium} from 'playwright';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root=resolve('docs/mockups/workspaces');
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1512,height:1100},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 for(const mode of ['mobile','office','security','creative','swarm']){
  await page.goto(pathToFileURL(root+'/index.html').href+'#'+mode);await page.locator('h1').waitFor();
  await page.screenshot({path:root+'/'+mode+'.png',fullPage:true});
  for(const tab of [1,2,0]){await page.locator('[data-tab="'+tab+'"]').click();assert.equal(await page.locator('[role=tab][aria-selected=true]').count(),1);}
  await page.locator('[data-action=main]').click();await page.locator('dialog').waitFor();await page.locator('dialog button').click();
  if(mode==='mobile'){await page.locator('[data-screen="السلة"]').click();assert.match(await page.locator('.phone').innerText(),/سلّتك/);await page.locator('[data-platform=Android]').click();}
  if(mode==='office'){await page.locator('[data-file=excel]').click();assert.equal(await page.locator('table tbody tr').count(),4);await page.locator('[data-file=slides]').click();await page.locator('.slide').waitFor();}
  if(mode==='creative'){await page.locator('[data-render=wire]').click();assert.equal(await page.locator('.viewport.wire').count(),1);await page.locator('[data-color]').first().click();await page.locator('[data-action=play]').click();assert.match(await page.locator('#timecode').innerText(),/00:06/);}
  await page.locator('#prompt').fill('اختبار رسالة في الموك');await page.locator('.send').click();assert.match(await page.locator('#chat').innerText(),/اختبار رسالة/);
  for(const width of [390,768]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,mode+' overflow '+width);}
  await page.setViewportSize({width:1512,height:1100});
 }
 assert.deepEqual(errors,[]);console.log('PASS: five pages, 15 tabs, mobile screens/platforms, office formats, creative controls, dialogs, composer, 390/768 responsive layouts; no browser errors.');
} finally {await browser.close();}

