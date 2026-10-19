import assert from 'node:assert/strict';
import fs from 'node:fs';
import {newTimeline,newClip,validateTimeline} from '../../ui/creative-timeline-model.js';
import {copyProperties,pasteProperties,detachAudio,addMarker,setRange} from '../../ui/creative-editing.js';

/** Model checks for cycle 5: track mixer/lock fields, markers/range validation, and property copy semantics. */
export function checkAudioModel(){
  const project=newTimeline();project.taskId='task_model_audio';
  const asset={id:'asset_a',name:'voice.mp4',kind:'video',duration:10,path:'assets/timeline/00000000-0000-0000-0000-00000000000c.mp4',bytes:1000};
  project.assets.push(asset);
  for(const track of project.tracks){track.volume=1.4;track.pan=-.5;track.locked=false;}
  project.tracks[0].locked=true;project.tracks[2].solo=true;project.tracks[1].targeted=true;
  const clip={...newClip(project.tracks[0],asset,0),duration:2};
  project.clips.push(clip);
  addMarker(project,1.25,'لقطة افتتاحية');setRange(project,.5,3.5);
  validateTimeline(project);
  assert.equal(project.tracks[0].locked,true);assert.equal(project.tracks[1].targeted,true);assert.equal(project.tracks[2].solo,true);
  // copy/paste touches presentation only
  const props=copyProperties(clip);props.volume=.15;props.transition='dissolve';props.transitionDuration=.9;
  const target={...newClip(project.tracks[1],asset,5),duration:2};
  project.clips.push(target);
  pasteProperties(target,props);
  assert.equal(target.volume,.15);assert.equal(target.transition,'dissolve');assert.equal(target.start,5);assert.equal(target.duration,2);
  validateTimeline(project);
  // detach creates a grouped audio-track twin and silences the original
  const audio=detachAudio(project,clip.id);
  assert.equal(audio.trackId,project.tracks[2].id);assert.equal(clip.volume,0);assert.equal(clip.group,audio.group);
  validateTimeline(project);
  // invalid track fields, markers, and ranges are rejected
  const restore={...project.tracks[0]};
  for(const [bad,apply] of [['volume above 2',()=>{project.tracks[0].volume=2.5;}],['pan below -1',()=>{project.tracks[0].pan=-1.5;}],['solo non-boolean',()=>{project.tracks[0].solo='yes';}],['bad marker time',()=>{project.markers=[{id:'m',time:-2,label:''}];}],['range out before in',()=>{project.range={in:2,out:1};}]]){
    apply();
    assert.throws(()=>validateTimeline(project),Error,bad+' must be rejected');
    project.tracks[0]={...restore,locked:true};project.markers=[{id:'m',time:1.25,label:'x'}];project.range={in:.5,out:3.5};
  }
  validateTimeline(project);
  console.log('PASS audio/mixer model: track volume/pan/solo/lock/target validation, markers and ranges, property copy semantics, detach grouping');
}

/** Browser flow for cycle 5: track locking/targeting, groups and audio detach, property copy/paste, markers and in/out range, the mixer (levels/pan/solo + meters), voice-over recording, and export honoring track volume. */
export async function checkAudioUI(page,fixtures,{taskId,base}){
  const idle=()=>page.waitForFunction(()=>!document.querySelector('.creative-timeline-editor fieldset')?.disabled&&!document.querySelector('.creative-import-dialog [data-import-apply][disabled]'));
  const editor=page.locator('.creative-timeline-editor');
  if(!await editor.count()||!await editor.evaluate(el=>el.open)){await page.locator('[data-timeline-open]').click();await page.locator('.creative-timeline-editor canvas[aria-label]').waitFor();}
  const status=async()=>await page.locator('[data-tl-status]').innerText();
  const downloadJSON=async()=>{const pending=page.waitForEvent('download');await page.locator('[data-tl-download]').click();const file=await pending;await idle();return JSON.parse(fs.readFileSync(await file.path()));};
  const confirmImport=async()=>{await page.waitForFunction(()=>{const button=document.querySelector('.creative-import-dialog [data-import-apply]');return button&&!button.disabled;},{},{timeout:120000});await page.locator('.creative-import-dialog [data-import-apply]').click();await page.waitForFunction(()=>!document.querySelector('.creative-import-dialog'));await idle();};
  // clean controlled project: one video + one tone on the audio track
  const baseline=await downloadJSON();
  baseline.assets=[];baseline.clips=[];baseline.tracks=baseline.tracks.filter(t=>t.role!=='subtitles');
  baseline.tracks=baseline.tracks.slice(0,3);for(const t of baseline.tracks){delete t.locked;delete t.targeted;delete t.volume;delete t.pan;delete t.solo;}
  await page.locator('[data-tl-project]').setInputFiles({name:'fresh.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(baseline))});
  await idle();
  await page.locator('[data-tl-seek]').fill('0');await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();
  const videoBuffer=Buffer.from(fixtures.video.split(',')[1],'base64');
  const tone=seconds=>{const count=Math.round(44100*seconds),b=Buffer.alloc(44+count*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(44100,24);b.writeUInt32LE(88200,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(count*2,40);for(let i=0;i<count;i++)b.writeInt16LE(Math.round(Math.sin(i*440*2*Math.PI/44100)*12000),44+i*2);return b;};
  await page.locator('[data-tl-files]').setInputFiles([{name:'clip.webm',mimeType:'video/webm',buffer:videoBuffer},{name:'tone.wav',mimeType:'audio/wav',buffer:tone(3)}]);
  await confirmImport();
  let project=await downloadJSON();
  project.clips.sort((a,b)=>a.start-b.start);
  const video=project.clips.find(c=>c.name==='clip.webm'),audioClip=project.clips.find(c=>c.name==='tone.wav');
  const seek=async time=>{await page.locator('[data-tl-seek]').fill(String(time));await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();};
  const clickClip=async clip=>{await page.locator('[data-clip]').filter({hasText:clip.name}).first().evaluate(el=>el.scrollIntoView({block:'center'}));await page.locator('[data-clip]').filter({hasText:clip.name}).first().click();await idle();};
  // track locking blocks edits with a clear error and unlocking restores them
  const firstTrackId=video.trackId;
  await clickClip(video);
  await page.locator('[data-clip-field=duration]').fill('1.5');await page.locator('[data-clip-field=duration]').press('Tab');await idle();
  await page.locator('[data-track-lock="'+firstTrackId+'"]').click();await idle();
  await clickClip(video);
  await page.locator('[data-tl-slip="0.2"]').click();await idle();
  assert.match(await status(),/مقفل/,'locked track rejects edits');
  assert.equal((await downloadJSON()).clips.find(c=>c.id===video.id).in,0,'locked edit changed nothing');
  await page.locator('[data-tl-split]').click();await idle();
  assert.match(await status(),/مقفل/,'locked track rejects split');
  await page.locator('[data-track-lock="'+firstTrackId+'"]').click();await idle();
  await page.locator('[data-tl-slip="0.2"]').click();await idle();
  assert.ok((await downloadJSON()).clips.find(c=>c.id===video.id).in>0,'unlocked track accepts edits again');
  // targeting sends library insertions to the targeted track
  await page.locator('[data-track-target="'+baseline.tracks[1].id+'"]').click();await idle();
  await seek(0);
  await page.locator('[data-tl-asset]').filter({hasText:'clip.webm'}).click();await idle();
  project=await downloadJSON();
  const inserted=project.clips.filter(c=>c.name==='clip.webm');
  assert.ok(inserted.some(c=>c.trackId===baseline.tracks[1].id),'targeted track receives library insertions');
  // property copy/paste applies presentation only
  await clickClip(video);
  await page.locator('[data-clip-field=volume]').fill('0.4');await page.locator('[data-clip-field=volume]').press('Tab');await idle();
  await page.locator('[data-tl-copy-props]').click();await idle();
  await clickClip(audioClip);
  await page.locator('[data-tl-paste-props]').click();await idle();
  project=await downloadJSON();
  const pastedAudio=project.clips.find(c=>c.id===audioClip.id);
  assert.ok(Math.abs(pastedAudio.volume-.4)<1e-6,'pasted volume lands on the target');
  assert.equal(pastedAudio.start,audioClip.start,'paste never moves the target');
  // markers: add with label, seek, delete; in/out range clamps seeking
  await seek(1.2);
  await page.locator('[data-tl-marker]').click();await idle();
  await page.locator('[data-marker-label]').first().fill('مراجعة هنا');
  await page.locator('[data-marker-label]').first().press('Tab');await idle();
  project=await downloadJSON();
  assert.equal(project.markers.length,1);assert.ok(Math.abs(project.markers[0].time-1.2)<1e-6);assert.equal(project.markers[0].label,'مراجعة هنا');
  assert.equal(await page.locator('[data-marker-label]').first().inputValue(),'مراجعة هنا','marker note persists in the list');
  await seek(0.2);
  await page.locator('[data-tl-range-in]').click();await idle();
  await seek(1.2);
  await page.locator('[data-tl-range-out]').click();await idle();
  project=await downloadJSON();
  assert.ok(project.range.in>.1&&project.range.in<.35&&project.range.out>1&&project.range.out<1.35,'in/out captured at the playhead');
  await page.locator('[data-tl-seek]').fill('3');await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();
  const clampedTime=await page.locator('[data-tl-time]').innerText();
  assert.ok(parseFloat(clampedTime)<=project.range.out+.01,'seeking clamps to the out point');
  await page.locator('[data-marker-goto]').first().click();await idle();
  const afterGoto=await page.locator('[data-tl-time]').innerText();
  assert.ok(Math.abs(parseFloat(afterGoto)-1.2)<.05||parseFloat(afterGoto)<=project.range.out,'marker goto seeks (respecting the range)');
  await page.locator('[data-tl-range-clear]').click();await idle();
  assert.equal((await downloadJSON()).range,undefined,'range clears');
  await page.locator('[data-marker-delete]').first().click();await idle();
  assert.equal((await downloadJSON()).markers.length,0,'markers delete');
  // detach audio groups video+audio and ungroup frees them
  await clickClip(video);
  await page.locator('[data-tl-detach-audio]').click();await idle();
  project=await downloadJSON();
  const detached=project.clips.find(c=>c.name.startsWith('صوت · ')&&c.assetId===video.assetId);
  assert.ok(detached,'detach creates an audio-track twin');
  assert.equal(project.clips.find(c=>c.id===video.id).volume,0,'original video silenced after detach');
  assert.ok(detached.group&&detached.group===project.clips.find(c=>c.id===video.id).group,'detach groups the pair');
  const preDrag=await downloadJSON();
  const preVideo=preDrag.clips.find(c=>c.id===video.id),preDetached=preDrag.clips.find(c=>c.id===detached.id);
  if(!preVideo.group||preVideo.group!==preDetached.group)throw new Error('group lost before drag · v.group='+preVideo.group+' a.group='+preDetached.group);
  const videoBefore=preVideo.start;
  const box=await page.locator('[data-clip]').filter({hasText:'clip.webm'}).first().evaluate(el=>{el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x,y:r.y};});
  await page.mouse.move(box.x+15,box.y+15);await page.mouse.down();await page.mouse.move(box.x+55,box.y+15,{steps:6});await page.mouse.up();await idle();
  project=await downloadJSON();
  const videoAfter=project.clips.find(c=>c.id===video.id).start,detachedAfter=project.clips.find(c=>c.id===detached.id).start;
  assert.ok(Math.abs((videoAfter-videoBefore)-(detachedAfter-detached.start))<1e-6&&videoAfter!==videoBefore,'grouped pair moves together · v '+videoBefore+'->'+videoAfter+' a '+detached.start+'->'+detachedAfter+' status='+await status());
  await clickClip(video);
  await page.locator('[data-tl-ungroup]').click();await idle();
  assert.equal((await downloadJSON()).clips.find(c=>c.id===video.id).group,undefined,'ungroup frees the clips');
  // mixer: volume/pan/solo persist; meters react during playback; mute silences
  const mixer=page.locator('.tl-mixer');
  if(!await mixer.evaluate(el=>el.open))await mixer.locator('summary').click();
  const musicRow=page.locator('[data-mix-track="'+audioClip.trackId+'"]');
  await musicRow.locator('[data-mix-pan]').evaluate((el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},'-0.6');
  await idle();
  project=await downloadJSON();
  assert.ok(Math.abs(project.tracks.find(t=>t.id===audioClip.trackId).pan+.6)<1e-6,'pan persists on the track');
  await musicRow.locator('[data-mix-solo]').click();await idle();
  assert.equal((await downloadJSON()).tracks.find(t=>t.id===audioClip.trackId).solo,true,'solo persists');
  await musicRow.locator('[data-mix-solo]').click();await idle();
  await seek(0);await page.locator('[data-tl-play]').click();
    await page.waitForFunction(()=>parseFloat(document.querySelector('[data-tl-meter-text]').textContent)>-40,{},{timeout:15000});
  const peakWhilePlaying=await page.locator('[data-tl-meter-text]').innerText();
  await page.locator('[data-tl-play]').click();await idle();
  await musicRow.locator('[data-mix-mute]').click();await idle();
  await page.locator('[data-tl-play]').click();
  await page.waitForFunction(()=>document.querySelector('[data-tl-meter-bar]').style.width==='0%'||parseFloat(document.querySelector('[data-tl-meter-text]').textContent)<-55,{},{timeout:15000});
  await page.locator('[data-tl-play]').click();await idle();
  await musicRow.locator('[data-mix-mute]').click();await idle();
  assert.ok(parseFloat(peakWhilePlaying)>-40,'meter reads signal while playing ('+peakWhilePlaying+')');
  // waveforms render on audio-bearing clips
  await page.waitForFunction(()=>document.querySelector('.tl-clip.tl-wave'),{},{timeout:20000});
  assert.ok(await page.locator('.tl-clip.tl-wave').count()>=1,'audio-bearing clips show waveform backgrounds');
  // voice-over recording with the fake microphone becomes an asset+clip
  const assetsBefore=(await downloadJSON()).assets.length;
  await page.locator('[data-tl-record]').click();
  await page.waitForFunction(()=>document.querySelector('[data-tl-record]')?.textContent.includes('إيقاف'),{},{timeout:15000});
  await page.waitForTimeout(1500);
  await page.locator('[data-tl-record]').click();
  let recordStatus='';
  for(let i=0;i<60;i++){
    recordStatus=await status();
    if(/سُجّل|تعذّر|فارغ|غير صالح|ميكروفون|فشل/.test(recordStatus))break;
    await page.waitForTimeout(500);
  }
  const afterRecord=await downloadJSON();
  assert.ok(afterRecord.assets.length>assetsBefore,'recording lands as an asset · status='+recordStatus);
  assert.ok(afterRecord.clips.some(c=>c.name.startsWith('تعليق صوتي')),'recorded clip added');
  assert.ok(afterRecord.assets.find(a=>a.name.startsWith('تعليق صوتي')).duration>0,'recorded asset has a real duration');
  // recording failure path: a denied microphone reports clearly without changes
  await page.evaluate(()=>{const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);window.__restoreMic=()=>{navigator.mediaDevices.getUserMedia=original;};navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException('Permission denied','NotAllowedError'));});
  const beforeFailed=(await downloadJSON()).assets.length;
  await page.locator('[data-tl-record]').click();await idle();
  assert.match(await status(),/تعذّر|Permission|ميكروفون|رفض/i,'denied microphone reports clearly');
  assert.equal((await downloadJSON()).assets.length,beforeFailed,'failed recording adds nothing');
  await page.evaluate(()=>window.__restoreMic());
  // export honors track volume: mute the tone track, exported RMS drops
  const musicTrack=project.tracks.find(t=>t.id===audioClip.trackId);
  const setTrackVolume=async(trackId,value)=>{await page.locator('[data-mix-volume="'+trackId+'"]').evaluate((el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},String(value));await idle();};
  for(const track of project.tracks)await setTrackVolume(track.id,.05);
  await idle();
  const decodeRms=async bytes=>await page.evaluate(async encoded=>{const ctx=new AudioContext();try{const audio=await ctx.decodeAudioData(Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)).buffer),samples=audio.getChannelData(0);return Math.sqrt(samples.reduce((sum,v)=>sum+v*v,0)/samples.length);}finally{await ctx.close();}},bytes.toString('base64'));
  const runExport=async()=>{
    const count=await page.locator('[data-job]').count();
    await page.locator('[data-tl-format]').selectOption('mp4');await page.locator('[data-tl-export]').click();await idle();
    await page.waitForFunction(n=>document.querySelectorAll('[data-job]').length>n,count);
    await page.waitForFunction(()=>{const rows=[...document.querySelectorAll('[data-job]')];const failed=rows.find(r=>r.dataset.state==='failed');if(failed)throw Error(failed.textContent);return rows.every(r=>['done','canceled'].includes(r.dataset.state));},{},{timeout:180000});
    const pending=page.waitForEvent('download');await page.locator('[data-job-download]').last().click();
    return fs.readFileSync(await (await pending).path());
  };
  const quietBytes=await runExport();
  const quietRms=await decodeRms(quietBytes);
  for(const track of project.tracks)await setTrackVolume(track.id,1);
  await idle();
  const loudBytes=await runExport();
  const loudRms=await decodeRms(loudBytes);
  assert.ok(quietRms<loudRms*.45,'track volume shapes the exported mix · quiet='+quietRms.toFixed(4)+' loud='+loudRms.toFixed(4));
  fs.mkdirSync('output/verification',{recursive:true});
  fs.writeFileSync('output/verification/creative-audio-report.json',JSON.stringify({taskId,quietRms,loudRms,pan:-0.6},null,2));
  await page.screenshot({path:'output/verification/creative-audio.png'});
  await page.locator('[data-tl-close]').click();
  console.log('PASS audio studio UI: track lock/target, groups + detach, property copy/paste, markers + in/out range, mixer volume/pan/solo with live meters and mute, clip waveforms, fake-mic voice-over with denied-permission path, export honors track volume');
}
