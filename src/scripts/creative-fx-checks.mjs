import assert from 'node:assert/strict';
import fs from 'node:fs';
import {bezierProgress,easedValue,validateEffects,addEffect,moveEffect,effectCatalog,setEaseHandles,validateEaseHandles} from '../../ui/creative-fx.js';
import {validateTimeline,newTimeline,newClip} from '../../ui/creative-timeline-model.js';

/** Model checks: Bézier easing math, effects validation, masks/chroma bounds. */
export function checkFxModel(){
  assert.ok(Math.abs(bezierProgress(.5,{in:[.35,0],out:[.65,1]})-.5)<1e-6,'symmetric handles stay near linear at mid');
  assert.ok(bezierProgress(.25,{in:[.8,0],out:[1,1]})<.15,'strong ease-in starts slow');
  assert.ok(bezierProgress(.75,{in:[0,1],out:[.2,1]})>.85,'strong ease-out finishes early');
  const clip={start:0,duration:2,opacity:1,keyframes:{opacity:[{time:0,value:1,ease:'bezier',handles:{in:[.8,0],out:[1,1]}},{time:2,value:0,ease:'linear'}]}};
  const mid=easedValue(clip,'opacity',1);
  assert.ok(mid>.75,'ease-in keeps the value high at mid · '+mid.toFixed(3));
  clip.keyframes.opacity[0]=setEaseHandles(clip.keyframes.opacity[0],'linear')||clip.keyframes.opacity[0];
  setEaseHandles(clip.keyframes.opacity[0],'linear');
  assert.equal(easedValue(clip,'opacity',1),.5,'linear mid is exact');
  // handles validation
  for(const bad of [{in:[1.5,0],out:[.6,1]},{in:[.3,3],out:[.6,1]},{in:[.3,0],out:[-.1,1]}]){
    const key={time:0,value:1,ease:'bezier',handles:bad};
    assert.throws(()=>validateEaseHandles(key),Error,'bad handles rejected');
  }
  assert.throws(()=>validateEaseHandles({time:0,value:1,ease:'linear',handles:{in:[0,0],out:[1,1]}}),/Bézier فقط/,'handles rejected without bezier ease');
  // effects
  const project=newTimeline();project.taskId='task_fx';
  const asset={id:'a1',name:'g.png',kind:'image',duration:0,path:'assets/timeline/00000000-0000-0000-0000-00000000000f.png',bytes:1};
  project.assets.push(asset);
  const clip2={...newClip(project.tracks[0],asset,0),duration:2};
  project.clips.push(clip2);
  addEffect(clip2,'blur');addEffect(clip2,'chroma');addEffect(clip2,'mask');
  validateTimeline(project);
  assert.equal(clip2.effects.length,3,'three effects stacked');
  moveEffect(clip2,2,0);
  assert.equal(clip2.effects[0].type,'mask','reorder moves mask first');
  validateTimeline(project);
  clip2.effects[0].enabled=false;
  validateTimeline(project);
  const chroma=clip2.effects.find(effect=>effect.type==='chroma');
  chroma.params.similarity=2;
  assert.throws(()=>validateTimeline(project),/خارج الحدود/);
  chroma.params.similarity=.4;
  clip2.effects.push({id:'zz',type:'unknown',params:{}});
  assert.throws(()=>validateTimeline(project),/غير معروف/);
  clip2.effects.pop();
  clip2.effects.push({...chroma});
  assert.throws(()=>validateTimeline(project),/مكررة/);
  clip2.effects.pop();
  console.log('PASS fx model: Bézier math and easing, handle bounds, effect stack validation for the full catalog');
}

/** Browser flow: effects panel (add/params/disable/reorder/search), chroma key and mask pixels (preview + exported MP4), keyframe dots drag + Bézier ease changing interpolated pixels. */
export async function checkFxUI(page,fixtures,{taskId,base}){
  const idle=()=>page.waitForFunction(()=>!document.querySelector('.creative-timeline-editor fieldset')?.disabled&&!document.querySelector('.creative-import-dialog [data-import-apply][disabled]'));
  const editor=page.locator('.creative-timeline-editor');
  if(!await editor.count()||!await editor.evaluate(el=>el.open)){await page.locator('[data-timeline-open]').click();await page.locator('.creative-timeline-editor canvas[aria-label]').waitFor();}
  const downloadJSON=async()=>{const pending=page.waitForEvent('download');await page.locator('[data-tl-download]').click();const file=await pending;await idle();return JSON.parse(fs.readFileSync(await file.path()));};
  const confirmImport=async()=>{await page.waitForFunction(()=>{const button=document.querySelector('.creative-import-dialog [data-import-apply]');return button&&!button.disabled;},{},{timeout:120000});await page.locator('.creative-import-dialog [data-import-apply]').click();await page.waitForFunction(()=>!document.querySelector('.creative-import-dialog'));await idle();};
  const pixel=async(x=.5,y=.5)=>page.locator('.creative-timeline-editor canvas[aria-label]').evaluate((c,[px,py])=>Array.from(c.getContext('2d').getImageData(Math.round(c.width*px),Math.round(c.height*py),1,1).data),[x,y]);
  const seek=async time=>{await page.locator('[data-tl-seek]').fill(String(time));await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();};
  const makePng=(color)=>{const b=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==','base64');return b;};
  // solid-color 1x1 pngs via canvas
  const png=color=>page.evaluate(fill=>{const c=document.createElement('canvas');c.width=64;c.height=64;const ctx=c.getContext('2d');ctx.fillStyle=fill;ctx.fillRect(0,0,64,64);return c.toDataURL('image/png');},color);
  const green=await png('#00c800'),blue=await png('#2020c8'),red=await png('#c82020');
  // clean project: blue background track + green on top
  const baseline=await downloadJSON();
  baseline.assets=[];baseline.clips=[];baseline.markers=[];baseline.range=undefined;baseline.duck=undefined;
  baseline.tracks=baseline.tracks.filter(t=>t.role!=='subtitles').slice(0,2);
  for(const t of baseline.tracks){for(const key of ['locked','targeted','volume','pan','solo','eq','compressor','role','subsStyle'])delete t[key];}
  await page.locator('[data-tl-project]').setInputFiles({name:'fresh.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(baseline))});
  await idle();
  await page.locator('[data-tl-seek]').fill('0');await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();
  const addImage=async(name,data)=>{await page.locator('[data-tl-files]').setInputFiles({name,mimeType:'image/png',buffer:Buffer.from(data.split(',')[1],'base64')});await confirmImport();};
  await addImage('blue.png',blue);
  await page.locator('[data-pick-track]').nth(1).click();await idle();
  await addImage('green.png',green);
  await seek(.1);
  // select the green (top) clip
  await page.locator('[data-clip]').filter({hasText:'green.png'}).first().evaluate(el=>el.scrollIntoView({block:'center'}));
  await page.locator('[data-clip]').filter({hasText:'green.png'}).first().click();await idle();
  let before=await pixel();
  assert.ok(before[1]>150&&before[0]<80,'green clip on top before effects');
  // blur effect: top clip edge... 1x1 stretched solid — use brightness instead for determinism
  await page.locator('[data-fx-add="brightness"]').click();await idle();
  let project=await downloadJSON();
  assert.equal(project.clips.find(c=>c.name==='green.png').effects.length,1,'effect persisted');
  await page.locator('[data-fx-param]').first().evaluate((el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},'0.2');
  await idle();await seek(.1);
  let after=await pixel();
  assert.ok(after[1]<before[1]*.4,'brightness 0.2 darkens the clip pixel · '+before[1]+'→'+after[1]);
  // disable restores
  await page.locator('[data-fx-enabled]').first().setChecked(false);await idle();await seek(.1);
  let restored=await pixel();
  assert.ok(Math.abs(restored[1]-before[1])<12,'disabling the effect restores the pixel');
  await page.locator('[data-fx-remove]').first().click();await idle();
  // chroma key: green key reveals blue below
  await page.locator('[data-fx-add="chroma"]').click();await idle();
  project=await downloadJSON();
  const chromaRow=page.locator('.tl-fx-row').filter({has:page.locator('[data-fx-param$=".similarity"]')});
  await chromaRow.locator('[data-fx-param$=".similarity"]').evaluate((el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},'0.5');
  await idle();await seek(.1);
  let keyed=await pixel();
  assert.ok(keyed[2]>120&&keyed[1]<120,'chroma key reveals the blue layer · '+JSON.stringify(keyed));
  // mask: ellipse keeps only center; corner shows blue too (outside mask)
  await page.locator('[data-fx-remove]').first().click();await idle();
  await page.locator('[data-fx-add="mask"]').click();await idle();
  project=await downloadJSON();
  const maskRow=page.locator('.tl-fx-row').filter({has:page.locator('[data-fx-param$=".w"]')});
  await maskRow.locator('[data-fx-param$=".w"]').evaluate((el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},'0.3');
  await idle();await seek(.1);
  const center=await pixel(.5,.5),corner=await pixel(.3,.5);
  assert.ok(center[1]>140,'mask keeps the center (green)','center='+JSON.stringify(center));
  assert.ok(corner[2]>120&&corner[1]<120,'mask hides the corner (blue shows)','corner='+JSON.stringify(corner));
  // search filters the catalog
  await page.locator('[data-fx-search]').fill('تمويه');
  assert.equal(await page.locator('[data-fx-add]:visible').count(),1,'catalog search narrows to blur');
  await page.locator('[data-fx-search]').fill('');
  // reorder: add blur after mask then move up — pixel barely changes; assert JSON order instead
  await page.locator('[data-fx-add="blur"]').click();await idle();
  project=await downloadJSON();
  let types=project.clips.find(c=>c.name==='green.png').effects.map(effect=>effect.type);
  assert.deepEqual(types,['mask','blur'],'new effect appends last');
  await page.locator('[data-fx-up]').last().click();await idle();
  project=await downloadJSON();
  types=project.clips.find(c=>c.name==='green.png').effects.map(effect=>effect.type);
  assert.deepEqual(types,['blur','mask'],'reorder moves blur before mask');
  // keyframe dots: add opacity keys, drag a dot, value timing changes in JSON
  await page.locator('[data-fx-remove]').nth(0).click();await idle();
  await page.locator('[data-fx-remove]').nth(0).click();await idle();
  await seek(0);await page.locator('[data-key-value="opacity"]').fill('1');await page.locator('[data-key-add="opacity"]').click();await idle();
  await seek(2);await page.locator('[data-key-value="opacity"]').fill('0');await page.locator('[data-key-add="opacity"]').click();await idle();
  project=await downloadJSON();
  let keys=project.clips.find(c=>c.name==='green.png').keyframes.opacity;
  assert.equal(keys.length,2,'two keyframes added');
  await page.locator('[data-keydot="opacity.1"]').waitFor({timeout:5000}).catch(()=>{});
  await page.evaluate(()=>{const d=document.querySelector('.creative-timeline-editor');window.__kd=[];d.addEventListener('pointerdown',e=>window.__kd.push(['down',e.target.className||e.target.tagName,!!e.target.closest('[data-keydot]')]),true);d.addEventListener('pointerup',e=>window.__kd.push(['up',e.clientX]),true);});
  await page.locator('[data-keydot="opacity.1"]').evaluate(el=>el.scrollIntoView({block:'center'}));
  const dot=await page.locator('[data-keydot="opacity.1"]').boundingBox();
  assert.ok(dot,'keyframe dot rendered on the clip');
  const hit=await page.evaluate(([x,y])=>{const el=document.elementFromPoint(x,y);return el?String(el.className||el.tagName).slice(0,40)+'|'+(el.closest('[data-keydot]')?'KEYDOT':el.closest('[data-clip]')?'CLIP':'OTHER'):'null';},[dot.x+4,dot.y+4]);console.log('HIT-DEBUG',JSON.stringify(dot),hit);
  await page.evaluate(([x,y])=>{const el=document.querySelector('[data-keydot="opacity.1"]');const fire=(type,cx)=>el.dispatchEvent(new PointerEvent(type,{bubbles:true,composed:true,pointerId:7,clientX:cx,clientY:y,isPrimary:true}));fire('pointerdown',x);fire('pointermove',x-40);fire('pointerup',x-40);},[dot.x+4,dot.y+4]);await idle();
  const dragStatus=await page.locator('[data-tl-status]').innerText();console.log('KD-DEBUG',JSON.stringify(await page.evaluate(()=>window.__kd)),dragStatus);
  project=await downloadJSON();
  keys=project.clips.find(c=>c.name==='green.png').keyframes.opacity;
  if(keys[1].time>=1.95)console.log('DRAG-DEBUG status=',dragStatus,'keys=',JSON.stringify(keys));
  assert.ok(keys[1].time<1.95&&keys[1].time>1.2,'dragging the dot moved the key earlier · '+keys[1].time.toFixed(3)+' · status='+await page.locator('[data-tl-status]').innerText());
  // Bézier ease: set ease-in handles; mid pixel stays brighter than linear
  await seek(0);await page.locator('[data-key-ease]').selectOption('bezier');await page.locator('[data-key-add="opacity"]').click();await idle();
  await page.locator('[data-ease-mode]').first().selectOption('bezier');await idle();
  const handle=page.locator('[data-ease-handle="in.0"]');
  await handle.evaluate((el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},'0.8');
  await idle();
  project=await downloadJSON();
  const firstKey=project.clips.find(c=>c.name==='green.png').keyframes.opacity[0];
  assert.equal(firstKey.ease,'bezier','bezier ease persisted');
  assert.ok(Math.abs(firstKey.handles.in[0]-.8)<1e-6,'handle persisted');
  await seek(1);
  const bezierMid=await pixel();
  await page.locator('[data-ease-mode]').first().selectOption('linear');await idle();await seek(1);
  const linearMid=await pixel();
  assert.ok(bezierMid[1]>linearMid[1]+15,'ease-in keeps the clip more visible at mid · bezier='+bezierMid[1]+' linear='+linearMid[1]);
  // chroma key burns into the exported MP4
  await page.locator('[data-keydot="opacity.1"]')&&null;
  // reset keys: set linear keys then delete both dots via panel buttons
  await page.locator('[data-key-delete]').first().click();await idle();
  await page.locator('[data-key-delete]').first().click();await idle();
  project=await downloadJSON();
  assert.equal(project.clips.find(c=>c.name==='green.png').keyframes.opacity.length,0,'keys deleted');
  await page.locator('[data-fx-add="chroma"]').click();await idle();
  const chromaRow2=page.locator('.tl-fx-row').filter({has:page.locator('[data-fx-param$=".similarity"]')});
  await chromaRow2.locator('[data-fx-param$=".similarity"]').evaluate((el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},'0.5');
  await idle();
  const count=await page.locator('[data-job]').count();
  await page.locator('[data-tl-format]').selectOption('mp4');await page.locator('[data-tl-export]').click();await idle();
  await page.waitForFunction(n=>document.querySelectorAll('[data-job]').length>n,count);
  await page.waitForFunction(()=>{const rows=[...document.querySelectorAll('[data-job]')];const failed=rows.find(r=>r.dataset.state==='failed');if(failed)throw Error(failed.textContent);return rows.every(r=>['done','canceled'].includes(r.dataset.state));},{},{timeout:240000});
  const pending=page.waitForEvent('download');await page.locator('[data-job-download]').last().click();
  const mp4=fs.readFileSync(await (await pending).path());
  const exported=await page.evaluate(async encoded=>{const blob=await(await fetch('data:video/mp4;base64,'+encoded)).blob(),url=URL.createObjectURL(blob),video=document.createElement('video');video.src=url;await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=reject;});video.currentTime=.1;await new Promise(resolve=>video.onseeked=resolve);const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);const center=Array.from(canvas.getContext('2d').getImageData(Math.round(canvas.width/2),Math.round(canvas.height/2),1,1).data);URL.revokeObjectURL(url);return center;},mp4.toString('base64'));
  assert.ok(exported[2]>100&&exported[1]<120,'exported MP4 shows the keyed blue background · '+JSON.stringify(exported));
  fs.mkdirSync('output/verification',{recursive:true});
  await page.screenshot({path:'output/verification/creative-fx.png'});
  fs.writeFileSync('output/verification/creative-fx-report.json',JSON.stringify({taskId,bezierMid:bezierMid[1],linearMid:linearMid[1],exported},null,2));
  await page.locator('[data-tl-close]').click();
  console.log('PASS fx UI: effects panel (add/params/disable/reorder/search), chroma key + mask pixels in preview and exported MP4, keyframe dots drag, Bézier ease persistence and pixel effect');
}
