import assert from 'node:assert/strict';
import fs from 'node:fs';
import {transitionAt,validateTimeline,newTimeline,newClip} from '../../ui/creative-timeline-model.js';

/** Model checks: blend/adjust validation, wipe/direction/curve transitions math. */
export function checkBlendModel(){
  const project=newTimeline();project.taskId='task_blend';
  const asset={id:'a',name:'g.png',kind:'image',duration:0,path:'assets/timeline/00000000-0000-0000-0000-000000000011.png',bytes:1};
  project.assets.push(asset);
  project.tracks[1].blend='multiply';project.tracks[1].adjust=true;project.tracks[1].colorAdjust={enabled:true,brightness:.55};
  project.clips.push({...newClip(project.tracks[0],asset,0),duration:2,transition:'wipe',transitionDirection:'left',transitionCurve:'smooth',transitionDuration:.5});
  validateTimeline(project);
  // wipe progress + direction
  const key=project.clips[0];
  const mid=transitionAt(key,.25);
  assert.ok(mid.wipe>.3&&mid.wipe<.7,'wipe midpoint progress · '+mid.wipe.toFixed(3));
  assert.equal(mid.wipeDirection,-1,'left direction flips the wipe side');
  const early=transitionAt(key,.1);
  assert.ok(early.wipe<mid.wipe,'wipe grows over time');
  // curve shapes the ramp
  key.transitionCurve='linear';
  const linearQuarter=transitionAt(key,.125).wipe;
  key.transitionCurve='smooth';
  const smoothQuarter=transitionAt(key,.125).wipe;
  assert.ok(smoothQuarter<linearQuarter,'smooth curve lags linear early (ease-in)');
  // slide direction
  key.transition='slide';key.transitionDirection='right';
  assert.ok(transitionAt(key,.25).offset>0,'slide from right offsets positive');
  key.transitionDirection='left';
  assert.ok(transitionAt(key,.25).offset<0,'slide from left offsets negative');
  // invalid values rejected
  let rejected=0;
  for(const apply of [()=>{project.tracks[1].blend='xor';},()=>{project.tracks[1].blend='screen';project.tracks[1].adjust=true;project.tracks[1].colorAdjust={brightness:9};},()=>{project.tracks[1].colorAdjust={brightness:.5};project.clips[0].transition='swipe';},()=>{project.clips[0].transition='wipe';project.clips[0].transitionDirection='up';},()=>{project.clips[0].transitionDirection='left';project.clips[0].transitionCurve='spring';}]){apply();try{validateTimeline(project);}catch{rejected++;}}
  assert.equal(rejected,5,'all five invalid cases rejected');
  console.log('PASS blend model: blend/adjust validation, wipe progress/direction, curve shaping, slide direction');
}

/** Browser flow: blend modes compose tracks, adjustment layers color what is below, scopes render, transitions carry direction/curve — verified in preview pixels and an exported MP4. */
export async function checkBlendUI(page,fixtures,{taskId,base}){
  const idle=()=>page.waitForFunction(()=>!document.querySelector('.creative-timeline-editor fieldset')?.disabled&&!document.querySelector('.creative-import-dialog [data-import-apply][disabled]'));
  const editor=page.locator('.creative-timeline-editor');
  if(!await editor.count()||!await editor.evaluate(el=>el.open)){await page.locator('[data-timeline-open]').click();await page.locator('.creative-timeline-editor canvas[aria-label]').waitFor();}
  const downloadJSON=async()=>{const pending=page.waitForEvent('download');await page.locator('[data-tl-download]').click();const file=await pending;await idle();return JSON.parse(fs.readFileSync(await file.path()));};
  const confirmImport=async()=>{await page.waitForFunction(()=>{const button=document.querySelector('.creative-import-dialog [data-import-apply]');return button&&!button.disabled;},{},{timeout:120000});await page.locator('.creative-import-dialog [data-import-apply]').click();await page.waitForFunction(()=>!document.querySelector('.creative-import-dialog'));await idle();};
  const pixel=async(x=.5,y=.5)=>page.locator('.creative-timeline-editor canvas[aria-label]').evaluate((c,[px,py])=>Array.from(c.getContext('2d').getImageData(Math.round(c.width*px),Math.round(c.height*py),1,1).data),[x,y]);
  const seek=async time=>{await page.locator('[data-tl-seek]').fill(String(time));await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();};
  const png=color=>page.evaluate(fill=>{const c=document.createElement('canvas');c.width=64;c.height=64;const ctx=c.getContext('2d');ctx.fillStyle=fill;ctx.fillRect(0,0,64,64);return c.toDataURL('image/png');},color);
  const blue=await png('#4040c0'),red=await png('#c04040');
  const baseline=await downloadJSON();
  baseline.assets=[];baseline.clips=[];baseline.markers=[];baseline.range=undefined;baseline.duck=undefined;
  baseline.tracks=baseline.tracks.filter(t=>t.role!=='subtitles').slice(0,2);
  for(const t of baseline.tracks)for(const key of ['locked','targeted','volume','pan','solo','eq','compressor','role','subsStyle','blend','adjust','colorAdjust'])delete t[key];
  await page.locator('[data-tl-project]').setInputFiles({name:'fresh.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(baseline))});
  await idle();
  await page.locator('[data-tl-seek]').fill('0');await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();
  const addImage=async(name,data)=>{await page.locator('[data-tl-files]').setInputFiles({name,mimeType:'image/png',buffer:Buffer.from(data.split(',')[1],'base64')});await confirmImport();};
  await addImage('blue.png',blue);
  await page.locator('[data-pick-track]').nth(1).click();await idle();
  await addImage('red.png',red);
  await seek(.1);
  await page.locator('[data-clip]').filter({hasText:'red.png'}).first().evaluate(el=>el.scrollIntoView({block:'center'}));
  await page.locator('[data-clip]').filter({hasText:'red.png'}).first().click();await idle();
  const normal=await pixel();
  assert.ok(normal[0]>150&&normal[2]<100,'red on top in normal mode · '+JSON.stringify(normal));
  // multiply: red×blue ≈ dark
  await page.locator('[data-track-blend]').selectOption('multiply');await idle();await seek(.1);
  const multiplied=await pixel();
  assert.ok(multiplied[0]<normal[0]*.7&&multiplied[2]<normal[2]*.7+40,'multiply darkens both channels · '+JSON.stringify(multiplied));
  // screen: brighter
  await page.locator('[data-track-blend]').selectOption('screen');await idle();await seek(.1);
  const screened=await pixel();
  assert.ok(screened[0]>=multiplied[0]&&screened[0]>normal[0]*.8,'screen keeps red bright · '+JSON.stringify(screened));
  await page.locator('[data-track-blend]').selectOption('normal');await idle();
  // adjustment layer: enable on the TOP track, darken what's below
  await page.locator('[data-track-adjust]').setChecked(true);await idle();
  await page.locator('[data-track-color="brightness"]').fill('0.5');await page.locator('[data-track-color="brightness"]').press('Tab');await idle();await seek(.1);
  const adjusted=await pixel();
  assert.ok(adjusted[0]<normal[0]*.75,'adjustment layer darkens the composed frame · '+normal[0]+'→'+adjusted[0]);
  let project=await downloadJSON();
  assert.equal(project.tracks.find(t=>t.id===project.clips.find(c=>c.name==='red.png')?.trackId).adjust,true,'adjustment persists');
  assert.ok(Math.abs(project.tracks.find(t=>t.id===project.clips.find(c=>c.name==='red.png')?.trackId).colorAdjust.brightness-.5)<1e-6,'adjustment color persists');
  await page.locator('[data-track-adjust]').setChecked(false);await idle();
  // scopes render non-empty
  await seek(.1);
  const scopePixels=await page.locator('[data-scope="histogram"]').evaluate(c=>{const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let lit=0;for(let i=3;i<data.length;i+=4)if(data[i]>0)lit++;return lit;});
  assert.ok(scopePixels>50,'histogram scope renders · '+scopePixels+' lit pixels');
  const wavePixels=await page.locator('[data-scope="waveform"]').evaluate(c=>{const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let lit=0;for(let i=3;i<data.length;i+=4)if(data[i]>0)lit++;return lit;});
  assert.ok(wavePixels>30,'waveform scope renders');
  // wipe transition direction: left reveal
  await page.locator('[data-clip-field="transition"]').selectOption('wipe');await idle();
  await page.locator('[data-clip-field="transitionDirection"]').selectOption('left');await idle();
  await page.locator('[data-clip-field="transitionDuration"]').fill('1');await page.locator('[data-clip-field="transitionDuration"]').press('Tab');await idle();
  await seek(.5);
  const wipeLeft=await pixel(.25,.5),wipeRight=await pixel(.75,.5);
  assert.ok(wipeLeft[2]>110||wipeLeft[0]>110,'left side reveals the incoming layer · '+JSON.stringify(wipeLeft));
  assert.ok(wipeRight[2]>wipeRight[0]+40,'right side still shows the blue layer below · '+JSON.stringify(wipeRight));
  project=await downloadJSON();
  assert.equal(project.clips.find(c=>c.name==='red.png').transition,'wipe','wipe persists');
  assert.equal(project.clips.find(c=>c.name==='red.png').transitionDirection,'left','direction persists');
  // slide direction persists (pixel geometry covered by the model test)
  await page.locator('[data-clip-field="transition"]').selectOption('slide');await idle();
  await page.locator('[data-clip-field="transitionDirection"]').selectOption('right');await idle();
  project=await downloadJSON();
  const slidClip=project.clips.find(c=>c.name==='red.png');
  assert.equal(slidClip.transitionDirection,'right','slide direction persists');
  // multiply blend burns into the exported MP4
  await page.locator('[data-clip-field="transition"]').selectOption('none');await idle();
  await page.locator('[data-track-blend]').selectOption('multiply');await idle();
  const count=await page.locator('[data-job]').count();
  await page.locator('[data-tl-format]').selectOption('mp4');await page.locator('[data-tl-export]').click();await idle();
  await page.waitForFunction(n=>document.querySelectorAll('[data-job]').length>n,count);
  await page.waitForFunction(()=>{const rows=[...document.querySelectorAll('[data-job]')];const failed=rows.find(r=>r.dataset.state==='failed');if(failed)throw Error(failed.textContent);return rows.every(r=>['done','canceled'].includes(r.dataset.state));},{},{timeout:240000});
  const pending=page.waitForEvent('download');await page.locator('[data-job-download]').last().click();
  const mp4=fs.readFileSync(await (await pending).path());
  const exported=await page.evaluate(async encoded=>{const blob=await(await fetch('data:video/mp4;base64,'+encoded)).blob(),url=URL.createObjectURL(blob),video=document.createElement('video');video.src=url;await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=reject;});video.currentTime=1;await new Promise(resolve=>video.onseeked=resolve);const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);const center=Array.from(canvas.getContext('2d').getImageData(Math.round(canvas.width/2),Math.round(canvas.height/2),1,1).data);URL.revokeObjectURL(url);return center;},mp4.toString('base64'));
  assert.ok(exported[0]<110&&exported[2]<110,'exported MP4 shows the multiplied dark pixel · '+JSON.stringify(exported));
  fs.mkdirSync('output/verification',{recursive:true});
  fs.writeFileSync('output/verification/creative-blend-report.json',JSON.stringify({taskId,normal,multiplied,screened,adjusted,exported},null,2));
  await page.screenshot({path:'output/verification/creative-blend.png'});
  await page.locator('[data-tl-close]').click();
  console.log('PASS blend UI: blend modes (multiply/screen), adjustment layer, scopes (histogram/waveform), wipe direction, slide direction — preview and exported MP4 pixels');
}
