import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {_electron} from 'playwright';

const expected=JSON.parse(await fs.readFile('package.json','utf8')).version;
const origin=process.env.LOAM_TEST_ORIGIN||'http://127.0.0.1:3939';
const label=process.env.LOAM_TEST_LABEL||'installed';
const electronApp=await _electron.launch({executablePath:process.env.LOAM_TEST_EXECUTABLE||path.join(process.env.LOCALAPPDATA,'Programs/loam/Loam.exe'),env:{...process.env},timeout:150000});
try{
 const page=await electronApp.firstWindow();
 await page.goto(origin+'/#/services');
 await page.waitForFunction(()=>!!window.loam?.updates);
 await page.evaluate(()=>window.loam.updates.check());
 await page.waitForFunction(async()=>['current','error','channel-mismatch'].includes((await window.loam.updates.status()).state),{},{timeout:30000});
 const status=await page.evaluate(()=>window.loam.updates.status());
 assert.equal(status.currentVersion,expected);assert.equal(status.version,expected);assert.equal(status.state,'current');assert.equal(status.localChannel,true);assert.ok(status.checkedAt);
 await page.waitForFunction(()=>document.querySelector('[data-update-help]')?.textContent.includes('الإصدار المنشور:'));
 await page.locator('.app-updates').scrollIntoViewIfNeeded();
 await page.screenshot({path:`output/verification/app-update/${label}-current.png`});
 await fs.writeFile(`output/verification/app-update/${label}-status.json`,JSON.stringify(status,null,2));
 console.log('PASS installed current state, installed/published versions, local source and successful check timestamp');
}finally{
 let safeToClose=false;
 try{const tasks=await(await fetch(origin+'/api/tasks',{signal:AbortSignal.timeout(3000)})).json();safeToClose=!tasks.tasks.some(t=>['running','queued','pending'].includes(t.status));}catch{}
 if(safeToClose)await electronApp.close();
}
