import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {_electron} from 'playwright';
const out=path.resolve('output/verification/app-update');await fs.mkdir(out,{recursive:true});
const expected=JSON.parse(await fs.readFile('package.json','utf8')).version;
const executablePath=path.join(process.env.LOCALAPPDATA,'Programs/loam/Loam.exe');
const electronApp=await _electron.launch({executablePath,args:[],timeout:150000});
let installRequested=false;
try{
 const page=await electronApp.firstWindow();page.setDefaultTimeout(150000);
 await page.waitForFunction(()=>!!window.loam?.updates);
 await page.goto('http://127.0.0.1:3939/#/services');
 await page.locator('.app-updates').waitFor();
 const initial=await page.evaluate(()=>window.loam.updates.status());console.log('Initial installed update status:',JSON.stringify(initial));
 const beforeIdentity=await (await fetch('http://127.0.0.1:3939/api/identity')).json();
 const beforeTasks=await (await fetch('http://127.0.0.1:3939/api/tasks')).json();
 assert.notEqual(initial.currentVersion,expected,'Run this test on the previous version after bootstrapping update UI');
 // The boot check may already be downloading when the settings page opens.
 if(!['checking','available','downloading','downloaded'].includes(initial.state))await page.locator('[data-update-check]').click();
 await page.locator('[data-update-install]').waitFor({state:'visible',timeout:240000});
 const ready=await page.evaluate(()=>window.loam.updates.status());assert.equal(ready.version,expected);assert.equal(ready.state,'downloaded');
 await page.locator('.app-updates').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'ready-to-install.png')});
 await page.locator('[data-update-install]').click();await page.locator('#confirmDialog').waitFor();
 await page.locator('#confirmDialog [value=cancel]').click();assert.equal((await page.evaluate(()=>window.loam.updates.status())).state,'downloaded');
 await page.locator('[data-update-install]').click();await page.locator('#confirmDialog [value=confirm]').click();installRequested=true;
 const deadline=Date.now()+180000;let identity;
 while(Date.now()<deadline){try{const response=await fetch('http://127.0.0.1:3939/api/identity',{signal:AbortSignal.timeout(2000)});const data=await response.json();if(data.version===expected){identity=data;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,1000));}
 assert.ok(identity,'Updated installed backend did not become ready');
 assert.equal(identity.profileId,beforeIdentity.profileId);
 const afterTasks=await (await fetch('http://127.0.0.1:3939/api/tasks')).json();
 for(const task of beforeTasks.tasks)assert.ok(afterTasks.tasks.some(after=>after.id===task.id),'Missing task '+task.id);
 const installed=JSON.parse(await fs.readFile(path.join(path.dirname(executablePath),'resources/app/package.json'),'utf8'));assert.equal(installed.version,expected);
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify({from:initial.currentVersion,to:expected,downloadedVersion:ready.version,cancellationVerified:true,installedVersion:installed.version,profileId:identity.profileId,tasksPreserved:beforeTasks.tasks.length},null,2));
 console.log('PASS installed UI downloaded, cancelled then confirmed, installed and restarted '+expected);
}finally{
 if(!installRequested){
  // A person can start a task while this interactive test is running.
  // Never terminate that work during test failure cleanup.
  let safeToClose=false;
  try{const tasks=await(await fetch('http://127.0.0.1:3939/api/tasks',{signal:AbortSignal.timeout(3000)})).json();safeToClose=!tasks.tasks.some(t=>['running','queued','pending'].includes(t.status));}catch{}
  if(safeToClose)await electronApp.close();
 }
}
