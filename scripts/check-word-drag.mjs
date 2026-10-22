import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:900,height:800}});
 await page.route('http://drag.test/**',async route=>route.fulfill({contentType:'text/javascript',body:await fs.readFile('ui/office-preview-caret.js','utf8')}));
 await page.setContent('<input aria-label=outside><iframe></iframe>');const frame=page.frames()[1];await frame.setContent('<section style="position:relative;width:600px;height:600px" data-point-width="600" data-point-height="600"><canvas width="1200" height="1200" style="width:600px;height:600px"></canvas></section>');
 await page.evaluate(()=>{window.commits=[];window.addEventListener('message',e=>{if(e.data.type==='loam-preview-commit')window.commits.push(e.data);});});
 await frame.evaluate(async()=>{const {attachDrag}=await import('http://drag.test/caret.js');attachDrag({revision:1,content:{blocks:[{type:'image',position:{x:60,y:60,width:120}}]}},0,document.querySelector('section'),{left:10,top:10,width:20,height:20},()=>false,()=>{});});
 await frame.evaluate(()=>{const ctx=document.querySelector('canvas').getContext('2d');ctx.fillStyle='#16805c';ctx.fillRect(120,120,240,240);});
 const handle=frame.locator('[data-drag-index]'),box=await handle.boundingBox();
 const start=async()=>{await page.mouse.move(box.x+5,box.y+5);await page.mouse.down();await page.mouse.move(850,750,{steps:4});};
 await start();
 const pixel=await frame.locator('.word-drag-ghost canvas').evaluate(c=>Array.from(c.getContext('2d').getImageData(60,60,1,1).data));assert.deepEqual(pixel,[22,128,92,255]);
 const ghost=await frame.locator('.word-drag-ghost').boundingBox();const section=await frame.locator('section').boundingBox();assert.ok(ghost.x+ghost.width<=section.x+section.width+1);assert.ok(ghost.y+ghost.height<=section.y+section.height+1);
 await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await frame.locator('.word-drag-ghost').count(),0);assert.equal(await page.evaluate(()=>window.commits.length),0);
 await handle.press('ArrowRight');await handle.press('Shift+ArrowDown');assert.equal(await frame.locator('.word-drag-ghost').count(),1);await handle.press('Escape');assert.equal(await frame.locator('.word-drag-ghost').count(),0);assert.equal(await page.evaluate(()=>window.commits.length),0);
 await handle.press('ArrowRight');await page.getByRole('textbox',{name:'outside'}).focus();assert.equal(await frame.locator('.word-drag-ghost').count(),0);assert.equal(await page.evaluate(()=>window.commits.length),0);
 await start();await page.mouse.up();await page.waitForFunction(()=>window.commits.length===1);const operation=await page.evaluate(()=>window.commits[0].operation);assert.deepEqual(operation.block.position,{x:480,y:480,width:120});
 await handle.evaluate(e=>e.disabled=false);await handle.press('ArrowRight');await handle.press('Shift+ArrowDown');await handle.press('Enter');await page.waitForFunction(()=>window.commits.length===2);assert.deepEqual(await page.evaluate(()=>window.commits[1].operation.block.position),{x:61,y:70,width:120});
 console.log('PASS bounded drag preview, Escape cancellation, subsequent drag and persisted coordinates');
}finally{await browser.close();}
