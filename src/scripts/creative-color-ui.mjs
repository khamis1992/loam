import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {validateColor,colorFilter} from '../../ui/creative-color.js';
export async function checkColorUI(page){
 for(const value of [null,[],{saturation:NaN},{hue:181},{brightness:-1},{enabled:1},{unknown:1}])assert.throws(()=>validateColor({kind:'image',colorAdjust:value}));
 assert.equal(colorFilter({}),'none');assert.equal(colorFilter({colorAdjust:{enabled:false}}),'none');
 const idle=()=>page.waitForFunction(()=>!document.querySelector('.creative-timeline-editor fieldset').disabled);
 const download=async selector=>{const pending=page.waitForEvent('download');await page.locator(selector).click();const file=await pending;await idle();return fs.readFileSync(await file.path());};
 const baseline=await download('[data-tl-download]');
 const pixel=()=>page.locator('.creative-timeline-editor canvas[aria-label]').evaluate(c=>Array.from(c.getContext('2d').getImageData(100,100,1,1).data));
 const field=async(key,value)=>{await page.locator(`[data-color-field=${key}]`).fill(String(value));await page.locator(`[data-color-field=${key}]`).press('Tab');await idle();};
 try{
 await page.locator('[data-clip]').filter({hasText:'red.png'}).click();await page.locator('[data-tl-seek]').fill('1.8');await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();const original=await pixel();
 for(const [key,value]of [['brightness',.5],['contrast',.5],['saturation',0],['hue',90]]){await field(key,value);assert.notDeepEqual(await pixel(),original,key+' affects preview');await page.locator('[data-color-reset]').click();await idle();assert.deepEqual(await pixel(),original,'reset restores source');}
 await field('saturation',0);await field('brightness',.7);const preview=await pixel();assert.ok(Math.max(...preview.slice(0,3))-Math.min(...preview.slice(0,3))<=1,'neutral monochrome');
 await page.locator('[data-color-enabled]').uncheck();await idle();assert.deepEqual(await pixel(),original,'bypass');await page.locator('[data-tl-undo]').click();await idle();assert.deepEqual(await pixel(),preview,'undo bypass');
 const edited=await download('[data-tl-download]');assert.equal(JSON.parse(edited).clips.find(c=>c.name==='red.png').colorAdjust.saturation,0);
 const saveResponse=page.waitForResponse(r=>r.url().includes('/api/timeline/project?')&&r.status()===201);await page.locator('[data-tl-save]').click();const saved=await(await saveResponse).json();await idle();await page.locator('[data-tl-list]').click();await idle();await page.locator('[data-tl-saved]').selectOption(saved.path);await idle();
 await page.locator('[data-tl-project]').setInputFiles({name:'color.json',mimeType:'application/json',buffer:edited});await idle();await page.locator('[data-tl-seek]').fill('1.8');await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();assert.deepEqual(await pixel(),preview,'JSON roundtrip');
 const before=await page.locator('[data-job]').count();await page.locator('[data-tl-export]').click();await idle();await page.waitForFunction(n=>document.querySelectorAll('[data-job]').length>n,before);await page.waitForFunction(()=>{const row=[...document.querySelectorAll('[data-job]')].at(-1);if(row.dataset.state==='failed')throw Error(row.textContent);return row.dataset.state==='done';},{},{timeout:120000});
 const result=await download('[data-job]:last-child [data-job-download]'),file='output/verification/creative-color.mp4';fs.writeFileSync(file,result);const bytes=execFileSync('node_modules/ffmpeg-static/ffmpeg.exe',['-v','error','-ss','1.8','-i',file,'-frames:v','1','-vf','crop=2:2:100:100','-pix_fmt','rgb24','-f','rawvideo','-'],{windowsHide:true});const exported=[...bytes.subarray(0,3)];assert.ok(exported.every((v,i)=>Math.abs(v-preview[i])<=4),'export matches color preview '+JSON.stringify({preview,exported}));fs.writeFileSync('output/verification/creative-color.json',JSON.stringify({preview,exported,save:saved.path},null,2));console.log('PASS color UI: all controls, reset/bypass/undo, save/open/JSON, exported pixels match preview');
 }finally{await page.locator('[data-tl-project]').setInputFiles({name:'baseline.json',mimeType:'application/json',buffer:baseline});await idle();}
}
