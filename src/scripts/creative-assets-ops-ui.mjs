import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const ffmpeg=path.resolve('node_modules/ffmpeg-static/ffmpeg.exe');

/** Asset operations cycle: persistent thumbnail cache, disk-space panel with cleanup, orphan detection, source/license metadata, and cancellable proxy jobs with retry. */
export async function checkAssetOperationsUI(page,fixtures,{taskId,base}){
  const idle=()=>page.waitForFunction(()=>!document.querySelector('.creative-timeline-editor fieldset')?.disabled&&!document.querySelector('.creative-import-dialog [data-import-apply][disabled]'));
  const editor=page.locator('.creative-timeline-editor');
  if(!await editor.count()||!await editor.evaluate(el=>el.open)){await page.locator('[data-timeline-open]').click();await page.locator('.creative-timeline-editor canvas[aria-label]').waitFor();}
  const services=page.locator('.tl-services:not(.tl-export-jobs)');
  if(!await services.evaluate(el=>el.open))await services.locator('> summary').click();
  const downloadJSON=async()=>{const pending=page.waitForEvent('download');await page.locator('[data-tl-download]').click();const file=await pending;await idle();return JSON.parse(fs.readFileSync(await file.path()));};
  const confirmImport=async()=>{await page.waitForFunction(()=>{const button=document.querySelector('.creative-import-dialog [data-import-apply]');return button&&!button.disabled;},{},{timeout:120000});await page.locator('.creative-import-dialog [data-import-apply]').click();await page.waitForFunction(()=>!document.querySelector('.creative-import-dialog'));await idle();};
  const media=relative=>fetch(base+'/api/media?taskId='+taskId+'&path='+encodeURIComponent(relative));
  const status=async()=>await page.locator('[data-tl-status]').innerText();
  // source and license metadata edit inline, persist, and reject invalid URLs
  let project=await downloadJSON();
  const target=project.assets.find(a=>a.name==='a.webm')||project.assets[0];
  const card=page.locator('.tl-asset').filter({hasText:target.name});
  await card.locator('[data-asset-edit]').click();
  await card.locator('[data-edit-source-url]').fill('ftp://not-a-site');
  await card.locator('[data-edit-source-author]').fill('فريق التصوير');
  await card.locator('[data-asset-edit-save]').click();
  await page.waitForFunction(()=>document.querySelector('[data-tl-status]').textContent.includes('http'));
  assert.equal((await downloadJSON()).assets.find(a=>a.id===target.id).source,undefined,'invalid source URL is rejected without changes');
  await card.locator('[data-edit-source-url]').fill('https://example.com/footage');
  await card.locator('[data-edit-source-author]').fill('فريق التصوير');
  await card.locator('[data-edit-source-license]').fill('CC-BY-4.0');
  await card.locator('[data-edit-source-notes]').fill('مشهد مرخص للاستخدام التحريري');
  await card.locator('[data-asset-edit-save]').click();await idle();
  const sourced=(await downloadJSON()).assets.find(a=>a.id===target.id);
  assert.deepEqual(sourced.source,{url:'https://example.com/footage',author:'فريق التصوير',license:'CC-BY-4.0',notes:'مشهد مرخص للاستخدام التحريري'},'source metadata round-trips through the project');
  // persistent thumbnail cache: generation uploads a PNG keyed by the asset file
  const cachePath='assets/timeline/cache/'+target.path.split('/').pop()+'.png';
  let cacheResponse=await media(cachePath);
  for(let i=0;i<40&&cacheResponse.status!==200;i++){await new Promise(r=>setTimeout(r,500));cacheResponse=await media(cachePath);}
  assert.equal(cacheResponse.status,200,'generated thumbnail is persisted server-side');
  assert.match(cacheResponse.headers.get('content-type')||'',/image\/png/);
  // storage panel reports the cache and free disk; cleaning it removes only derived files
  await page.locator('[data-tl-storage]').click();await idle();
  const panel=page.locator('[data-tl-storage-panel]');
  await page.waitForFunction(()=>document.querySelector('[data-tl-storage-panel]').textContent.includes('المساحة الحرة'));
  let panelText=await panel.innerText();
  assert.match(panelText,/صور وموجات المصغرات[^:]*: [1-9]\d* ملف/,'storage panel counts cached thumbnails · '+panelText.slice(0,300));
  const storageJson=await(await fetch(base+'/api/timeline/storage?taskId='+taskId)).json();
  assert.ok(typeof storageJson.freeDisk==='number'&&storageJson.freeDisk>0,'free disk space is reported');
  await panel.locator('[data-tl-cleanup="thumbs"]').click();
  for(let i=0;i<40&&(await media(cachePath)).status!==404;i++)await new Promise(r=>setTimeout(r,500));
  assert.equal((await media(cachePath)).status,404,'thumb cleanup deletes the cache');
  assert.equal((await media(target.path)).status,200,'original media survives thumb cleanup');
  // after a full reload the cache is gone from memory: reopening a saved project regenerates and re-persists it
  await page.reload();await page.locator('.creative-viewport canvas').waitFor();
  await page.locator('[data-timeline-open]').click();await idle();
  await page.locator('[data-tl-list]').click();await idle();
  const savedOption=await page.locator('[data-tl-saved] option').last().getAttribute('value');
  await page.locator('[data-tl-saved]').selectOption(savedOption);await idle();
  const reopened=await downloadJSON();
  const cacheSeed=reopened.assets.find(a=>['video','image'].includes(a.kind))||reopened.assets[0];
  const reopenedCache='assets/timeline/cache/'+cacheSeed.path.split('/').pop()+'.png';
  let regenerated=await media(reopenedCache);
  for(let i=0;i<60&&regenerated.status!==200;i++){await new Promise(r=>setTimeout(r,500));regenerated=await media(reopenedCache);}
  assert.equal(regenerated.status,200,'thumbnails regenerate and persist again after reload');
  // orphan detection and cleanup protect referenced media
  const orphanUpload=await fetch(base+'/api/timeline/asset?taskId='+taskId,{method:'POST',headers:{'content-type':'image/png'},body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==','base64')});
  assert.equal(orphanUpload.status,201);const orphanPath=(await orphanUpload.json()).path;
  if(!await services.evaluate(el=>el.open))await services.locator('> summary').click();
  await page.locator('[data-tl-storage]').click();await idle();
  await page.waitForFunction(()=>/يتيمة: [1-9]/.test(document.querySelector('[data-tl-storage-panel]').textContent));
  await panel.locator('[data-tl-cleanup="orphans"]').click();
  await page.waitForFunction(()=>/يتيمة: 0 ملف/.test(document.querySelector('[data-tl-storage-panel]').textContent),{},{timeout:30000});
  assert.equal((await media(orphanPath)).status,404,'orphan file is deleted');
  assert.equal((await media(cacheSeed.path)).status,200,'assets of the open project are protected from orphan cleanup');
  // proxy job lifecycle: cancel mid-transcode, retry to completion, result attaches to the asset
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'loam-proxy-'));
  const longVideo=path.join(tmp,'long.mp4');
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc=size=320x240:rate=30:duration=60','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p',longVideo],{windowsHide:true});
  await page.locator('[data-tl-files]').setInputFiles({name:'long.mp4',mimeType:'video/mp4',buffer:fs.readFileSync(longVideo)});
  await confirmImport();
  const longCard=page.locator('.tl-asset').filter({hasText:'long.mp4'});
  await longCard.locator('[data-asset-proxy]').click();
  const cancelButton=page.locator('[data-asset-proxy][data-job-action="cancel"]');
  await cancelButton.waitFor({timeout:30000});
  await cancelButton.click();
  await page.waitForFunction(()=>{return [...document.querySelectorAll('[data-asset-proxy]')].some(b=>b.textContent.includes('إعادة المحاولة'));},{},{timeout:30000});
  assert.match(await status(),/أُلغيت/,'cancellation reports clearly');
  assert.equal((await downloadJSON()).assets.find(a=>a.name==='long.mp4').proxy,undefined,'canceled job attaches nothing');
  await page.locator('[data-asset-proxy][data-job-action="retry"]').click();
  let proxyAttached=null;
  for(let i=0;i<240&&!proxyAttached;i++){
    await new Promise(r=>setTimeout(r,1000));
    try{proxyAttached=((await downloadJSON()).assets.find(a=>a.name==='long.mp4')||{}).proxy||null;}catch{/* transient busy */}
  }
  assert.ok(proxyAttached&&proxyAttached.path,'retried job finishes and attaches the proxy');
  assert.ok(proxyAttached.width<=640&&proxyAttached.width%2===0,'proxy width is capped and even');
  assert.equal((await media(proxyAttached.path)).status,200);
  fs.rmSync(tmp,{recursive:true,force:true});
  fs.mkdirSync('output/verification',{recursive:true});
  fs.writeFileSync('output/verification/creative-asset-ops-report.json',JSON.stringify({taskId,cachePath,reopenedCache,orphanPath,proxy:proxyAttached},null,2));
  await page.screenshot({path:'output/verification/creative-asset-ops.png'});
  await page.locator('[data-tl-close]').click();
  console.log('PASS creative asset operations: source/license editing, persistent thumbnail cache with cleanup and post-reload regeneration, disk-space panel, orphan cleanup protection, cancellable proxy job with retry');
}
