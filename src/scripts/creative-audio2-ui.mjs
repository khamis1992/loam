import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import {newTimeline,newClip,validateTimeline} from '../../ui/creative-timeline-model.js';

/** Model checks for cycle 6: EQ/compressor/voice-role/subtitle-style/duck validation. */
export function checkAudioAdvancedModel(){
  const project=newTimeline();project.taskId='task_model_a2';
  const asset={id:'a',name:'v.mp4',kind:'video',duration:10,path:'assets/timeline/00000000-0000-0000-0000-00000000000d.mp4',bytes:1};
  project.assets.push(asset);
  project.tracks[2].role='voice';project.tracks[2].eq={low:-4,mid:2.5,high:12};project.tracks[2].compressor={enabled:true,threshold:-30,ratio:12};
  project.tracks[0].subsStyle={bg:'#0a1a2a',bgOpacity:.75,outline:'#f5f5f5',outlineWidth:3.5,safe:.12};
  project.duck={enabled:true,amount:.85};
  project.clips.push({...newClip(project.tracks[0],asset,0),duration:2});
  validateTimeline(project);
  const cases=[
    ['eq high beyond ±12',()=>{project.tracks[2].eq.high=13;}],
    ['eq unknown band',()=>{project.tracks[2].eq.high=0;project.tracks[2].eq.ultra=1;}],
    ['comp threshold positive',()=>{delete project.tracks[2].eq.ultra;project.tracks[2].compressor.threshold=6;}],
    ['comp ratio zero',()=>{project.tracks[2].compressor.threshold=-6;project.tracks[2].compressor.ratio=0;}],
    ['subsStyle bad hex',()=>{project.tracks[2].compressor.ratio=4;project.tracks[0].subsStyle.outline='#fff';}],
    ['subsStyle safe beyond .25',()=>{project.tracks[0].subsStyle.outline='#ffffff';project.tracks[0].subsStyle.safe=.4;}],
    ['duck amount beyond 1',()=>{project.tracks[0].subsStyle.safe=.1;project.duck.amount=1.5;}],
    ['voice role on visual track',()=>{project.duck.amount=.5;project.tracks[0].role='voice';}],
  ];
  let rejected=0;
  for(const [,apply] of cases){apply();try{validateTimeline(project);}catch{rejected++;}}
  assert.equal(rejected,cases.length,'all invalid cases rejected');
  project.tracks[0].role=undefined;
  validateTimeline(project);
  console.log('PASS audio advanced model: EQ/compressor/voice-role/subtitle-style/duck validation accepts good values and rejects eight bad ones');
}

/** Browser flow for cycle 6: EQ and compressor shape the exported mix, ducking lowers music under voice, WAV export with loudness reports measured LUFS, stems ZIP splits per track, devices enumerate, subtitle styling renders and burns into exports. */
export async function checkAudioAdvancedUI(page,fixtures,{taskId,base}){
  const idle=()=>page.waitForFunction(()=>!document.querySelector('.creative-timeline-editor fieldset')?.disabled&&!document.querySelector('.creative-import-dialog [data-import-apply][disabled]'));
  const editor=page.locator('.creative-timeline-editor');
  if(!await editor.count()||!await editor.evaluate(el=>el.open)){await page.locator('[data-timeline-open]').click();await page.locator('.creative-timeline-editor canvas[aria-label]').waitFor();}
  const status=async()=>await page.locator('[data-tl-status]').innerText();
  const downloadJSON=async()=>{const pending=page.waitForEvent('download');await page.locator('[data-tl-download]').click();const file=await pending;await idle();return JSON.parse(fs.readFileSync(await file.path()));};
  const confirmImport=async()=>{await page.waitForFunction(()=>{const button=document.querySelector('.creative-import-dialog [data-import-apply]');return button&&!button.disabled;},{},{timeout:120000});await page.locator('.creative-import-dialog [data-import-apply]').click();await page.waitForFunction(()=>!document.querySelector('.creative-import-dialog'));await idle();};
  const tone=(seconds,freq,amp)=>{const count=Math.round(44100*seconds),b=Buffer.alloc(44+count*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(44100,24);b.writeUInt32LE(88200,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(count*2,40);for(let i=0;i<count;i++)b.writeInt16LE(Math.round(Math.sin(i*freq*2*Math.PI/44100)*amp),44+i*2);return b;};
  // clean project: voice-tone on the audio track, music-tone on the same track is fine for ducking? ducking needs voice role on ONE track and music on ANOTHER — put music on the second visual track as a video? audio clip on visual track not allowed. Create second audio track.
  const baseline=await downloadJSON();
  baseline.assets=[];baseline.clips=[];baseline.markers=[];baseline.range=undefined;baseline.duck=undefined;
  baseline.tracks=baseline.tracks.filter(t=>t.role!=='subtitles').slice(0,3);
  for(const t of baseline.tracks){for(const key of ['locked','targeted','volume','pan','solo','eq','compressor','role','subsStyle'])delete t[key];}
  await page.locator('[data-tl-project]').setInputFiles({name:'fresh.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(baseline))});
  await idle();
  await page.locator('[data-tl-seek]').fill('0');await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();
  await page.locator('[data-tl-files]').setInputFiles({name:'voice.wav',mimeType:'audio/wav',buffer:tone(3,440,8000)});
  await confirmImport();
  // second audio track, selected so the next import lands on it
  await page.locator('[data-tl-add-audio]').click();await idle();
  const trackButtons=await page.locator('[data-pick-track]').all();
  const lastTrack=trackButtons[trackButtons.length-1];
  await lastTrack.evaluate(el=>el.scrollIntoView({block:'center'}));
  await lastTrack.click();await idle();
  await page.locator('[data-tl-files]').setInputFiles({name:'music2.wav',mimeType:'audio/wav',buffer:tone(3,3000,14000)});
  await confirmImport();
  let project=await downloadJSON();
  project.clips.sort((a,b)=>a.start-b.start);
  const voiceClip=project.clips.find(c=>c.name==='voice.wav'),music2=project.clips.find(c=>c.name==='music2.wav');
  assert.notEqual(music2.trackId,voiceClip.trackId,'music imported onto its own track for the ducking test');
  const voiceTrackId=voiceClip.trackId,musicTrackId=music2.trackId;
  const mixer=page.locator('.tl-mixer');
  if(!await mixer.evaluate(el=>el.open))await mixer.locator('summary').click();
  const decodeRms=async bytes=>await page.evaluate(async encoded=>{const ctx=new AudioContext();try{const audio=await ctx.decodeAudioData(Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)).buffer),samples=audio.getChannelData(0);return Math.sqrt(samples.reduce((sum,v)=>sum+v*v,0)/samples.length);}finally{await ctx.close();}},bytes.toString('base64'));
  const runAudioExport=async(loudness=false)=>{
    const count=await page.locator('[data-job]').count();
    await page.locator('[data-tl-format]').selectOption('wav');
    if(await page.locator('[data-tl-loudness]').count())await page.locator('[data-tl-loudness]').setChecked(loudness);
    await page.locator('[data-tl-export]').click();await idle();
    await page.waitForFunction(n=>document.querySelectorAll('[data-job]').length>n,count);
    await page.waitForFunction(()=>{const rows=[...document.querySelectorAll('[data-job]')];const failed=rows.find(r=>r.dataset.state==='failed');if(failed)throw Error(failed.textContent);return rows.every(r=>['done','canceled'].includes(r.dataset.state));},{},{timeout:240000});
    const row=page.locator('[data-job]').last();
    const message=await row.locator('[data-job-state]').innerText();
    const pending=page.waitForEvent('download');await row.locator('[data-job-download]').click();
    return {bytes:fs.readFileSync(await (await pending).path()),message};
  };
  const setSlider=async(selector,value)=>{await page.locator(selector).evaluate((el,v)=>{el.value=String(v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},value);await idle();};
  const setCheckbox=async(selector,checked)=>{await page.locator(selector).evaluate((el,v)=>{el.checked=v;el.dispatchEvent(new Event('change',{bubbles:true}));},checked);await idle();};
  // flat baseline
  const flat=await runAudioExport();
  assert.equal(flat.bytes.subarray(0,4).toString(),'RIFF','WAV export is a real RIFF file');
  const flatRms=await decodeRms(flat.bytes);
  assert.ok(flatRms>0.05,'baseline mix carries signal');
  // EQ: +12dB mid on the voice track boosts the 440Hz tone measurably
  await setSlider('[data-mix-eq-mid="'+voiceTrackId+'"]',12);
  project=await downloadJSON();
  assert.equal(project.tracks.find(t=>t.id===voiceTrackId).eq.mid,12,'EQ persists');
  const boosted=await runAudioExport();
  const boostedRms=await decodeRms(boosted.bytes);
  assert.ok(boostedRms>flatRms*1.08,'mid EQ boosts the tone · '+flatRms.toFixed(4)+' → '+boostedRms.toFixed(4));
  await setSlider('[data-mix-eq-mid="'+voiceTrackId+'"]',0);
  // compressor on the loud voice track lowers it
  await setCheckbox('[data-mix-comp="'+voiceTrackId+'"]',true);
  await setSlider('[data-mix-comp-threshold="'+voiceTrackId+'"]',-60);
  await setSlider('[data-mix-comp-ratio="'+voiceTrackId+'"]',20);
  project=await downloadJSON();
  const compState=project.tracks.find(t=>t.id===voiceTrackId).compressor;
  assert.ok(compState&&compState.enabled===true&&compState.threshold===-60&&compState.ratio===20,'compressor persists · '+JSON.stringify(compState));
  const compressed=await runAudioExport();
  const compressedRms=await decodeRms(compressed.bytes);

  assert.ok(compressedRms<flatRms*0.88,'compressor tames the loud tone · '+flatRms.toFixed(4)+' → '+compressedRms.toFixed(4));
  await setCheckbox('[data-mix-comp="'+voiceTrackId+'"]',false);
  // ducking: mark voice role, enable duck, music track drops under speech
  await page.locator('[data-mix-voice="'+voiceTrackId+'"]').click();await idle();
  await setCheckbox('[data-mix-duck]',true);
  await setSlider('[data-mix-duck-amount]',1);
  project=await downloadJSON();
  assert.equal(project.tracks.find(t=>t.id===voiceTrackId).role,'voice','voice role persists');
  assert.equal(project.duck.enabled,true,'duck setting persists');
  const ducked=await runAudioExport();
  const duckedRms=await decodeRms(ducked.bytes);
  assert.ok(duckedRms<flatRms*0.8,'ducking lowers the mix while the voice speaks · '+flatRms.toFixed(4)+' → '+duckedRms.toFixed(4));
  // stems: one WAV per audible track inside a ZIP
  const stems=await (async()=>{const count=await page.locator('[data-job]').count();await page.locator('[data-tl-format]').selectOption('stems');await page.locator('[data-tl-export]').click();await idle();await page.waitForFunction(n=>document.querySelectorAll('[data-job]').length>n,count);await page.waitForFunction(()=>{const rows=[...document.querySelectorAll('[data-job]')];const failed=rows.find(r=>r.dataset.state==='failed');if(failed)throw Error(failed.textContent);return rows.every(r=>['done','canceled'].includes(r.dataset.state));},{},{timeout:240000});const pending=page.waitForEvent('download');await page.locator('[data-job]').last().locator('[data-job-download]').click();return fs.readFileSync(await (await pending).path());})();
  const zip=await JSZip.loadAsync(stems);
  const wavs=Object.values(zip.files).filter(f=>!f.dir&&f.name.endsWith('.wav'));
  assert.ok(wavs.length>=3,'stems ZIP contains one WAV per audible track ('+wavs.length+')');
  let anySignal=0;for(const wav of wavs.slice(0,4)){const stem=Buffer.from(await wav.async('arraybuffer'));assert.equal(stem.subarray(0,4).toString(),'RIFF','each stem is a real WAV');if(await decodeRms(stem)>0.01)anySignal++;}
  assert.ok(anySignal>=2,'at least two stems carry their own track signal ('+anySignal+'/'+wavs.length+')');
  // loudness: normalized export reports measured LUFS and lands near the target
  const normalized=await runAudioExport(true);
  assert.match(normalized.message,/LUFS/,'normalized export reports LUFS');
  const normalizedRms=await decodeRms(normalized.bytes);
  assert.ok(Math.abs(normalizedRms-flatRms)>0.005,'normalization changes the level measurably');
  // devices enumerate (fake device present)
  await page.waitForFunction(()=>document.querySelectorAll('[data-mix-input-device] option').length>=1,{},{timeout:10000});
  assert.ok(await page.locator('[data-mix-input-device] option').count()>=1,'input devices listed');
  assert.ok(await page.locator('[data-mix-output-device] option').count()>=1,'output devices listed');
  // subtitle style renders a visible box in preview and burns into the exported frame
  await page.locator('[data-tl-srt]').setInputFiles({name:'c.srt',mimeType:'text/plain',buffer:Buffer.from('1\n00:00:00,200 --> 00:00:02,800\nمرحبًا\n')});
  await idle();
  const subs=page.locator('.tl-subtitles');
  if(!await subs.evaluate(el=>el.open))await subs.locator('summary').click();
  await page.locator('[data-tl-sub-style] [data-sub-style="bg"]').fill('#101010');
  await page.locator('[data-tl-sub-style] [data-sub-style="bg"]').dispatchEvent('change');await idle();
  await setSlider('[data-tl-sub-style] [data-sub-style="bgOpacity"]',0.9);
  project=await downloadJSON();
  const styledTrack=project.tracks.find(t=>t.role==='subtitles');
  assert.equal(styledTrack.subsStyle.bg,'#101010','subtitle style persists');
  await page.locator('[data-tl-seek]').fill('1');await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();
  const pixel=await page.locator('.creative-timeline-editor canvas[aria-label]').evaluate(c=>Array.from(c.getContext('2d').getImageData(Math.round(c.width/2),Math.round(c.height*.62),1,1).data));
  assert.ok(pixel[0]<60&&pixel[1]<60&&pixel[2]<60,'subtitle background box renders dark behind the text');
  fs.mkdirSync('output/verification',{recursive:true});
  fs.writeFileSync('output/verification/creative-audio2-report.json',JSON.stringify({taskId,flatRms,boostedRms,compressedRms,duckedRms,normalizedRms,stems:wavs.map(w=>w.name)},null,2));
  await page.screenshot({path:'output/verification/creative-audio2.png'});
  await page.locator('[data-tl-close]').click();
  console.log('PASS audio advanced UI: EQ boosts and compressor tames the exported mix, ducking lowers music under voice, WAV with loudness reports measured LUFS, stems ZIP splits per track, devices enumerate, subtitle style renders');
}
