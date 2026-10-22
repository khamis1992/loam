import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {importStudio} from '../studio/import.js';
import {readStudio,saveStudio} from '../studio/store.js';
import {exportStudio} from '../studio/export.js';
import {interactiveWordCopy} from '../studio/word-preview-links.js';
import {renderWordPreview} from '../studio/word-preview.js';
const out='output/word-inline-preview';await fs.mkdir(out,{recursive:true});const work=await fs.mkdtemp(out+'/ui-');
await importStudio(work,await fs.readFile('output/word-native-preview/complex-source.docx'),'complex.docx',0);
let conflict=false;
const server=createServer(async(req,res)=>{try{const url=new URL(req.url!,'http://localhost');
 if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
 if(url.pathname==='/api/studio'){if(req.method==='POST'){let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);if(conflict){conflict=false;const latest=readStudio(work)!;latest.title='Concurrent edit';saveStudio(work,latest,latest.revision);}res.setHeader('content-type','application/json');if(body.validateExport)await exportStudio(body.artifact,work);res.end(JSON.stringify({artifact:saveStudio(work,body.artifact,body.expectedRevision)}));return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({artifact:readStudio(work)}));return;}
 if(url.pathname==='/api/studio/preview'){const artifact=readStudio(work)!;if(artifact.kind!=='document')throw Error();const output=await exportStudio(artifact,work);const pdf=await renderWordPreview(await interactiveWordCopy(output.buffer,artifact));res.setHeader('x-loam-revision',artifact.revision);res.setHeader('content-type','application/pdf');res.end(pdf);return;}
 if(url.pathname==='/'){res.setHeader('content-type','text/html');res.end('<html dir="rtl"><link rel="stylesheet" href="/studio.css"><style>body{margin:20px;background:#14291f}#host{max-width:1100px;margin:auto}</style><div id="host"></div><script type="module">import{createStudio}from"/studio.js";createStudio({confirm:async()=>true,ensureDraft:async()=>({id:"test"})}).mount(document.getElementById("host"),{mode:"write",taskId:"test",key:"test"});</script></html>');return;}
 res.setHeader('content-type',url.pathname.endsWith('.html')?'text/html':url.pathname.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile('ui'+url.pathname));
 }catch(error:any){res.statusCode=error.status||500;res.end(JSON.stringify({error:error.message}));}});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+(server.address() as any).port);await page.locator('[data-block-text="0"]').filter({visible:true}).waitFor();await page.locator('[data-status]').filter({hasText:'الإصدار 1'}).waitFor();
 await page.locator('[data-action=read-document]').click();const frame=()=>page.frameLocator('iframe.office-file-preview');
 const ready=async()=>{await frame().locator('.word-page').first().waitFor({timeout:45000});await frame().locator('#status').waitFor({state:'hidden',timeout:45000});const mode=frame().locator('[data-caret-mode]');if(await mode.getAttribute('aria-pressed')==='true')await mode.click();};await ready();assert.equal(await frame().locator('.word-page').count(),5);
 let revision=1;const commit=async()=>{await frame().locator('[data-commit]').click();revision++;await page.locator('[data-status]').filter({hasText:'الإصدار '+revision}).waitFor({timeout:45000});await ready();};
 const change=async(target:string,value:string)=>{await frame().locator(`[data-target="${target}"]`).first().click();await frame().locator('[data-inline-text]').fill(value);await commit();};
 await change('0/text','Annual operating report — edited on the page');
 await change('2/stat/0/value','99%');
 await change('4/cell/23/2','Verified inline');
 await frame().locator('[data-target="8/image"]').click();await frame().locator('[data-replace-image]').setInputFiles('output/word-original-edit/replacement.png');await commit();
 await frame().locator('[data-target="6/text"]').click();await frame().locator('[data-insert-before]').click();await frame().locator('[data-inline-text]').fill('Inserted directly before the landscape dashboard.');await commit();
 const artifact=readStudio(work)!;if(artifact.kind!=='document')throw Error();assert.match(artifact.content.blocks[0]!.text,/edited on the page/);assert.equal((artifact.content.blocks[2] as any).items[0].value,'99%');assert.equal((artifact.content.blocks[4] as any).rows[23][2],'Verified inline');assert.equal(artifact.content.blocks[6]!.text,'Inserted directly before the landscape dashboard.');assert.notEqual((artifact.content.blocks[9] as any).src,JSON.parse(await fs.readFile(out+'/artifact.json','utf8')).content.blocks[8].src);
 await fs.writeFile(out+'/edited-from-preview.docx',(await exportStudio(artifact,work)).buffer);await fs.writeFile(out+'/edited-from-preview.pdf',await renderWordPreview((await exportStudio(artifact,work)).buffer));
 // A server conflict must keep the typed draft visible and leave the newer artifact intact.
 conflict=true;await frame().locator('[data-target="0/text"]').click();await frame().locator('[data-inline-text]').fill('Unsaved conflicting draft');await frame().locator('[data-commit]').click();await frame().locator('[data-editor-status]').filter({hasText:'تحديث جديد'}).waitFor();assert.equal(await frame().locator('[data-inline-text]').inputValue(),'Unsaved conflicting draft');assert.notEqual(readStudio(work)!.content,undefined);assert.match((readStudio(work) as any).content.blocks[0].text,/edited on the page/);await frame().locator('[data-cancel]').last().click();
 await page.screenshot({path:out+'/editor-tested.png',fullPage:false});assert.deepEqual(errors,[]);console.log('PASS inline text/card/table/image editing, interior insertion, regenerated Word pages, source identities, conflict draft preservation.');
}finally{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
