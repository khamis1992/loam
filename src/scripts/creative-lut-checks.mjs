import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseCube,sampleLut,matchColorAdjust,validateEffects,addEffect} from '../../ui/creative-fx.js';
import {validateTimeline,newTimeline,newClip} from '../../ui/creative-timeline-model.js';

/** Build a .cube that maps every color toward blue (b stays, r,g → 0). */
export function blueCubeText(size=2){
  let text='TITLE loam\nLUT_3D_SIZE '+size+'\n';
  for(let b=0;b<size;b++)for(let g=0;g<size;g++)for(let r=0;r<size;r++)text+='0 0 '+(b/(size-1)).toFixed(4)+'\n';
  return text;
}

/** Model checks: LUT parsing/sampling, matcher derivation, validation bounds. */
export function checkLutModel(){
  const lut=parseCube(blueCubeText());
  const mapped=sampleLut(lut,1,.5,.2);
  assert.ok(mapped[2]>.18&&mapped[2]<.22&&mapped[0]<.05&&mapped[1]<.05,'blue LUT zeroes r/g and maps b on the blue axis · '+mapped.map(v=>v.toFixed(2)).join(','));
  const corner=sampleLut(lut,0,0,1);
  assert.ok(corner[2]>.99&&corner[0]<.01,'blue LUT keeps the blue corner');
  const half=sampleLut(lut,.5,.5,.5);
  assert.ok(Math.abs(half[2]-.5)<1e-3&&half[0]<.01,'midpoint maps to blue axis');
  const identity=parseCube((()=>{const size=2;let t='LUT_3D_SIZE 2\n';for(let b=0;b<2;b++)for(let g=0;g<2;g++)for(let r=0;r<2;r++)t+=r+' '+g+' '+b+'\n';return t;})());
  assert.ok(Math.abs(sampleLut(identity,.25,.75,.5)[0]-.25)<1e-6,'identity LUT preserves values');
  // matcher: warm red source toward neutral gray target reduces saturation and warms hue
  const adjust=matchColorAdjust({luma:.4,r:.7,g:.3,b:.2,spread:.5},{luma:.4,r:.4,g:.4,b:.4,spread:.02});
  assert.ok(adjust.saturation<.7,'match lowers the spread into the target');
  assert.ok(adjust.hue<0,'match cools a warm source');
  // validation
  const project=newTimeline();project.taskId='task_lut';
  const asset={id:'a',name:'c.png',kind:'image',duration:0,path:'assets/timeline/00000000-0000-0000-0000-000000000012.png',bytes:1};
  project.assets.push(asset);
  const clip={...newClip(project.tracks[0],asset,0),duration:1};
  project.clips.push(clip);
  addEffect(clip,'lut');
  clip.effects[0].params.cube=blueCubeText();
  validateTimeline(project);
  clip.effects[0].params.strength=1.5;
  assert.throws(()=>validateTimeline(project),/خارج الحدود/);
  clip.effects[0].params.strength=1;
  clip.effects[0].params.cube='garbage';
  assert.throws(()=>parseCube(clip.effects[0].params.cube),/LUT/);
  console.log('PASS lut model: cube parsing, trilinear sampling, matcher derivation, bounds validation');
}

/** Browser flow: LUT import with strength in preview and exported MP4; color match shifts a clip toward a reference. */
export async function checkLutUI(page,fixtures,{taskId,base}){
  const idle=()=>page.waitForFunction(()=>!document.querySelector('.creative-timeline-editor fieldset')?.disabled&&!document.querySelector('.creative-import-dialog [data-import-apply][disabled]'));
  const editor=page.locator('.creative-timeline-editor');
  if(!await editor.count()||!await editor.evaluate(el=>el.open)){await page.locator('[data-timeline-open]').click();await page.locator('.creative-timeline-editor canvas[aria-label]').waitFor();}
  const downloadJSON=async()=>{const pending=page.waitForEvent('download');await page.locator('[data-tl-download]').click();const file=await pending;await idle();return JSON.parse(fs.readFileSync(await file.path()));};
  const confirmImport=async()=>{await page.waitForFunction(()=>{const button=document.querySelector('.creative-import-dialog [data-import-apply]');return button&&!button.disabled;},{},{timeout:120000});await page.locator('.creative-import-dialog [data-import-apply]').click();await page.waitForFunction(()=>!document.querySelector('.creative-import-dialog'),{},{timeout:90000});await idle();};
  const pixel=async(x=.5,y=.5)=>page.locator('.creative-timeline-editor canvas[aria-label]').evaluate((c,[px,py])=>Array.from(c.getContext('2d').getImageData(Math.round(c.width*px),Math.round(c.height*py),1,1).data),[x,y]);
  const seek=async time=>{await page.locator('[data-tl-seek]').fill(String(time));await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();};
  const png=color=>page.evaluate(fill=>{const c=document.createElement('canvas');c.width=64;c.height=64;const ctx=c.getContext('2d');ctx.fillStyle=fill;ctx.fillRect(0,0,64,64);return c.toDataURL('image/png');},color);
  const warm=await png('#c08030'),cool=await png('#3080c0');
  const baseline=await downloadJSON();
  baseline.assets=[];baseline.clips=[];baseline.markers=[];baseline.range=undefined;baseline.duck=undefined;
  baseline.tracks=baseline.tracks.filter(t=>t.role!=='subtitles').slice(0,2);
  for(const t of baseline.tracks)for(const key of ['locked','targeted','volume','pan','solo','eq','compressor','role','subsStyle','blend','adjust','colorAdjust'])delete t[key];
  await page.locator('[data-tl-project]').setInputFiles({name:'fresh.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(baseline))});
  await idle();
  await page.locator('[data-tl-seek]').fill('0');await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();
  const addImage=async(name,data)=>{await page.locator('[data-tl-files]').setInputFiles({name,mimeType:'image/png',buffer:Buffer.from(data.split(',')[1],'base64')});await confirmImport();};
  await addImage('cool.png',cool);
  await page.locator('[data-pick-track]').nth(1).click();await idle();
  await addImage('warm.png',warm);
  await seek(.1);
  await page.locator('[data-clip]').filter({hasText:'warm.png'}).first().evaluate(el=>el.scrollIntoView({block:'center'}));
  await page.locator('[data-clip]').filter({hasText:'warm.png'}).first().click();await idle();
  const before=await pixel();
  assert.ok(before[0]>150,'warm clip on top before LUT · '+JSON.stringify(before));
  // add LUT effect and import a real .cube through the file chooser
  await page.locator('[data-fx-add="lut"]').click();await idle();
  const chooser=page.waitForEvent('filechooser');
  await page.locator('[data-fx-lut-load]').click();
  await(await chooser).setFiles({name:'blue.cube',mimeType:'text/plain',buffer:Buffer.from(blueCubeText())});
  await idle();await seek(.1);
  const lutted=await pixel();
  assert.ok(lutted[0]<before[0]*.25&&lutted[2]>=30&&lutted[2]<=70,'LUT zeroes red and keeps the blue channel · '+JSON.stringify(lutted));
  // strength 0.5 halves the shift
  const strength=page.locator('[data-fx-param$=".strength"]');
  await strength.evaluate((el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},'0.5');
  await idle();await seek(.1);
  const half=await pixel();
  assert.ok(half[0]>lutted[0]+25&&half[0]<before[0]-25,'strength blends halfway · '+half[0]+' between '+lutted[0]+' and '+before[0]);
  let project=await downloadJSON();
  const lutState=project.clips.find(c=>c.name==='warm.png').effects.find(effect=>effect.type==='lut');
  assert.ok(lutState.params.cube.includes('LUT_3D_SIZE'),'cube data persists in the project');
  assert.ok(Math.abs(lutState.params.strength-.5)<1e-6,'strength persists');
  // color match toward the cool clip below
  await page.locator('[data-fx-remove]').first().click();await idle();
  await seek(.1);
  const preMatch=await pixel();
  await page.locator('[data-clip-match-color]').click();await idle();await seek(.1);
  const matched=await pixel();
  assert.ok(matched[2]>preMatch[2]+15||matched[0]<preMatch[0]-15,'color match shifts the warm clip toward cool · '+JSON.stringify(preMatch)+'→'+JSON.stringify(matched));
  project=await downloadJSON();
  const matchedState=project.clips.find(c=>c.name==='warm.png').colorAdjust;
  assert.ok(matchedState&&matchedState.enabled===true,'match persists as colorAdjust');
  // LUT burns into the exported MP4
  const count=await page.locator('[data-job]').count();
  await page.locator('[data-tl-format]').selectOption('mp4');await page.locator('[data-tl-export]').click();await idle();
  await page.waitForFunction(n=>document.querySelectorAll('[data-job]').length>n,count);
  await page.waitForFunction(()=>{const rows=[...document.querySelectorAll('[data-job]')];const failed=rows.find(r=>r.dataset.state==='failed');if(failed)throw Error(failed.textContent);return rows.every(r=>['done','canceled'].includes(r.dataset.state));},{},{timeout:240000});
  const pending=page.waitForEvent('download');await page.locator('[data-job-download]').last().click();
  const mp4=fs.readFileSync(await (await pending).path());
  const exported=await page.evaluate(async encoded=>{const blob=await(await fetch('data:video/mp4;base64,'+encoded)).blob(),url=URL.createObjectURL(blob),video=document.createElement('video');video.src=url;await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=reject;});video.currentTime=1;await new Promise(resolve=>video.onseeked=resolve);const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);const center=Array.from(canvas.getContext('2d').getImageData(Math.round(canvas.width/2),Math.round(canvas.height/2),1,1).data);URL.revokeObjectURL(url);return center;},mp4.toString('base64'));
  assert.ok(exported[2]>=60&&exported[0]<190&&(preMatch[0]-preMatch[2])>(exported[0]-exported[2])+10,'exported MP4 shows the cooled/matched tone · '+JSON.stringify(exported));
  fs.mkdirSync('output/verification',{recursive:true});
  fs.writeFileSync('output/verification/creative-lut-report.json',JSON.stringify({taskId,before,lutted,half,preMatch,matched,exported},null,2));
  await page.screenshot({path:'output/verification/creative-lut.png'});
  await page.locator('[data-tl-close]').click();
  console.log('PASS lut UI: .cube import with strength in preview and exported MP4, color match toward a reference clip');
}
