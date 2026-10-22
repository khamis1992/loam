import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import JSZip from 'jszip';
import {transform} from 'esbuild';
import {DESIGN_PROFILES,resolveMobileDesign,contrast,readableInk,chooseDesignProfile} from '../../ui/mobile-design.js';
import {validateProject,saveMobile,travelMobile,type MobileProject} from '../mobile/store.js';
import {mobileHtml,exportMobile} from '../mobile/export.js';
import {buildMobile} from '../mobile/build.js';
const dir='release/mobile-live/design-system';fs.mkdirSync(dir,{recursive:true});
const base='http://127.0.0.1:3941',task='task_mvdb5dyx6cb1a5e47e9a';
const original=((await(await fetch(base+'/api/mobile?taskId='+task)).json()) as {project:MobileProject}).project;
const project={...original,designSystem:{version:1 as const,profile:'productivity'},accent:DESIGN_PROFILES.productivity!.tokens.primary!};
assert.equal(chooseDesignProfile('رفيق الإنجاز تطبيق تنظيم المهام'),'productivity');
for(const profile of Object.keys(DESIGN_PROFILES)){
 const d=resolveMobileDesign({...project,designSystem:{version:1,profile}})!;
 for(const [bg,ink]of [['background','foreground'],['card','card-foreground'],['secondary','secondary-foreground'],['primary','on-primary'],['accent','on-accent'],['muted','muted-foreground']])assert.ok(contrast(d.tokens[bg!]!,d.tokens[ink!]!)>=4.5,profile+' '+bg);
}
for(const accent of ['#000000','#ffffff','#eeeeee','#267965','#ff0000'])assert.ok(contrast(accent,readableInk(accent))>=4.5);
for(const profile of ['__proto__','constructor','bad'])assert.throws(()=>validateProject({...project,designSystem:{version:1,profile}}));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mobile-design-'));const legacy={...original};delete legacy.designSystem;saveMobile(root,legacy,0);const saved=saveMobile(root,project,1);assert.deepEqual(saved.screens,original.screens);assert.equal(travelMobile(root,2,'undo').designSystem,undefined);assert.deepEqual(travelMobile(root,3,'redo').designSystem,project.designSystem);
let generated:MobileProject|undefined;
const buildOptions={root,model:'design-fixture',signal:new AbortController().signal,emit:(e:Record<string,unknown>)=>{if(e.type==='done')generated=e.project as MobileProject;},ollama:{chat:async()=>({content:JSON.stringify({...project,accent:'#124abc'}),model:'design-fixture',toolCalls:[],usage:{promptTokens:0,completionTokens:0,durationMs:0}})}};
await buildMobile({...buildOptions,brief:'حسّن وصف التطبيق',expectedRevision:4});assert.equal(generated!.accent,project.accent,'Unrelated edits preserve the brand color');
await buildMobile({...buildOptions,brief:'غيّر اللون إلى الأزرق',expectedRevision:generated!.revision});assert.equal(generated!.accent,'#124abc','Explicit color requests remain effective');
const zipped=await exportMobile(project,'design-test');fs.writeFileSync(dir+'/source.zip',zipped);const zip=await JSZip.loadAsync(zipped);await transform(await zip.file('expo/App.js')!.async('string'),{loader:'jsx'});assert.equal(JSON.parse(await zip.file('design-system.json')!.async('string')).profile,'productivity');
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:414,height:776}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
const html=mobileHtml(project,'design-isolated-test');await page.route(base+'/design-test',r=>r.fulfill({contentType:'text/html',body:html}));
let edges=0,fields=0,saves=0;
try{
 await page.goto(base+'/design-test');await page.locator('[data-design-profile="productivity"]').waitFor();
 const byId=new Map(project.screens.map(s=>[s.id,s]));
 for(const screen of project.screens){
  // Render at the selected screen, exactly as the studio sends a selection.
  await page.route(base+'/design-screen',r=>r.fulfill({contentType:'text/html',body:mobileHtml(project,'design-isolated-test',screen.id)}));await page.goto(base+'/design-screen');
  for(const block of screen.blocks){
   const control=page.locator('[data-block-id="'+block.id+'"]');
   if(block.type==='input'){await control.locator('input').fill('بيانات اختبار '+block.id);fields++;}
   if(block.type==='toggle'){await control.locator('input').check();fields++;}
   if(block.type==='button'&&!block.target){await control.click();assert.match(await page.locator('output').innerText(),/تم حفظ/);saves++;}
   if(block.target){await control.click();assert.equal(await page.locator('h1').innerText(),byId.get(block.target)!.title);await page.getByRole('button',{name:'رجوع',exact:true}).click();assert.equal(await page.locator('h1').innerText(),screen.title);edges++;}
  }
  await page.reload();
  for(const b of screen.blocks){if(b.type==='input')assert.equal(await page.locator('[data-block-id="'+b.id+'"] input').inputValue(),'بيانات اختبار '+b.id);if(b.type==='toggle')assert.equal(await page.locator('[data-block-id="'+b.id+'"] input').isChecked(),true);}
  await page.unroute(base+'/design-screen');
 }
 await page.goto(base+'/design-test');for(const width of [320,414,768]){await page.setViewportSize({width,height:776});assert.equal(await page.locator('html').evaluate(n=>n.scrollWidth>n.clientWidth+1),false);}
 await page.setViewportSize({width:414,height:776});await page.screenshot({path:dir+'/app.png'});assert.deepEqual(errors,[]);
 fs.writeFileSync(dir+'/verification.json',JSON.stringify({profiles:9,contrast:'semantic text pairs >=4.5:1',screens:project.screens.length,edges,fields,saves,undoRedo:'passed',persistence:'passed',export:'standalone browser and Expo syntax passed',browserErrors:errors},null,2));
 console.log('PASS design integration: 9 profiles, contrast, schema, undo/redo, '+edges+' links and backs, '+fields+' fields, '+saves+' saves, export, responsive');
}finally{await browser.close();}
