import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:900,height:800}});
 await page.route('http://pictures.test/**',async r=>r.fulfill({contentType:'text/javascript',body:await fs.readFile('ui/studio-source-pictures.js','utf8')}));
 await page.setContent('<main><div class="office-slide" style="position:relative;width:600px;height:400px"></div></main>');
 await page.evaluate(async()=>{const m=await import('http://pictures.test/module.js');window.state={owner:{},slide:{sourcePictures:[{x:10,y:20,w:25,h:30}]}};window.commits=0;document.querySelector('.office-slide').innerHTML=m.sourcePictureTargets(window.state.slide);const frame=document.querySelector('[data-source-picture-frame]');frame.style.position='absolute';m.bindSourcePictureGestures(document.querySelector('main'),()=>window.state,()=>window.commits++);});
 const handle=page.locator('[data-source-picture-drag]');
 const start=async()=>{const b=await handle.boundingBox();await page.mouse.move(b.x+3,b.y+3);await page.mouse.down();await page.mouse.move(850,750,{steps:5});};
 await start();await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await page.evaluate(()=>window.commits),0);
 await start();await page.mouse.up();assert.deepEqual(await page.evaluate(()=>window.state.slide.sourcePictures[0]),{x:75,y:70,w:25,h:30});assert.equal(await page.evaluate(()=>window.commits),1);
 await handle.press('ArrowLeft');assert.equal(await page.evaluate(()=>window.state.slide.sourcePictures[0].x),74.5);
 await page.evaluate(async()=>{window.state.slide.sourcePictures[0]={x:10,y:20,w:25,h:30};const m=await import('http://pictures.test/module.js');document.querySelector('.office-slide').innerHTML=m.sourcePictureTargets(window.state.slide);});
 const resize=page.locator('[data-source-picture-resize]'),b=await resize.boundingBox();await page.mouse.move(b.x+3,b.y+3);await page.mouse.down();await page.mouse.move(850,750,{steps:5});await page.mouse.up();
 const resized=await page.evaluate(()=>window.state.slide.sourcePictures[0]);assert.ok(Math.abs(resized.w/resized.h-25/30)<.000001);assert.equal(resized.h,80);assert.ok(resized.x+resized.w<=100);assert.equal(await page.evaluate(()=>window.commits),3);
 await start();await page.evaluate(()=>window.state={owner:{},slide:{sourcePictures:[{x:0,y:0,w:20,h:20}]}});await page.mouse.up();assert.equal(await page.evaluate(()=>window.commits),3);assert.equal(await page.evaluate(()=>window.state.slide.sourcePictures[0].x),0);
 console.log('PASS source picture drag bounds, Escape cancellation, keyboard movement and changed-owner rejection');
}finally{await browser.close();}
