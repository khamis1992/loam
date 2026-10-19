import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const taskId=process.argv[2];
assert.ok(taskId && /^task_[a-zA-Z0-9]+$/.test(taskId));
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.route('**/*',route=>['GET','HEAD'].includes(route.request().method())?route.continue():route.abort());
  await page.goto('http://127.0.0.1:3939/#/tasks/'+taskId,{waitUntil:'domcontentloaded'});
  await page.locator('#activityTab').waitFor({state:'visible',timeout:15000});
  await page.locator('#overviewTab').click();
  await page.locator('#taskVerification').waitFor({state:'visible',timeout:15000});
  await page.waitForFunction("document.getElementById('taskVerification')?.textContent?.includes('لم يُعتمد اكتمال المهمة بعد')",{},{timeout:15000});
  const text=await page.locator('#taskVerification').innerText();
  assert.match(text,/جارٍ/);
  const screenshot='output/verification/bot-verification-progress-live.png';
  await page.screenshot({path:screenshot,fullPage:true});
  fs.writeFileSync('docs/evidence/bot-verification-progress-live.json',JSON.stringify({at:new Date().toISOString(),taskId,text,screenshot,pass:true,readOnlyBrowser:true},null,2));
  console.log('PASS installed browser displays pending verification without claiming success: '+text);
} finally { await browser.close(); }
