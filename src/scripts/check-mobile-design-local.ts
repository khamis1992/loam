import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildMobile} from '../mobile/build.js';
import {saveMobile,readMobile} from '../mobile/store.js';
import {OllamaClient,type ChatOptions} from '../ollama.js';
import {mobileHtml} from '../mobile/export.js';
import {chromium} from 'playwright';
const dir='release/mobile-live/design-system',root=fs.mkdtempSync(path.join(os.tmpdir(),'mobile-local-design-'));fs.mkdirSync(dir,{recursive:true});
const initial=saveMobile(root,{version:1,title:'دفتر الإنجاز',accent:'#267965',direction:'rtl',screens:[{id:'home',title:'الرئيسية',kind:'primary',blocks:[]}]},0);
const actual=new OllamaClient('http://127.0.0.1:11434');let calls=0;const events:Record<string,unknown>[]=[];
await buildMobile({root,model:'qwen2.5:14b',expectedRevision:initial.revision,brief:'ابن تطبيق دفتر الإنجاز لتنظيم المهام من صفحتين بالضبط. قسم رئيسي home بعنوان يومي مع زر open_task يفتح الصفحة task. صفحة فرعية task بعنوان مهمتي وأبوها home: حقل input_note لتفاصيل المهمة مع شرح ومثال، مفتاح done_task لتأكيد تنفيذ المهمة، وزر save_task بعنوان حفظ تفاصيل المهمة بدون target. صمم نصوصا قصيرة ومحددة بالعربية لكل صفحة. لا تضف أي صفحات أو حقول أخرى.',signal:AbortSignal.timeout(240000),emit:e=>{events.push(e);console.log(JSON.stringify(e.type==='done'?{type:e.type,attempt:e.attempt}:e));},ollama:{chat:async(o:ChatOptions)=>{assert.match(o.messages[0]!.content,/Design contract v1: productivity/);calls++;return actual.chat(o);}}});
const project=readMobile(root)!;assert.equal(project.designSystem?.profile,'productivity');assert.equal(project.screens.length,2);fs.writeFileSync(dir+'/local-model.json',JSON.stringify({project,calls,events},null,2));
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.route('http://127.0.0.1:3941/design-local-test',r=>r.fulfill({contentType:'text/html',body:mobileHtml(project,'local-design-test')}));await page.goto('http://127.0.0.1:3941/design-local-test');
 await page.locator('[data-block-id="open_task"]').click();assert.equal(await page.locator('h1').innerText(),'مهمتي');await page.locator('[data-block-id="input_note"] input').fill('مراجعة خطة المشروع');await page.locator('[data-block-id="done_task"] input').check();await page.locator('[data-block-id="save_task"]').click();assert.match(await page.locator('output').innerText(),/تم حفظ/);await page.getByRole('button',{name:'رجوع',exact:true}).click();assert.equal(await page.locator('h1').innerText(),'يومي');await page.reload();await page.locator('[data-block-id="open_task"]').click();assert.equal(await page.locator('[data-block-id="input_note"] input').inputValue(),'مراجعة خطة المشروع');assert.equal(await page.locator('[data-block-id="done_task"] input').isChecked(),true);assert.deepEqual(errors,[]);
 console.log('PASS real qwen2.5:14b: design contract received, profile persisted, two screens, navigation, back, save and reload; calls='+calls);
}finally{await browser.close();}
