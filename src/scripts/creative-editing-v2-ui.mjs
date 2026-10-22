import assert from 'node:assert/strict';
import fs from 'node:fs';
import {newTimeline,newClip,uid,validateTimeline} from '../../ui/creative-timeline-model.js';
import {rollTrim,slipClip,slideClip,rippleTrimEnd,rippleTrimStart} from '../../ui/creative-editing.js';
import {captionClips,toSubtitles} from '../../ui/creative-timeline-services.js';

/** Model-level checks for ripple/roll/slip/slide semantics, subtitle serialization, and source metadata validation. */
export function checkEditingToolsModel(){
  const project=newTimeline();project.taskId='task_model_edit';
  const asset={id:'asset_v',name:'cam.mp4',kind:'video',duration:10,path:'assets/timeline/00000000-0000-0000-0000-00000000000a.mp4',bytes:1000};
  project.assets.push(asset);
  const track=project.tracks[0];
  const a={...newClip(track,asset,0),duration:2},b={...newClip(track,asset,2),duration:2},c={...newClip(track,asset,4),duration:2};
  project.clips.push(a,b,c);
  validateTimeline(project);
  // roll left: the cut between a and b moves to 1.5; b starts earlier and shows later source content
  rollTrim(project,a.id,1.5);
  assert.ok(Math.abs(a.duration-1.5)<1e-9&&Math.abs(b.start-1.5)<1e-9&&Math.abs(b.in-.5)<1e-9);
  validateTimeline(project);
  // roll right back needs b.in headroom: slip b's source first, then roll to 1.8
  slipClip(project,b.id,.5);
  rollTrim(project,a.id,1.8);
  assert.ok(Math.abs(a.duration-1.8)<1e-9&&Math.abs(b.start-1.8)<1e-9&&Math.abs(b.in-.7)<1e-9);
  // slip shifts only the source window
  slipClip(project,b.id,-.2);
  assert.equal(b.start,1.8);assert.ok(Math.abs(b.duration-2)<1e-9);assert.ok(Math.abs(b.in-.5)<1e-9);
  assert.throws(()=>slipClip(project,b.id,-10),/حدود المصدر/);
  // slide keeps content and neighbors, clamped to the free gap (a ends at 1.8, c starts at 4)
  slideClip(project,b.id,.2);
  assert.ok(Math.abs(b.start-2.0)<1e-4);
  assert.throws(()=>slideClip(project,b.id,5),/لا مساحة/);
  assert.throws(()=>slideClip(project,b.id,-1),/لا مساحة/);
  // ripple end at 1.0: a shrinks and later clips close the gap
  rippleTrimEnd(project,a.id,1.0);
  assert.ok(Math.abs(a.duration-1)<1e-9&&Math.abs(b.start-1.2)<1e-3&&Math.abs(c.start-3.2)<1e-3);
  // ripple start at 0.5: head trimmed, clip keeps start, later clips close again
  rippleTrimStart(project,a.id,.5);
  assert.ok(Math.abs(a.in-.5)<1e-9&&Math.abs(a.duration-.5)<1e-9&&Math.abs(a.start-0)<1e-9);
  assert.ok(Math.abs(b.start-.7)<1e-3&&Math.abs(c.start-2.7)<1e-3);
  validateTimeline(project);
  assert.throws(()=>rollTrim(project,a.id,9),/لا يوجد مقطع تالٍ|إطار/);
  // subtitle round-trip: parse SRT, serialize SRT+VTT, re-parse both
  const subtitleTrack={id:uid(),name:'الترجمة',kind:'visual',role:'subtitles',hidden:false,muted:false};
  const cues=captionClips('1\n00:00:01,000 --> 00:00:02,500\nمرحبًا بالعالم\n\n2\n00:00:03,000 --> 00:00:04,200\nLoam Studio\n',subtitleTrack);
  assert.equal(cues.length,2);
  const srt=toSubtitles(cues,'srt');
  assert.match(srt,/00:00:01,000 --> 00:00:02,500/);assert.doesNotMatch(srt,/^WEBVTT/);
  const vtt=toSubtitles(cues,'vtt');
  assert.match(vtt,/^WEBVTT/);assert.match(vtt,/00:00:01\.000 --> 00:00:02\.500/);
  const reparsed=captionClips(vtt,subtitleTrack);
  assert.equal(reparsed.length,2);assert.equal(reparsed[0].text,'مرحبًا بالعالم');
  assert.ok(Math.abs(reparsed[1].start-3)<1e-9&&Math.abs(reparsed[1].duration-1.2)<1e-9);
  // VTT short timestamps (MM:SS.mmm) and cue settings are accepted
  const short=captionClips('WEBVTT\n\n00:01.000 --> 00:02.000 line:90%\nقصير\n',subtitleTrack);
  assert.equal(short.length,1);assert.ok(Math.abs(short[0].start-1)<1e-9);
  assert.throws(()=>toSubtitles([],'srt'),/لا مقاطع/);
  // source/license validation
  const good={...asset,id:'asset_s',source:{url:'https://example.com/photo',author:'المصور',license:'CC-BY-4.0',notes:'مرخص'}};
  project.assets.push(good);validateTimeline(project);
  const badUrl={...good,id:'asset_b',source:{url:'ftp://nope'}};
  project.assets.push(badUrl);assert.throws(()=>validateTimeline(project),/رابط المصدر/);
  project.assets=project.assets.filter(x=>x.id!=='asset_b');
  const badKey={...good,id:'asset_k',source:{surprise:1}};
  project.assets.push(badKey);assert.throws(()=>validateTimeline(project),/مصدر/);
  project.assets=project.assets.filter(x=>x.id!=='asset_k');
  console.log('PASS editing tools model: roll/slip/slide/ripple semantics and guards, SRT/VTT round-trip, source metadata validation');
}

/** Browser flow: precise editing tools, multi-select group editing, and the subtitle editor with SRT/VTT export. */
export async function checkEditingToolsUI(page,fixtures){
  const idle=()=>page.waitForFunction(()=>!document.querySelector('.creative-timeline-editor fieldset')?.disabled&&!document.querySelector('.creative-import-dialog [data-import-apply][disabled]'));
  const editor=page.locator('.creative-timeline-editor');
  if(!await editor.count()||!await editor.evaluate(el=>el.open)){await page.locator('[data-timeline-open]').click();await page.locator('.creative-timeline-editor canvas[aria-label]').waitFor();}
  const downloadJSON=async()=>{const pending=page.waitForEvent('download');await page.locator('[data-tl-download]').click();const file=await pending;await idle();return JSON.parse(fs.readFileSync(await file.path()));};
  const confirmImport=async()=>{await page.waitForFunction(()=>{const button=document.querySelector('.creative-import-dialog [data-import-apply]');return button&&!button.disabled;},{},{timeout:120000});await page.locator('.creative-import-dialog [data-import-apply]').click();await page.waitForFunction(()=>!document.querySelector('.creative-import-dialog'));await idle();};
  // clean, controlled project: three copies of the same video laid out sequentially
  const baseline=await downloadJSON();
  baseline.assets=[];baseline.clips=[];baseline.tracks=baseline.tracks.filter(t=>t.role!=='subtitles');
  await page.locator('[data-tl-project]').setInputFiles({name:'empty.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(baseline))});
  await idle();
  const videoBuffer=Buffer.from(fixtures.video.split(',')[1],'base64');
  await page.locator('[data-tl-seek]').fill('0');await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();
  await page.locator('[data-tl-files]').setInputFiles([{name:'a.webm',mimeType:'video/webm',buffer:videoBuffer},{name:'b.webm',mimeType:'video/webm',buffer:videoBuffer},{name:'c.webm',mimeType:'video/webm',buffer:videoBuffer}]);
  await confirmImport();
  let project=await downloadJSON();
  assert.equal(project.assets.length,3);assert.equal(project.clips.length,3);
  project.clips.sort((x,y)=>x.start-y.start);
  const [a,b,c]=project.clips;
  const seek=async time=>{await page.locator('[data-tl-seek]').fill(String(time));await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();};
  const clickClip=async clip=>{await page.locator('[data-clip]').filter({hasText:clip.name}).first().evaluate(el=>el.scrollIntoView({block:'center'}));await page.locator('[data-clip]').filter({hasText:clip.name}).first().click();await idle();};
  const status=async()=>await page.locator('[data-tl-status]').innerText();
  // roll left at the a/b cut (imports are sequential, so b's original start equals the source duration);
  // b is shortened first so its source window has headroom for the roll
  const sourceDuration=b.start;
  await clickClip(b);
  await page.locator('[data-clip-field=duration]').fill('1.2');await page.locator('[data-clip-field=duration]').press('Tab');await idle();
  await clickClip(a);await seek(1.5);
  await page.locator('[data-tl-roll]').click();await idle();
  project=await downloadJSON();
  let A=project.clips.find(x=>x.id===a.id),B=project.clips.find(x=>x.id===b.id);
  assert.ok(Math.abs(A.duration-1.5)<1e-6&&Math.abs(B.start-1.5)<1e-6&&Math.abs(B.in-(sourceDuration-1.5))<1e-6,'roll moves the cut and shifts the next source window · got A.dur='+A.duration+' B.start='+B.start+' B.in='+B.in+' V='+sourceDuration);
  // slip shifts only the source in-point; past the source start it is rejected without change
  await clickClip(b);
  await page.locator('[data-tl-slip="-0.2"]').click();await idle();
  project=await downloadJSON();B=project.clips.find(x=>x.id===b.id);
  assert.ok(Math.abs(B.in-(sourceDuration-1.7))<1e-6&&Math.abs(B.start-1.5)<1e-6,'slip keeps timeline placement');
  for(let i=0;i<4;i++){await page.locator('[data-tl-slip="-0.2"]').click();await idle();}
  project=await downloadJSON();const afterBadSlip=project.clips.find(x=>x.id===b.id);
  let expectedIn=sourceDuration-1.7;for(let i=0;i<4;i++){if(expectedIn>=.2-1e-9)expectedIn-=.2;}
  assert.ok(Math.abs(afterBadSlip.in-expectedIn)<1e-6,'slip stops at the source start instead of breaking the project · got '+afterBadSlip.in+' expected '+expectedIn);
  // slide within the gap between a and c; repeated slides stop at the gap edge with a clear error
  await page.locator('[data-tl-slide="0.2"]').click();await idle();
  project=await downloadJSON();B=project.clips.find(x=>x.id===b.id);
  const duration=B.duration,ceiling=project.clips.find(x=>x.id===c.id).start-duration;
  assert.ok(Math.abs(B.start-1.7)<1e-3,'slide moves within the free gap');
  let slides=0,rejection='';
  for(;slides<12;slides++){
    const beforeSlide=(await downloadJSON()).clips.find(x=>x.id===b.id).start;
    await page.locator('[data-tl-slide="0.2"]').click();await idle();
    rejection=await status();
    const afterSlide=(await downloadJSON()).clips.find(x=>x.id===b.id).start;
    if(Math.abs(afterSlide-beforeSlide)<1e-9)break;
    assert.ok(afterSlide<=ceiling+1e-6,'slide never passes the neighbor');
  }
  assert.ok(slides<12,'slide reaches the gap edge');
  assert.match(rejection,/لا مساحة/,'slide rejection explains the limit · '+rejection);
  // ripple end then ripple start close gaps for later clips on the track
  await clickClip(a);await seek(1.0);
  const beforeRipple=await downloadJSON();
  await page.locator('[data-tl-ripple-trim-end]').click();await idle();
  project=await downloadJSON();A=project.clips.find(x=>x.id===a.id);B=project.clips.find(x=>x.id===b.id);
  const C=project.clips.find(x=>x.id===c.id);
  const bBefore=beforeRipple.clips.find(x=>x.id===b.id).start,cBefore=beforeRipple.clips.find(x=>x.id===c.id).start;
  assert.ok(Math.abs(A.duration-1)<1e-6,'ripple end trims the tail at the playhead');
  assert.ok(Math.abs(B.start-(bBefore-.5))<1e-3&&Math.abs(C.start-(cBefore-.5))<1e-3,'ripple end pulls later clips left');
  await seek(.5);
  await page.locator('[data-tl-ripple-trim-start]').click();await idle();
  project=await downloadJSON();A=project.clips.find(x=>x.id===a.id);
  assert.ok(Math.abs(A.in-.5)<1e-6&&Math.abs(A.duration-.5)<1e-6,'ripple start trims the head at the playhead');
  // multi-select: ctrl+click a and c, drag a — both move together; delete removes both
  await clickClip(a);
  await page.locator('[data-clip]').filter({hasText:c.name}).first().click({modifiers:['Control']});await idle();
  assert.match(await page.locator('[data-tl-delete]').innerText(),/2/,'selection-aware delete label renders');
  const beforeGroup=await downloadJSON();
  const box=await page.locator('[data-clip]').filter({hasText:a.name}).first().evaluate(el=>{el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x,y:r.y};});
  await page.mouse.move(box.x+20,box.y+20);await page.mouse.down();await page.mouse.move(box.x+60,box.y+20,{steps:8});await page.mouse.up();await idle();
  project=await downloadJSON();
  const A2=project.clips.find(x=>x.id===a.id),C2=project.clips.find(x=>x.id===c.id);
  const shiftA=A2.start-beforeGroup.clips.find(x=>x.id===a.id).start,shiftC=C2.start-beforeGroup.clips.find(x=>x.id===c.id).start;
  assert.ok(shiftA>0.02&&Math.abs(shiftA-shiftC)<1e-6,'group drag moves every selected clip by the same delta');
  await page.locator('[data-tl-delete]').click();await idle();
  assert.equal((await downloadJSON()).clips.length,1,'group delete removes the whole selection');
  // subtitle editor: import SRT, edit text and timing, merge, split, warnings, SRT+VTT export, VTT re-import
  await page.locator('[data-tl-srt]').setInputFiles({name:'captions.srt',mimeType:'text/plain',buffer:Buffer.from('1\n00:00:00,500 --> 00:00:02,000\nمرحبًا بالعالم\n\n2\n00:00:02,200 --> 00:00:03,800\nLoam Studio\n')});
  await idle();
  const subs=page.locator('.tl-subtitles');
  if(!await subs.evaluate(el=>el.open))await subs.locator('summary').click();
  await page.locator('[data-tl-sub-rows] [data-sub-row]').first().waitFor();
  assert.equal(await page.locator('[data-tl-sub-rows] [data-sub-row]').count(),2,'SRT import feeds the subtitle editor');
  await page.locator('[data-tl-sub-rows] [data-sub-row]').first().locator('[data-sub-field=text]').fill('نص معدّل');
  await page.locator('[data-tl-sub-rows] [data-sub-row]').first().locator('[data-sub-field=text]').dispatchEvent('change');await idle();
  project=await downloadJSON();
  assert.equal(project.clips.find(x=>x.text==='نص معدّل').text,'نص معدّل','subtitle text edits persist');
  // overlap warning appears when the second cue starts before the first ends
  await page.locator('[data-tl-sub-rows] [data-sub-row]').nth(1).locator('[data-sub-field=start]').fill('1.0');
  await page.locator('[data-tl-sub-rows] [data-sub-row]').nth(1).locator('[data-sub-field=start]').dispatchEvent('change');await idle();
  assert.match(await page.locator('[data-tl-sub-rows]').innerText(),/تداخل/,'overlap warning renders');
  await page.locator('[data-tl-sub-rows] [data-sub-row]').nth(1).locator('[data-sub-field=start]').fill('2.2');
  await page.locator('[data-tl-sub-rows] [data-sub-row]').nth(1).locator('[data-sub-field=start]').dispatchEvent('change');await idle();
  // merge then split
  await page.locator('[data-sub-merge]').first().click();await idle();
  assert.equal(await page.locator('[data-tl-sub-rows] [data-sub-row]').count(),1,'merge joins two cues');
  await page.locator('[data-sub-split]').first().click();await idle();
  assert.equal(await page.locator('[data-tl-sub-rows] [data-sub-row]').count(),2,'split restores two cues');
  // exports parse back correctly
  const exportFile=async format=>{const pending=page.waitForEvent('download');await page.locator('[data-tl-sub-export="'+format+'"]').click();const file=await pending;await idle();return fs.readFileSync(await file.path()).toString();};
  const exportedSrt=await exportFile('srt');
  assert.match(exportedSrt,/ --> /);assert.ok(exportedSrt.trim().split(/\n\s*\n/).length>=2,'SRT export contains the cues');
  const exportedVtt=await exportFile('vtt');
  assert.match(exportedVtt,/^WEBVTT/,'VTT export has the header');
  await page.locator('[data-tl-srt]').setInputFiles({name:'roundtrip.vtt',mimeType:'text/vtt',buffer:Buffer.from(exportedVtt)});
  await idle();
  assert.equal(await page.locator('[data-tl-sub-rows] [data-sub-row]').count(),4,'VTT import round-trips (editor aggregates both subtitle tracks)');
  project=await downloadJSON();
  assert.equal(project.tracks.filter(t=>t.role==='subtitles').length,2,'each import creates a subtitles track');
  // failure path: broken VTT is rejected without touching the project
  const before=await downloadJSON();
  await page.locator('[data-tl-srt]').setInputFiles({name:'broken.vtt',mimeType:'text/vtt',buffer:Buffer.from('WEBVTT\n\nno timing here\n')});
  await idle();
  const brokenStatus=await status();
  assert.equal((await downloadJSON()).clips.length,before.clips.length,'broken subtitle import changes nothing');
  assert.match(brokenStatus,/SRT\/VTT|ترجمة/,'broken import explains itself · '+brokenStatus);
  fs.mkdirSync('output/verification',{recursive:true});
  await page.screenshot({path:'output/verification/creative-editing-tools.png'});
  await page.locator('[data-tl-close]').click();
  console.log('PASS editing tools UI: roll/slip/slide/ripple with guards, multi-select group drag and delete, subtitle editor (edit/merge/split/warnings) with SRT/VTT export and VTT round-trip');
}
