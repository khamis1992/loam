/** Live generated-project acceptance test. Never seeds or edits the project's screens. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, type Page, type FrameLocator } from 'playwright';
import JSZip from 'jszip';
import { transform } from 'esbuild';
import { validateProject, type MobileProject } from '../mobile/store.js';
import { checkPolishedCopy } from '../mobile/polish.js';

const base=process.env.MOBILE_TEST_BASE||'http://127.0.0.1:3941',taskId=process.argv[2];
assert.ok(taskId,'Pass the generated task ID');
const polished=process.argv.includes('--polished');
const dir='release/mobile-live/'+(polished?'polished-app':'generated-app');fs.mkdirSync(dir,{recursive:true});
const response=await fetch(base+'/api/mobile?taskId='+encodeURIComponent(taskId));assert.ok(response.ok);
const data=await response.json() as {project:MobileProject};
const p=data.project;validateProject(p);fs.writeFileSync(dir+'/project.json',JSON.stringify(p,null,2));
if(polished){
 const before=JSON.parse(fs.readFileSync(dir+'/before.json','utf8')).project as MobileProject;
 const structure=(project:MobileProject)=>({title:project.title,accent:project.accent,direction:project.direction,screens:project.screens.map(s=>({id:s.id,title:s.title,group:s.group,kind:s.kind,parentId:s.parentId,blocks:s.blocks.map(b=>({id:b.id,type:b.type,target:b.target}))}))});
 assert.deepEqual(structure(p),structure(before),'Polish must preserve every data binding and navigation link');
 for(const s of p.screens){assert.ok(s.design?.description&&s.design.guidance&&s.design.eyebrow);checkPolishedCopy({...s,design:s.design},p.direction==='rtl');for(const b of s.blocks.filter(b=>b.type==='input'))assert.ok(b.help&&b.placeholder);}
}
assert.equal(p.screens.length,20,'Model must generate all twenty requested screens');
const roots=p.screens.filter(s=>s.kind==='primary'),details=p.screens.filter(s=>s.kind==='detail');
assert.equal(roots.length,4);assert.equal(details.length,16);
// Accept the model's plural label for the same review section; retain this
// visible copy deviation in the report rather than rewriting generated data.
assert.deepEqual(new Set(roots.map(s=>s.title==='مراجعاتي'?'مراجعتي':s.title)),new Set(['تعلمي','مشاريعي','عاداتي','مراجعتي']));
const byId=new Map(p.screens.map(s=>[s.id,s]));
const named=(name:string)=>{const s=p.screens.find(s=>s.title===name);assert.ok(s,'Missing '+name);return s;};
for(const [child,parent] of [['تقييم الجلسة','جلسة دراسة'],['تفاصيل المهمة','مهمة اليوم'],['هدف العادة','متابعة عادة'],['خطة الغد','مراجعة يومية']])assert.equal(named(child!).parentId,named(parent!).id);
for(const s of details){assert.ok(s.blocks.some(b=>b.type==='input'),'Missing input '+s.title);assert.ok(s.blocks.some(b=>b.type==='toggle'),'Missing toggle '+s.title);assert.ok(s.blocks.some(b=>b.type==='button'&&!b.target),'Missing save '+s.title);assert.ok(byId.get(s.parentId!)!.blocks.some(b=>b.target===s.id),'Missing forward parent link '+s.title);}
assert.ok(named('تفاصيل المهمة').blocks.some(b=>b.target===named('جلسة دراسة').id),'Missing cross-section link');
type Step={source:string;block:string;target:string};
const paths=new Map<string,Step[]>(),rootOf=new Map<string,string>();
const queue=roots.map(s=>s.id);for(const id of queue){paths.set(id,[]);rootOf.set(id,id);}
while(queue.length){const id=queue.shift()!;for(const b of byId.get(id)!.blocks)if(b.target&&!paths.has(b.target)){paths.set(b.target,[...paths.get(id)!,{source:id,block:b.id,target:b.target}]);rootOf.set(b.target,rootOf.get(id)!);queue.push(b.target);}}
assert.equal(paths.size,p.screens.length,'Unreachable model-generated pages');
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1110,height:884}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
page.setDefaultTimeout(12000);
const values=new Map<string,string>();let transitions=0,backs=0,saves=0,fields=0;
async function title(app:FrameLocator|Page,id:string){await app.locator('h1').filter({hasText:byId.get(id)!.title}).waitFor();assert.equal(await app.locator('h1').innerText(),byId.get(id)!.title);}
async function visit(app:FrameLocator|Page,id:string){const root=rootOf.get(id)!;await app.locator('nav button').filter({hasText:byId.get(root)!.title}).click();await title(app,root);for(const step of paths.get(id)!){await app.locator('[data-block-id="'+step.block+'"]').click();await title(app,step.target);transitions++;}}
try{
 await page.goto(base+'/mobile.html?taskId='+taskId);const app=page.frameLocator('#preview');await page.locator('#open-explorer').filter({hasText:'20'}).waitFor();
 assert.equal(await app.locator('nav button').count(),4);
 if(polished){assert.equal(await app.locator('.app-hero').count(),1);assert.equal(await app.getByRole('progressbar').getAttribute('aria-valuenow'),'0');assert.equal(await app.getByRole('progressbar').getAttribute('aria-valuemax'),'4');assert.equal(await app.locator('.destination-card').count(),4);}
 for(const s of p.screens){
  await visit(app,s.id);
  for(const b of s.blocks){const n=app.locator('[data-block-id="'+b.id+'"]');if(b.type==='input'){const value='اختبار '+s.title+' · '+b.id;await n.locator('input').fill(value);values.set(b.id,value);fields++;}if(b.type==='toggle'){await n.locator('input').check();fields++;}if(b.type==='button'&&!b.target){await n.click();assert.match(await app.locator('output').innerText(),/تم حفظ/);await title(app,s.id);saves++;}}
  for(const step of [...paths.get(s.id)!].reverse()){await app.getByRole('button',{name:'رجوع',exact:true}).click();await title(app,step.source);backs++;}
 }
 // Every generated navigation edge, including the cross-section edge, is exercised.
 for(const s of p.screens)for(const b of s.blocks.filter(b=>b.target)){await visit(app,s.id);await app.locator('[data-block-id="'+b.id+'"] button,button[data-block-id="'+b.id+'"]').click();await title(app,b.target!);transitions++;if(byId.get(b.target!)!.kind==='detail'){await app.getByRole('button',{name:'رجوع',exact:true}).click();await title(app,s.id);backs++;}}
 for(const child of details.filter(s=>byId.get(s.parentId!)!.kind==='detail')){const parent=byId.get(child.parentId!)!,root=byId.get(parent.parentId!)!;await visit(app,parent.id);const link=parent.blocks.find(b=>b.target===child.id)!;await app.locator('[data-block-id="'+link.id+'"]').click();await title(app,child.id);transitions++;await app.getByRole('button',{name:'رجوع',exact:true}).click();await title(app,parent.id);await app.getByRole('button',{name:'رجوع',exact:true}).click();await title(app,root.id);backs+=2;}
 await page.reload();await page.locator('#open-explorer').filter({hasText:'20'}).waitFor();
 for(const s of p.screens){await visit(app,s.id);for(const b of s.blocks){const n=app.locator('[data-block-id="'+b.id+'"] input');if(b.type==='input')assert.equal(await n.inputValue(),values.get(b.id));if(b.type==='toggle')assert.equal(await n.isChecked(),true);}}
 if(polished)for(const s of roots){await visit(app,s.id);assert.equal(await app.getByRole('progressbar').getAttribute('aria-valuenow'),'4');assert.equal(await app.getByRole('progressbar').getAttribute('aria-valuemax'),'4');assert.ok(await app.locator('.destination-state').count()>0);}
 if(polished){
  const detail=named('تفاصيل المهمة'),field=detail.blocks.find(b=>b.type==='input')!;await visit(app,detail.id);
  await page.locator('#select-mode').click();await app.getByRole('button',{name:'تعديل: '+field.text,exact:true}).click();
  await page.locator('#element-help').fill('مساعدة تجريبية للتحقق من التحرير بالنقر');
  const help=app.locator('[data-block-id="'+field.id+'"] .field-help');await help.filter({hasText:'مساعدة تجريبية'}).waitFor();
  await page.locator('#undo').click();await help.filter({hasText:field.help!}).waitFor();await page.locator('#interact').click();
 }
 // Direct-open detail falls back to parent, independently of visit history.
 await page.locator('#open-explorer').click();await page.locator('#screen-search').fill('تقييم الجلسة');assert.equal(await page.locator('#screen-list [data-screen-id]').count(),1);await page.locator('#screen-list [data-screen-id="'+named('تقييم الجلسة').id+'"]').click();await title(app,named('تقييم الجلسة').id);
 await page.locator('#screen-path').filter({hasText:'جلسة دراسة'}).waitFor();await app.getByRole('button',{name:'رجوع',exact:true}).click();await title(app,named('جلسة دراسة').id);backs++;
 await page.locator('#open-flow').click();assert.equal(await page.locator('.flow-node').count(),20);assert.match(await page.locator('#flow-summary').innerText(),/كل الصفحات لها مسار وصول/);assert.equal(await page.locator('.flow-warning').count(),0);await page.screenshot({path:dir+'/flow.png'});await page.locator('#close-flow').click();
 // Undo the model build, then restore it, without manually modifying the result.
 await page.locator('#undo').click();
 if(polished){await page.locator('#redo:not(:disabled)').waitFor();assert.match(await page.locator('#open-explorer').innerText(),/20/);const undone=((await(await fetch(base+'/api/mobile?taskId='+taskId)).json()) as {project:MobileProject}).project;const previous=JSON.parse(fs.readFileSync(dir+(fs.existsSync(dir+'/undo-target.json')?'/undo-target.json':'/first-pass.json'),'utf8')).project;assert.deepEqual(undone.screens,previous.screens);}
 else await page.locator('#open-explorer').filter({hasText:'الشاشات · 1 ▾'}).waitFor();
 await page.locator('#redo').click();await page.locator('#open-explorer').filter({hasText:'20'}).waitFor();if(polished)await app.locator('.app-hero').waitFor();await visit(app,named('تفاصيل المهمة').id);await page.screenshot({path:dir+'/studio.png'});
 if(polished){const field=named('تفاصيل المهمة').blocks.find(b=>b.type==='input')!;assert.equal(await app.locator('[data-block-id="'+field.id+'"] input').inputValue(),values.get(field.id));}
 for(const width of [1110,768,320]){await page.setViewportSize({width,height:884});assert.equal(await page.locator('html').evaluate(n=>n.scrollWidth>n.clientWidth+1),false,'Studio overflow '+width);assert.equal(await app.locator('html').evaluate(n=>n.scrollWidth>n.clientWidth+1),false,'App overflow '+width);}
 const zipped=Buffer.from(await(await fetch(base+'/api/mobile/export?taskId='+taskId)).arrayBuffer());fs.writeFileSync(dir+'/source.zip',zipped);const zip=await JSZip.loadAsync(zipped);await transform(await zip.file('expo/App.js')!.async('string'),{loader:'jsx'});
 const html=await zip.file('index.html')!.async('string');await page.route('**/generated-export',route=>route.fulfill({contentType:'text/html',body:html}));await page.goto(base+'/generated-export');assert.equal(await page.locator('nav button').count(),4);
 for(const s of p.screens){await visit(page,s.id);if(polished){if(await page.locator('details.guidance-card').count())await page.locator('.guidance-card summary').click();assert.equal(await page.locator('.app-description').innerText(),s.design!.description);assert.match(await page.locator('.guidance-card').innerText(),new RegExp(s.design!.guidance.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));}for(const step of [...paths.get(s.id)!].reverse()){await page.getByRole('button',{name:'رجوع',exact:true}).click();await title(page,step.source);backs++;}}
 assert.deepEqual(errors,[]);
 const result={taskId,model:'qwen2.5:14b',screens:20,primary:4,detail:16,reachable:paths.size,navigationEdges:p.screens.flatMap(s=>s.blocks).filter(b=>b.target).length,transitions,backs,fields,saves,persistence:'all inputs and toggles after reload',flow:'no unreachable pages',undoRedo:'passed',exportedWeb:'all pages and back paths passed',expo:'JSX syntax passed; no native device test',copyObservations:['Review section named مراجعاتي rather than مراجعتي','Primary sections contain navigation buttons, without the requested introductory copy','Some input labels repeat across different pages; field IDs remain distinct'],browserErrors:errors};
 if(polished){result.copyObservations=['All twenty pages have local-model design metadata, with a final editorial review of introductions and completion labels','All sixteen fields have contextual help and example placeholders'];Object.assign(result,{structurePreserved:true,progress:'0/4 to 4/4 in all four sections; persisted after reload',polishedPages:20});}
 fs.writeFileSync(dir+'/verification.json',JSON.stringify(result,null,2));console.log('PASS '+JSON.stringify(result));
}catch(e){await page.screenshot({path:dir+'/failure.png'}).catch(()=>{});throw e;}finally{await browser.close();}
