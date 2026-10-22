import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateIdentity,defaultIdentity,applyIdentity,logoClip,buildTemplate,videoTemplates,platformSizes,convertAspect} from '../../ui/creative-identity.js';
import {validateTimeline,newTimeline,newClip} from '../../ui/creative-timeline-model.js';

/** Model checks: identity validation, application to titles, logo geometry, template shapes, aspect conversion. */
export function checkIdentityModel(){
  const identity=defaultIdentity();identity.logoText='لوم';
  validateIdentity(identity);
  assert.throws(()=>validateIdentity({...identity,primary:'red'}),/لون/);
  assert.throws(()=>validateIdentity({...identity,unknown:1}),/غير معروف/);
  assert.throws(()=>validateIdentity({...identity,titleFont:999}),/خط/);
  assert.throws(()=>validateIdentity({...identity,logoCorner:'center'}),/زاوية/);
  const project=newTimeline();project.taskId='task_identity';project.identity=identity;project.platform='shorts';
  const asset={id:'a',name:'g.png',kind:'image',duration:0,path:'assets/timeline/00000000-0000-0000-0000-000000000014.png',bytes:1};
  project.assets.push(asset);
  const titles=[{...newClip(project.tracks[0],null,0),duration:2,color:'#ff0000',fontSize:30},{...newClip(project.tracks[1],null,.5),duration:2,color:'#00ff00',fontSize:20}];
  project.clips.push(...titles);
  const logo=logoClip(identity,project.tracks[0],0);
  project.clips.push(logo);
  validateTimeline(project);
  const changed=applyIdentity(project);
  assert.equal(titles[0].color,identity.titleColor,'identity recolors titles');
  assert.equal(titles[0].fontSize,identity.titleFont,'identity refonts titles');
  assert.equal(logo.x,.42,'logo sits in its corner');
  assert.ok(changed>=4,'applyIdentity reports the changes');
  for(const kind of Object.keys(videoTemplates)){
    const clips=buildTemplate(kind,project.tracks[2],0,identity);
    assert.ok(clips.length>=1&&clips.every(c=>c.kind==='title'&&c.duration>0.5),kind+' builds editable titles');
  }
  const preset=convertAspect(project,'shorts');
  assert.deepEqual([project.width,project.height],[1080,1920],'aspect converts size');
  assert.ok(Math.abs(logo.x)<=1,'converted positions stay in bounds');
  assert.throws(()=>convertAspect(project,'nope'),/منصة/);
  console.log('PASS identity model: validation, title application, logo corner, five templates, aspect conversion');
}

/** Browser flow: identity editor applies to titles and persists; logo clip; full templates insert editable clips; platform convert changes canvas; safe-area guides toggle. */
export async function checkIdentityUI(page,fixtures,{taskId,base}){
  const idle=()=>page.waitForFunction(()=>!document.querySelector('.creative-timeline-editor fieldset')?.disabled&&!document.querySelector('.creative-import-dialog [data-import-apply][disabled]'));
  const editor=page.locator('.creative-timeline-editor');
  if(!await editor.count()||!await editor.evaluate(el=>el.open)){await page.locator('[data-timeline-open]').click();await page.locator('.creative-timeline-editor canvas[aria-label]').waitFor();}
  const downloadJSON=async()=>{const pending=page.waitForEvent('download');await page.locator('[data-tl-download]').click();const file=await pending;await idle();return JSON.parse(fs.readFileSync(await file.path()));};
  const pixel=async(x=.5,y=.5)=>page.locator('.creative-timeline-editor canvas[aria-label]').evaluate((c,[px,py])=>Array.from(c.getContext('2d').getImageData(Math.round(c.width*px),Math.round(c.height*py),1,1).data),[x,y]);
  const seek=async time=>{await page.locator('[data-tl-seek]').fill(String(time));await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();};
  const identitySection=page.locator('.tl-identity');
  if(!await identitySection.evaluate(el=>el.open))await identitySection.locator('summary').click();
  // baseline project with one title
  const baseline=await downloadJSON();
  baseline.assets=[];baseline.clips=[];baseline.markers=[];baseline.range=undefined;baseline.duck=undefined;baseline.identity=undefined;baseline.platform=undefined;
  baseline.tracks=baseline.tracks.filter(t=>t.role!=='subtitles').slice(0,3);
  for(const t of baseline.tracks)for(const key of ['locked','targeted','volume','pan','solo','eq','compressor','role','subsStyle','blend','adjust','colorAdjust'])delete t[key];
  await page.locator('[data-tl-project]').setInputFiles({name:'fresh.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(baseline))});
  await idle();
  await page.locator('[data-tl-seek]').fill('0');await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();
  await page.locator('[data-tl-title-add]').click();await idle();
  let project=await downloadJSON();
  assert.equal(project.clips.filter(c=>c.kind==='title').length,1,'one title to style');
  // edit identity: title color red, font 90, logo text
  await page.locator('[data-identity-field="titleColor"]').fill('#c02020');
  await page.locator('[data-identity-field="titleColor"]').dispatchEvent('change');await idle();
  await page.locator('[data-identity-field="titleFont"]').fill('90');
  await page.locator('[data-identity-field="titleFont"]').dispatchEvent('change');await idle();
  await page.locator('[data-identity-field="logoText"]').fill('لوم');
  await page.locator('[data-identity-field="logoText"]').dispatchEvent('change');await idle();
  project=await downloadJSON();
  assert.equal(project.identity.titleColor,'#c02020','identity color persists');
  assert.equal(project.identity.titleFont,90,'identity font persists');
  assert.equal(project.identity.logoText,'لوم','logo text persists');
  // apply to titles
  await page.locator('[data-identity-apply]').click();await idle();
  project=await downloadJSON();
  const title=project.clips.find(c=>c.kind==='title');
  assert.equal(title.color,'#c02020','applyIdentity recolors the title');
  assert.equal(title.fontSize,90,'applyIdentity refonts the title');
  await seek(.1);
  const region=await page.locator('.creative-timeline-editor canvas[aria-label]').evaluate(c=>{const ctx=c.getContext('2d');let peakR=0,peakG=0;for(let y=Math.round(c.height*.35);y<c.height*.65;y+=2)for(let x=Math.round(c.width*.3);x<c.width*.7;x+=2){const d=ctx.getImageData(x,y,1,1).data;if(d[0]>peakR)peakR=d[0];if(d[1]>peakG)peakG=d[1];}return [peakR,peakG];});
  assert.ok(region[0]>120&&region[0]>region[1]+40,'red identity title renders · '+JSON.stringify(region));
  // logo clip in corner
  await page.locator('[data-identity-logo]').click();await idle();
  project=await downloadJSON();
  const logo=project.clips.find(c=>c.name.startsWith('شعار'));
  assert.ok(logo,'logo clip added');
  assert.ok(Math.abs(logo.x)>.3&&Math.abs(logo.y)>.3,'logo positioned in a corner');
  // full template inserts editable clips
  await page.locator('[data-video-template="ad"]').click();await idle();
  project=await downloadJSON();
  const adNames=project.clips.filter(c=>['عرض محدود','اكتشف الميزة الآن','اطلب اليوم'].includes(c.text)).length;
  assert.equal(adNames,3,'ad template inserts three editable titles');
  assert.ok(project.clips.filter(c=>c.text==='عرض محدود')[0].transition==='wipe','template carries transitions');
  // invalid: clear logo text then try logo (failure path)
  await page.locator('[data-identity-field="logoText"]').fill('');
  await page.locator('[data-identity-field="logoText"]').dispatchEvent('change');await idle();
  const clipsBefore=project.clips.length;
  await page.locator('[data-identity-logo]').click();await idle();
  const emptyLogoStatus=await page.locator('[data-tl-status]').innerText();
  project=await downloadJSON();
  assert.equal(project.clips.length,clipsBefore,'empty logo text adds nothing');
  const failureStatus=await page.locator('[data-tl-status]').innerText();assert.match(emptyLogoStatus,/الشعار|مسار مرئي|أولًا/,'failure explains itself · '+emptyLogoStatus);
  await page.locator('[data-identity-field="logoText"]').fill('لوم');
  await page.locator('[data-identity-field="logoText"]').dispatchEvent('change');await idle();
  // platform convert: 16:9 → 9:16
  await page.locator('[data-platform-select]').selectOption('shorts');
  await page.locator('[data-platform-convert]').click();await idle();
  project=await downloadJSON();
  assert.deepEqual([project.width,project.height],[1080,1920],'platform converts the project size');
  assert.equal(project.platform,'shorts','platform tag persists');
  assert.equal(await page.locator('.creative-timeline-editor canvas[aria-label]').evaluate(c=>c.width),1080,'preview canvas follows the new size');
  // safe-area guides toggle (border pixels get the dashed overlay)
  await page.locator('input[data-safe-area]').setChecked(true);await idle();await seek(.1);
  const border=await page.locator('.creative-timeline-editor canvas[aria-label]').evaluate(c=>{const data=c.getContext('2d').getImageData(Math.round(c.width*.08),0,1,1).data;return Array.from(data);});
  assert.ok(border[3]>0,'safe-area guide draws on the border');
  await page.locator('input[data-safe-area]').setChecked(false);await idle();
  // identity survives save + reopen
  const saved=page.waitForResponse(r=>r.url().includes('/api/timeline/project?')&&r.status()===201);
  await page.locator('[data-tl-save]').click();const savedPath=(await(await saved).json()).path;await idle();
  await page.locator('[data-tl-list]').click();await idle();
  await page.locator('[data-tl-saved]').selectOption(savedPath);await idle();
  project=await downloadJSON();
  assert.equal(project.identity.logoText,'لوم','identity round-trips through save/reopen');
  assert.equal(project.platform,'shorts','platform round-trips');
  fs.mkdirSync('output/verification',{recursive:true});
  fs.writeFileSync('output/verification/creative-identity-report.json',JSON.stringify({taskId,identity:project.identity,platform:project.platform,adNames},null,2));
  await page.screenshot({path:'output/verification/creative-identity.png'});
  await page.locator('[data-tl-close]').click();
  console.log('PASS identity UI: editor persistence, apply to titles with pixel proof, logo corner, ad template editable clips, empty-logo failure, platform convert with canvas resize, safe-area toggle, save/reopen round-trip');
}
