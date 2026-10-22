import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const base='http://127.0.0.1:3939',out='output/word-inline-preview';
const identity=await (await fetch(base+'/api/identity')).json();assert.equal(identity.version,'0.5.11');
const {task}=await (await fetch(base+'/api/tasks/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'write',title:'التعديل داخل معاينة Word — اختبار النسخة 0.5.11'})})).json();
const imported=await fetch(base+'/api/studio/import?taskId='+task.id+'&name=complex-inline.docx&expectedRevision=0',{method:'POST',headers:{'content-type':'application/octet-stream'},body:await fs.readFile('output/word-native-preview/complex-source.docx')});assert.ok(imported.ok,await imported.clone().text());
await fs.writeFile(out+'/installed-task.json',JSON.stringify({taskId:task.id,version:identity.version},null,2));
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1600,height:1100}});await page.goto(base+'/#/tasks/'+task.id);await page.locator('[data-action=read-document]').click();const frame=()=>page.frameLocator('iframe.office-file-preview');
 const ready=async()=>{await frame().locator('.word-page').first().waitFor({timeout:90000});await frame().locator('#status').waitFor({state:'hidden',timeout:90000});};await ready();assert.equal(await frame().locator('.word-page').count(),5);
 let revision=1;const commit=async()=>{await frame().locator('[data-commit]').click();revision++;await page.locator('[data-status]').filter({hasText:'الإصدار '+revision}).waitFor({timeout:90000});await ready();};
 const change=async(target,value)=>{await frame().locator(`[data-target="${target}"]`).first().click();await frame().locator('[data-inline-text]').fill(value);await commit();};
 await change('0/text','Annual report — edited inside the installed preview');
 await change('2/stat/0/value','99%');
 await change('4/cell/23/2','Verified inline');
 await frame().locator('[data-target="8/image"]').click();await frame().locator('[data-replace-image]').setInputFiles('output/word-original-edit/replacement.png');await commit();
 await frame().locator('[data-target="6/text"]').click();await frame().locator('[data-insert-before]').click();await frame().locator('[data-inline-text]').fill('Inserted directly before the landscape dashboard.');await commit();
 const {artifact}=await (await fetch(base+'/api/studio?taskId='+task.id)).json();assert.equal(artifact.revision,6);assert.equal(artifact.content.blocks[2].items[0].value,'99%');assert.equal(artifact.content.blocks[4].rows[23][2],'Verified inline');
 // Invalid merged-grid changes must be rejected before they can replace the saved document.
 const invalid=structuredClone(artifact);const merged=invalid.content.blocks.find(b=>b.type==='table'&&b!==invalid.content.blocks[4]&&b.rows.length<10);assert.ok(merged);merged.columns.push('Invalid added column');merged.rows.forEach(row=>row.push(''));
 const rejected=await fetch(base+'/api/studio',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId:task.id,artifact:invalid,expectedRevision:6,validateExport:true})});assert.ok(!rejected.ok,'merged-grid edit must fail');assert.equal((await (await fetch(base+'/api/studio?taskId='+task.id)).json()).artifact.revision,6);
 for(const [endpoint,ext] of [['export','docx'],['preview','pdf']]){const response=await fetch(base+'/api/studio/'+endpoint+'?taskId='+task.id);assert.ok(response.ok);await fs.writeFile(out+'/installed-edited.'+ext,Buffer.from(await response.arrayBuffer()));}
 for(let i=0;i<await frame().locator('canvas').count();i++){const data=await frame().locator('canvas').nth(i).evaluate(e=>e.toDataURL());await fs.writeFile(`${out}/installed-page-${i+1}.png`,Buffer.from(data.split(',')[1],'base64'));}
 await frame().locator('[data-target="2/stat/0/value"]').first().click();await page.screenshot({path:out+'/installed-inline-editor.png'});await frame().locator('[data-cancel]').last().click();
 await fs.writeFile(out+'/installed-test.json',JSON.stringify({version:identity.version,taskId:task.id,revision,pages:5,edited:['text','card','table','image'],insertion:true,invalidMergedEditRejected:rejected.status},null,2));console.log('PASS installed 0.5.11 inline editing, insertion, five Word pages, merged-grid preflight; task '+task.id);
}finally{await browser.close();}
