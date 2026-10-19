import assert from 'node:assert/strict';
import fs from 'node:fs';
function tone(seconds){const count=Math.round(44100*seconds),buffer=Buffer.alloc(44+count*2);buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(44100,24);buffer.writeUInt32LE(88200,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(count*2,40);for(let i=0;i<count;i++)buffer.writeInt16LE(Math.round(Math.sin(i*440*2*Math.PI/44100)*4000),44+i*2);return buffer;}

/** Asset cycle 2: import preview dialog (range/folder/tags + ffmpeg metadata), library search and filters, inline organization editing, proxy generation feeding the reduced-resolution preview, full-resolution export, hostile inputs, save/reopen persistence. */
export async function checkAssetLibraryUI(page,fixtures,{taskId,base}){
  const editor=page.locator('.creative-timeline-editor');
  if(!await editor.count()||!await editor.evaluate(el=>el.open)){await page.locator('[data-timeline-open]').click();await page.locator('.creative-timeline-editor canvas[aria-label]').waitFor();}
  const idle=()=>page.waitForFunction(()=>!document.querySelector('.creative-timeline-editor fieldset')?.disabled);
  const services=page.locator('.tl-services:not(.tl-export-jobs)');
  if(!await services.evaluate(el=>el.open))await services.locator('> summary').click();
  const assetsBefore=await page.locator('[data-tl-asset]').count();
  const clipsBefore=await page.locator('[data-clip]').count();
  const downloadJSON=async()=>{const pending=page.waitForEvent('download');await page.locator('[data-tl-download]').click();const file=await pending;await idle();return JSON.parse(fs.readFileSync(await file.path()));};
  // import dialog: source range, new folder, tags and real ffmpeg metadata per row
  await page.locator('[data-tl-files]').setInputFiles([{name:'intro.wav',mimeType:'audio/wav',buffer:tone(2)},{name:'cover.png',mimeType:'image/png',buffer:Buffer.from(fixtures.image.split(',')[1],'base64')}]);
  const dialog=page.locator('.creative-import-dialog');await dialog.waitFor();
  await page.waitForFunction(()=>{const button=document.querySelector('.creative-import-dialog [data-import-apply]');return button&&!button.disabled;},{},{timeout:120000});
  const audioRow=dialog.locator('.tl-import-row').filter({hasText:'intro.wav'});
  await audioRow.locator('[data-import-in]').fill('0.5');
  await audioRow.locator('[data-import-out]').fill('1.4');
  await audioRow.locator('[data-import-folder]').selectOption('__new__');
  await audioRow.locator('[data-import-folder-new]').fill('مقاطع صوتية');
  await audioRow.locator('[data-import-tags]').fill('تعليق، لغة عربية');
  await dialog.locator('.tl-import-row').filter({hasText:'cover.png'}).locator('[data-import-tags]').fill('غلاف');
  assert.match(await audioRow.locator('[data-import-body]').innerText(),/wav|pcm|kHz/i,'ffmpeg probe metadata is shown before adding');
  await page.locator('.creative-import-dialog [data-import-apply]').click();
  await page.waitForFunction(()=>!document.querySelector('.creative-import-dialog'));
  await idle();
  assert.equal(await page.locator('[data-tl-asset]').count(),assetsBefore+2);
  assert.equal(await page.locator('[data-clip]').count(),clipsBefore+2);
  const withSelection=await downloadJSON();
  const introAsset=withSelection.assets.find(a=>a.name==='intro.wav');
  const introClip=withSelection.clips.find(c=>c.assetId===introAsset.id);
  assert.ok(Math.abs(introClip.in-.5)<1e-6,'partial selection sets the clip source in-point');
  assert.ok(Math.abs(introClip.duration-.9)<.05,'partial selection sets the clip duration');
  assert.equal(introAsset.folder,'مقاطع صوتية');
  assert.deepEqual(introAsset.tags,['تعليق','لغة عربية']);
  assert.ok(introAsset.meta?.duration>1.9&&introAsset.meta?.sampleRate>=44100,'probe metadata is stored on the asset');
  assert.match(await page.locator('[data-tl-asset]').filter({hasText:'intro.wav'}).innerText(),/kHz/,'library card shows probe metadata');
  // library search, kind and folder filters
  await page.locator('[data-asset-search]').fill('غلاف');
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-tl-library] .tl-asset')].filter(card=>!card.hidden).length===1);
  assert.match(await page.locator('[data-tl-library] .tl-asset:not([hidden])').innerText(),/cover\.png/,'search narrows by tag');
  await page.locator('[data-asset-search]').fill('');
  await page.locator('[data-asset-kind]').selectOption('audio');
  await page.waitForFunction(count=>[...document.querySelectorAll('[data-tl-library] .tl-asset')].filter(card=>!card.hidden).length===count,2);
  await page.locator('[data-asset-folder]').selectOption('مقاطع صوتية');
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-tl-library] .tl-asset')].filter(card=>!card.hidden).length===1);
  assert.match(await page.locator('[data-tl-library] .tl-asset:not([hidden])').innerText(),/intro\.wav/,'folder filter narrows to the folder member');
  await page.locator('[data-asset-kind]').selectOption('');await page.locator('[data-asset-folder]').selectOption('');
  await page.waitForFunction(count=>[...document.querySelectorAll('[data-tl-library] .tl-asset')].filter(card=>!card.hidden).length===count,assetsBefore+2);
  // inline organization editing on an existing asset
  const coverCard=page.locator('.tl-asset').filter({hasText:'cover.png'});
  await coverCard.locator('[data-asset-edit]').click();
  await coverCard.locator('[data-edit-folder]').selectOption('__new__');
  await coverCard.locator('[data-edit-folder-new]').fill('تصاميم');
  await coverCard.locator('[data-edit-tags]').fill('غلاف، تجربة');
  await coverCard.locator('[data-asset-edit-save]').click();await idle();
  const editStatus=await page.locator('[data-tl-status]').innerText();
  const edited=await downloadJSON();
  const editedCover=edited.assets.find(a=>a.name==='cover.png');
  assert.equal(editedCover.folder,'تصاميم','inline folder edit persists · edit status='+editStatus);assert.deepEqual(editedCover.tags,['غلاف','تجربة']);
  assert.match(await page.locator('.tl-asset').filter({hasText:'cover.png'}).innerText(),/تصاميم/,'folder chip renders on the card');
  // invalid tags are rejected inline without breaking the project
  await coverCard.locator('[data-asset-edit]').click();
  await coverCard.locator('[data-edit-tags]').fill('x'.repeat(41));
  await coverCard.locator('[data-asset-edit-save]').click();
  await page.waitForFunction(()=>document.querySelector('[data-tl-status]').textContent.includes('40'));
  assert.equal((await downloadJSON()).assets.find(a=>a.name==='cover.png').tags.length,2,'rejected edit leaves the project unchanged');
  await coverCard.locator('[data-asset-edit-cancel]').click();
  // proxy generation for the video asset, then reduced preview quality uses it
  const videoCard=page.locator('.tl-asset').filter({hasText:'clip.webm'});
  assert.equal(await videoCard.locator('[data-asset-proxy]').count(),1,'video asset offers proxy generation');
  assert.equal(await page.locator('.tl-asset').filter({hasText:'intro.wav'}).locator('[data-asset-proxy]').count(),0,'audio has no proxy button');
  await videoCard.locator('[data-asset-proxy]').click();
  await page.waitForFunction(()=>document.querySelector('[data-tl-status]').textContent.includes('proxy'),{},{timeout:180000});
  await idle();
  const withProxy=await downloadJSON();
  const videoAsset=withProxy.assets.find(a=>a.name==='clip.webm');
  assert.ok(videoAsset.proxy?.path,'proxy stored on the asset');
  assert.equal(videoAsset.proxy.width,Math.min(640,videoAsset.meta.width),'proxy width caps the source resolution');
  assert.equal(videoAsset.proxy.width%2,0,'proxy width is even for encoding');
  const proxyResponse=await fetch(base+'/api/media?taskId='+taskId+'&path='+encodeURIComponent(videoAsset.proxy.path));
  assert.equal(proxyResponse.status,200);assert.match(proxyResponse.headers.get('content-type')||'',/video\/mp4/);
  assert.ok((await proxyResponse.arrayBuffer()).byteLength>1000);
  const proxyFile=videoAsset.proxy.path.split('/').pop();
  let proxyHits=0;const requestListener=request=>{if(request.url().includes(proxyFile))proxyHits++;};page.on('request',requestListener);
  await page.locator('[data-tl-preview-quality]').selectOption('0.5');await idle();
  assert.equal(await page.locator('.creative-timeline-editor canvas[aria-label]').evaluate(c=>c.width),Math.round(withProxy.width*.5),'preview canvas runs at half resolution');
  for(let i=0;i<100&&proxyHits===0;i++)await page.waitForTimeout(100);
  assert.ok(proxyHits>0,'reduced preview loads the proxy derivative');
  await page.locator('[data-tl-seek]').fill('1');await page.locator('[data-tl-seek]').dispatchEvent('change');await idle();
  const pixel=await page.locator('.creative-timeline-editor canvas[aria-label]').evaluate(c=>Array.from(c.getContext('2d').getImageData(Math.round(c.width*.4),Math.round(c.height*.5),1,1).data));
  assert.ok(pixel[0]>50,'proxy preview still composites the video frame');
  // export stays at full project resolution while the preview is reduced
  const jobCount=await page.locator('[data-job]').count();
  await page.locator('[data-tl-format]').selectOption('mp4');await page.locator('[data-tl-export]').click();await idle();
  await page.waitForFunction(count=>document.querySelectorAll('[data-job]').length>count,jobCount);
  await page.waitForFunction(()=>{const rows=[...document.querySelectorAll('[data-job]')];const failed=rows.find(r=>r.dataset.state==='failed');if(failed)throw Error(failed.textContent);return rows.length&&rows.every(r=>['done','canceled'].includes(r.dataset.state));},{},{timeout:180000});
  const pendingExport=page.waitForEvent('download');await page.locator('[data-job-download]').last().click();
  const exportBytes=fs.readFileSync(await (await pendingExport).path());
  const decoded=await page.evaluate(async encoded=>{const blob=await(await fetch('data:video/mp4;base64,'+encoded)).blob(),url=URL.createObjectURL(blob),video=document.createElement('video');video.src=url;await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=reject;});const size={width:video.videoWidth,height:video.videoHeight};URL.revokeObjectURL(url);return size;},exportBytes.toString('base64'));
  assert.equal(decoded.width,withProxy.width,'background export keeps full resolution under reduced preview');
  page.off('request',requestListener);
  await page.locator('[data-tl-preview-quality]').selectOption('1');await idle();
  assert.equal(await page.locator('.creative-timeline-editor canvas[aria-label]').evaluate(c=>c.width),withProxy.width,'full quality restores the canvas');
  // hostile inputs: bogus probe path, proxy for a non-video file, invalid import range and invalid tags
  assert.equal((await fetch(base+'/api/timeline/probe?taskId='+taskId,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:'assets/timeline/nope.mp4'})})).status,400);
  assert.match((await(await fetch(base+'/api/timeline/proxy?taskId='+taskId,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:withProxy.assets.find(a=>a.name==='cover.png').path})})).json()).error,/فيديو/,'proxy refuses non-video files');
  await page.locator('[data-tl-files]').setInputFiles({name:'bad-range.wav',mimeType:'audio/wav',buffer:tone(1)});
  await page.waitForFunction(()=>{const button=document.querySelector('.creative-import-dialog [data-import-apply]');return button&&!button.disabled;},{},{timeout:120000});
  const badRow=page.locator('.creative-import-dialog .tl-import-row').filter({hasText:'bad-range.wav'});
  await badRow.locator('[data-import-in]').fill('0.8');await badRow.locator('[data-import-out]').fill('0.2');
  await page.locator('.creative-import-dialog [data-import-apply]').click();
  await page.waitForFunction(()=>document.querySelector('.creative-import-dialog [data-import-note]').textContent.includes('مدى'));
  assert.ok(await page.locator('.creative-import-dialog').count(),'invalid range keeps the dialog open');
  await badRow.locator('[data-import-tags]').fill('x'.repeat(41));
  await badRow.locator('[data-import-out]').fill('0.9');
  await page.locator('.creative-import-dialog [data-import-apply]').click();
  await page.waitForFunction(()=>document.querySelector('.creative-import-dialog [data-import-note]').textContent.includes('40'));
  await page.locator('.creative-import-dialog [data-import-cancel]').click();
  await page.waitForFunction(()=>!document.querySelector('.creative-import-dialog'));
  await idle();assert.equal(await page.locator('[data-clip]').count(),clipsBefore+2,'canceled import adds nothing');
  // persistence: save, reopen from the saved list, organization and proxy survive server validation and reload
  const saved=page.waitForResponse(r=>r.url().includes('/api/timeline/project?')&&r.status()===201);
  await page.locator('[data-tl-save]').click();
  const savedPath=(await(await saved).json()).path;await idle();
  await page.locator('[data-tl-list]').click();await idle();
  await page.locator('[data-tl-saved]').selectOption(savedPath);await idle();
  assert.match(await page.locator('.tl-asset').filter({hasText:'intro.wav'}).innerText(),/مقاطع صوتية/,'folder survives reopen');
  assert.match(await page.locator('.tl-asset').filter({hasText:'clip.webm'}).locator('[data-asset-proxy]').innerText(),/إعادة/,'proxy reference survives reopen');
  const reopened=await downloadJSON();
  assert.ok(reopened.assets.find(a=>a.name==='clip.webm').proxy?.path,'proxy path round-trips through save and reopen');
  fs.mkdirSync('output/verification',{recursive:true});
  fs.writeFileSync('output/verification/creative-asset-library-report.json',JSON.stringify({taskId,proxyFile,previewWidth:Math.round(withProxy.width*.5),exportWidth:decoded.width,tags:introAsset.tags,folder:introAsset.folder},null,2));
  await page.screenshot({path:'output/verification/creative-asset-library.png'});
  await page.locator('[data-tl-close]').click();
  console.log('PASS creative asset library: import preview with range/folder/tags, ffmpeg metadata, search+kind+folder filters, inline organization editing, proxy generation used by half-resolution preview, full-resolution export, hostile inputs, save/reopen persistence');
}
