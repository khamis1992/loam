import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage();await page.route('http://updates.test/**',async route=>route.fulfill({contentType:'text/javascript',body:await fs.readFile('ui/app-updates.js','utf8')}));
 await page.setContent('<div id="serviceLinks"></div>');
 await page.evaluate(async()=>{location.hash='/services';window.value={state:'idle',currentVersion:'0.5.23',localChannel:true};window.installCount=0;window.allowConfirm=false;window.loam={updates:{status:async()=>window.value,check:async()=>window.value={...window.value,state:'checking'},install:async()=>{window.installCount++;if(window.installBlocked)throw Error('انتظر انتهاء المهام الجارية قبل تثبيت التحديث.');}}};const {mountAppUpdates}=await import('http://updates.test/app-updates.js');mountAppUpdates({confirm:async()=>window.allowConfirm});});
 assert.match(await page.locator('[data-update-version]').innerText(),/0.5.23/);await page.locator('[data-update-check]').click();assert.equal(await page.locator('[data-update-check]').isDisabled(),true);
 await page.evaluate(()=>{window.value={...window.value,state:'current',version:'0.5.23',checkedAt:new Date().toISOString()};});await page.waitForFunction(()=>document.querySelector('[data-update-status]').textContent.includes('محليًا'));assert.match(await page.locator('[data-update-help]').innerText(),/الإصدار المنشور: 0.5.23/);assert.match(await page.locator('[data-update-help]').innerText(),/آخر فحص/);
 await page.evaluate(()=>{window.value.state='channel-mismatch';window.value.version='0.5.22';});await page.waitForFunction(()=>document.querySelector('[data-update-status]').textContent.includes('مختلفًا'));assert.equal(await page.locator('[data-update-check]').isDisabled(),false);
 await page.evaluate(()=>{window.value.state='error';});await page.waitForFunction(()=>document.querySelector('[data-update-status]').textContent.includes('تعذّر'));
 await page.evaluate(()=>{window.value.state='downloading';window.value.percent=43;});await page.waitForFunction(()=>document.querySelector('progress').value===43);
 assert.equal(await page.locator('[data-update-install]').isVisible(),false);
 await page.evaluate(()=>{window.value.state='downloaded';window.value.version='0.5.24';});await page.locator('[data-update-install]').waitFor({state:'visible'});
 await page.locator('[data-update-install]').click();assert.equal(await page.evaluate(()=>window.installCount),0);
 await page.evaluate(()=>{window.allowConfirm=true;window.installBlocked=true;});await page.locator('[data-update-install]').click();assert.match(await page.locator('[data-update-status]').innerText(),/انتظر انتهاء/);assert.equal(await page.locator('[data-update-install]').isDisabled(),false);
 await page.evaluate(()=>window.installBlocked=false);await page.locator('[data-update-install]').click();assert.match(await page.locator('[data-update-status]').innerText(),/إعادة تشغيل/);
 console.log('PASS update UI version, checking, progress, install visibility, cancellation, active-task error recovery and explicit install');
}finally{await browser.close();}
