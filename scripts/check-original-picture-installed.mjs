import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import {chromium} from 'playwright';
const base='http://127.0.0.1:3939',version=JSON.parse(await fs.readFile('package.json','utf8')).version,out=`output/office-frontier/${version}`;
await fs.mkdir(out,{recursive:true});assert.equal((await(await fetch(base+'/api/identity')).json()).version,version);
const {task}=await(await fetch(base+'/api/tasks/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'write',title:'تحريك صور PowerPoint الأصلية — '+version})})).json();
const source=await fs.readFile('output/office-frontier/original-picture-edited.pptx');const imported=await fetch(base+'/api/studio/import?taskId='+task.id+'&name=original-picture.pptx&expectedRevision=0',{method:'POST',body:source});assert.ok(imported.ok,await imported.clone().text());
const read=async()=>(await(await fetch(base+'/api/studio?taskId='+task.id)).json()).artifact;
const original=await read(),beforePicture=original.content.slides[0].sourcePictures[0];
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1050}});await page.goto(base+'/#/tasks/'+task.id);await page.locator('.office-native-ready').waitFor({timeout:120000});await page.locator('[data-expand-workspace]').click();
 const ready=()=>page.locator('.office-native-status').filter({hasText:'تتجدد بعد الحفظ'}).waitFor({timeout:120000});
 const save=async revision=>{await page.locator('[data-action=save]').click();await page.locator('[data-status]').filter({hasText:'الإصدار '+revision}).waitFor({timeout:30000});await ready();};await ready();
 const drag=async(selector,dx,dy,cancel=false)=>{const h=page.locator(selector);await h.scrollIntoViewIfNeeded();const b=await h.boundingBox();await page.mouse.move(b.x+5,b.y+5);await page.mouse.down();await page.mouse.move(b.x+5+dx,b.y+5+dy,{steps:6});if(cancel)await page.keyboard.press('Escape');await page.mouse.up();};
 await drag('[data-source-picture-drag]',-40,20,true);assert.equal((await read()).revision,1);assert.equal(await page.locator('.office-source-picture.dragging').count(),0);
 await drag('[data-source-picture-drag]',-40,20);await save(2);const moved=(await read()).content.slides[0].sourcePictures[0];assert.ok(moved.x<beforePicture.x);assert.ok(moved.y>beforePicture.y);
 await drag('[data-source-picture-resize]',-35,-20,true);assert.equal((await read()).revision,2);
 await drag('[data-source-picture-resize]',-35,-20);await save(3);const final=await read(),picture=final.content.slides[0].sourcePictures[0];assert.ok(picture.w<moved.w);assert.ok(Math.abs(picture.w/picture.h-beforePicture.w/beforePicture.h)<1e-8);
 await page.locator('summary').filter({hasText:'الصورة الأصلية'}).click();
 for(const input of await page.locator('[data-source-picture][type=number]').all()){const box=await input.boundingBox();assert.ok(box.width>=100);assert.equal(await input.evaluate(e=>getComputedStyle(e).direction),'ltr');}
 await page.screenshot({path:out+'/installed-original-picture.png'});
 const response=await fetch(base+'/api/studio/export?taskId='+task.id);assert.ok(response.ok);const bytes=Buffer.from(await response.arrayBuffer());await fs.writeFile(out+'/installed-original-picture.pptx',bytes);
 const before=await JSZip.loadAsync(source),after=await JSZip.loadAsync(bytes),parse=s=>new DOMParser().parseFromString(s,'application/xml'),first=(n,name)=>n.getElementsByTagNameNS('*',name)[0],serialize=n=>new XMLSerializer().serializeToString(n);
 const b=first(parse(await before.file('ppt/slides/slide1.xml').async('string')),'pic'),a=first(parse(await after.file('ppt/slides/slide1.xml').async('string')),'pic'),bx=first(b,'xfrm'),ax=first(a,'xfrm'),size=first(parse(await after.file('ppt/presentation.xml').async('string')),'sldSz');
 assert.equal(serialize(first(a,'blipFill')),serialize(first(b,'blipFill')));assert.equal(ax.getAttribute('rot'),bx.getAttribute('rot'));assert.equal(ax.getAttribute('flipH'),bx.getAttribute('flipH'));
 for(const [key,node,attr,sizeAttr]of [['x','off','x','cx'],['y','off','y','cy'],['w','ext','cx','cx'],['h','ext','cy','cy']])assert.equal(Number(first(ax,node).getAttribute(attr)),Math.round(Number(size.getAttribute(sizeAttr))*picture[key]/100));
 let preserved=0;for(const name of Object.keys(before.files)){if(before.files[name].dir||['ppt/slides/slide1.xml','ppt/presentation.xml'].includes(name))continue;assert.deepEqual(await before.file(name).async('nodebuffer'),await after.file(name).async('nodebuffer'));preserved++;}
 const preview=await fetch(base+'/api/studio/slide-preview?taskId='+task.id+'&revision=3&slide=0');assert.ok(preview.ok);await fs.writeFile(out+'/installed-original-picture-native.png',Buffer.from(await preview.arrayBuffer()));
 await fs.writeFile(out+'/installed-original-picture-result.json',JSON.stringify({version,taskId:task.id,revision:3,drag:true,resize:true,cancellation:true,nativeGeometry:true,preservedParts:preserved,preservedCropAndTransforms:true},null,2));console.log('PASS installed original picture drag, proportional resize, cancellation, native geometry and supporting parts');
}finally{await browser.close();}
