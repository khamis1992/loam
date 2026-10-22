import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import {chromium} from 'playwright';
const base='http://127.0.0.1:3939',version=JSON.parse(await fs.readFile('package.json','utf8')).version,out=`output/office-frontier/${version}`;
await fs.mkdir(out,{recursive:true});assert.equal((await(await fetch(base+'/api/identity')).json()).version,version);
const {task}=await(await fetch(base+'/api/tasks/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'write',title:'استبدال الصورة الأصلية في PowerPoint — '+version})})).json();
const source=await fs.readFile('output/office-frontier/picture-replace-source.pptx');
const response=await fetch(base+'/api/studio/import?taskId='+task.id+'&name=shared-pictures.pptx&expectedRevision=0',{method:'POST',body:source});assert.ok(response.ok,await response.clone().text());
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1050}});await page.goto(base+'/#/tasks/'+task.id);await page.locator('.office-native-ready').waitFor({timeout:120000});await page.locator('[data-expand-workspace]').click();
 await page.locator('summary').filter({hasText:'الصورة الأصلية 1'}).click();
 await page.locator('[data-source-picture-file="0"]').setInputFiles('output/office-frontier/picture-replacement.png');await page.locator('[data-status]').filter({hasText:'تم استبدال الصورة'}).waitFor();
 await page.locator('[data-action=save]').click();await page.locator('[data-status]').filter({hasText:'الإصدار 2'}).waitFor();await page.locator('.office-native-status').filter({hasText:'تتجدد بعد الحفظ'}).waitFor({timeout:120000});
 await page.locator('summary').filter({hasText:'الصورة الأصلية 1'}).click();
 const cropField=key=>page.locator(`[data-source-picture="0"][data-picture-prop="${key}"]`);
 assert.equal(Number(await cropField('cropLeft').inputValue()),10);await cropField('cropLeft').fill('95');await cropField('cropLeft').press('Tab');assert.equal(Number(await cropField('cropLeft').inputValue()),10);
 for(const [key,value]of [['cropLeft','22.125'],['cropRight','12.25'],['cropTop','8'],['cropBottom','14']]){await cropField(key).fill(value);await cropField(key).press('Tab');}
 await page.locator('[data-action=save]').click();await page.locator('[data-status]').filter({hasText:'الإصدار 3'}).waitFor();await page.locator('.office-native-status').filter({hasText:'تتجدد بعد الحفظ'}).waitFor({timeout:120000});
 await page.screenshot({path:out+'/installed-picture-replacement.png'});
 const exported=await fetch(base+'/api/studio/export?taskId='+task.id);assert.ok(exported.ok);const bytes=Buffer.from(await exported.arrayBuffer());await fs.writeFile(out+'/installed-picture-replacement.pptx',bytes);
 const before=await JSZip.loadAsync(source),after=await JSZip.loadAsync(bytes),parse=s=>new DOMParser().parseFromString(s,'application/xml'),all=(n,name)=>[...n.getElementsByTagNameNS('*',name)],first=(n,name)=>all(n,name)[0],serialize=n=>new XMLSerializer().serializeToString(n);
 const b=all(parse(await before.file('ppt/slides/slide1.xml').async('string')),'pic'),a=all(parse(await after.file('ppt/slides/slide1.xml').async('string')),'pic');
 assert.equal(a.length,2);assert.equal(serialize(a[1]),serialize(b[1]));assert.equal(serialize(first(a[0],'spPr')),serialize(first(b[0],'spPr')));for(const [edge,value]of [['l','22125'],['r','12250'],['t','8000'],['b','14000']])assert.equal(first(a[0],'srcRect').getAttribute(edge),value);assert.notEqual(first(a[0],'blip').getAttribute('r:embed'),first(b[0],'blip').getAttribute('r:embed'));
 let preserved=0;for(const name of Object.keys(before.files)){if(before.files[name].dir||['ppt/slides/slide1.xml','ppt/slides/_rels/slide1.xml.rels','ppt/presentation.xml','[Content_Types].xml'].includes(name))continue;assert.deepEqual(await after.file(name).async('nodebuffer'),await before.file(name).async('nodebuffer'));preserved++;}
 const preview=await fetch(base+'/api/studio/slide-preview?taskId='+task.id+'&revision=3&slide=0');assert.ok(preview.ok);await fs.writeFile(out+'/installed-picture-replacement-native.png',Buffer.from(await preview.arrayBuffer()));
 await fs.writeFile(out+'/installed-picture-replacement-result.json',JSON.stringify({version,taskId:task.id,revision:3,replacement:true,cropEditing:true,invalidCropRecovery:true,sharedImageUnchanged:true,frameAndTransformsPreserved:true,preservedParts:preserved},null,2));console.log('PASS installed picture replacement/crop editing, invalid-crop recovery, shared-image isolation, native frame/transforms and preserved parts');
}finally{await browser.close();}
