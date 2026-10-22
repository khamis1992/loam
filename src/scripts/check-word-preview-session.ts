import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {Document,Packer,Paragraph,TextRun} from 'docx';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {renderWordPreview} from '../studio/word-preview.js';
import {wordRenderSession} from '../studio/word-render-session.js';
import {StudioError} from '../studio/store.js';
const out='output/word-preview-session';await fs.mkdir(out,{recursive:true});
const document=(marker:string)=>Packer.toBuffer(new Document({sections:[{children:[
 new Paragraph({children:[new TextRun({text:`Session preview ${marker}`,font:'Arial',size:24})]}),
 new Paragraph({children:[new TextRun({text:'فقرتان عربية للتأكد من سلامة العرض داخل الجلسة الدائمة.',font:'Arial',size:24,rightToLeft:true})]}),
]}]}));
const textOfPdf=async(pdf:Buffer)=>{const parsed=await getDocument({data:new Uint8Array(pdf),useSystemFonts:true}).promise;const page=await parsed.getPage(1);const content=await page.getTextContent();return content.items.map((item:any)=>item.str||'').join(' ');};
const run=(command:string,args:string[])=>new Promise<{stdout:string,stderr:string}>((resolve,reject)=>execFile(command,args,{windowsHide:true,timeout:20_000},(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));
const wordPidExists=async(pid:number)=>{try{const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`@(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Count`]);return stdout.trim()==='1';}catch{return false;}};

// Cold render starts the persistent session; warm renders reuse the same dedicated Word process.
// Each buffer is built once: identical content must share one cache entry.
const alphaBuffer=await document('alpha');
const coldStart=Date.now();
const pdfA=await renderWordPreview(alphaBuffer);
const coldMs=Date.now()-coldStart;
assert.equal(pdfA.subarray(0,5).toString(),'%PDF-');
assert.match(await textOfPdf(pdfA),/Session preview alpha/);
const first=wordRenderSession.status();
assert.ok(first.running&&first.owner,'session must be running with a recorded owner');
assert.match(first.owner!.started,/^\d+$/,'ownership is recorded with a creation time');

const warmStart=Date.now();
const pdfB=await renderWordPreview(await document('beta'));
const warmMs=Date.now()-warmStart;
assert.match(await textOfPdf(pdfB),/Session preview beta/);
const second=wordRenderSession.status();
assert.equal(second.owner!.id,first.owner!.id,'warm render reuses the same Word session');
assert.equal(second.renders,2);
assert.ok(warmMs<coldMs,`warm render (${warmMs}ms) must be faster than the cold render (${coldMs}ms)`);

// Repeating a revision is served from the per-content cache without touching Word.
const cacheStart=Date.now();
const pdfA2=await renderWordPreview(alphaBuffer);
const cacheMs=Date.now()-cacheStart;
assert.ok(pdfA2.equals(pdfA));
assert.ok(cacheMs<1000,`cached render took ${cacheMs}ms`);
assert.equal(wordRenderSession.status().renders,2,'cache hits must not consume the session');

// Killing the dedicated Word process is recovered automatically on the next render.
await run('taskkill',['/PID',String(first.owner!.id),'/F']);
await new Promise(r=>setTimeout(r,1500));
const recoverStart=Date.now();
const pdfC=await renderWordPreview(await document('gamma'));
const recoverMs=Date.now()-recoverStart;
assert.match(await textOfPdf(pdfC),/Session preview gamma/);
const third=wordRenderSession.status();
assert.ok(third.recoveries>=1,'crash recovery must be counted');
assert.notEqual(third.owner!.id,first.owner!.id,'a fresh dedicated Word process replaces the crashed one');

// A document Word cannot open is a user-facing error and leaves the session usable.
const broken=await document('delta');
const zip=new (await import('jszip')).default();await zip.loadAsync(broken);zip.file('[Content_Types].xml','not xml at all');
const brokenBuffer=await zip.generateAsync({type:'nodebuffer'});
await assert.rejects(()=>renderWordPreview(brokenBuffer),(error:any)=>error instanceof StudioError&&error.status===503);
const pdfE=await renderWordPreview(await document('epsilon'));
assert.match(await textOfPdf(pdfE),/Session preview epsilon/);
assert.equal(wordRenderSession.status().owner!.id,third.owner!.id,'document errors must not restart the session');

// Graceful shutdown ends the helper and its dedicated Word process.
const finalOwner=wordRenderSession.status().owner!;
await wordRenderSession.shutdown();
assert.equal(wordRenderSession.status().running,false);
await new Promise(r=>setTimeout(r,2500));
assert.equal(await wordPidExists(finalOwner.id),false,'owned Word process is stopped after shutdown');

await fs.writeFile(out+'/session-preview.pdf',pdfB);
await fs.writeFile(out+'/session-timing.json',JSON.stringify({coldMs,warmMs,cacheMs,recoverMs,renders:wordRenderSession.status().renders,recoveries:wordRenderSession.status().recoveries,owners:{first:first.owner!.id,third:third.owner!.id}},null,2));
console.log(`PASS persistent Word session: cold ${coldMs}ms, warm reuse ${warmMs}ms, cache hit ${cacheMs}ms, crash recovery ${recoverMs}ms, document-error isolation, clean shutdown`);
