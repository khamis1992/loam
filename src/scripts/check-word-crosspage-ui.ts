import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {importStudio} from '../studio/import.js';
import {readStudio,saveStudio} from '../studio/store.js';
import {exportStudio} from '../studio/export.js';
import {interactiveWordCopy} from '../studio/word-preview-links.js';
import {renderWordPreview} from '../studio/word-preview.js';
const out='output/word-move-resize';await fs.mkdir(out,{recursive:true});const work=await fs.mkdtemp(out+'/ui-');
await importStudio(work,await fs.readFile('output/word-native-preview/complex-source.docx'),'complex.docx',0);
const server=createServer(async(req,res)=>{try{const url=new URL(req.url!,'http://localhost');
 if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
 if(url.pathname==='/api/studio'){if(req.method==='POST'){let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);if(body.validateExport)await exportStudio(body.artifact,work);res.setHeader('content-type','application/json');res.end(JSON.stringify({artifact:saveStudio(work,body.artifact,body.expectedRevision)}));return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({artifact:readStudio(work)}));return;}
 if(url.pathname==='/api/studio/preview'){const artifact=readStudio(work)!;if(artifact.kind!=='document')throw Error();const output=await exportStudio(artifact,work);const pdf=await renderWordPreview(await interactiveWordCopy(output.buffer,artifact));res.setHeader('x-loam-revision',artifact.revision);res.setHeader('content-type','application/pdf');res.end(pdf);return;}
 if(url.pathname==='/'){res.setHeader('content-type','text/html');res.end('<html dir="rtl"><link rel="stylesheet" href="/studio.css"><style>body{margin:20px;background:#14291f}#host{max-width:1100px;margin:auto}</style><div id="host"></div><script type="module">import{createStudio}from"/studio.js";createStudio({confirm:async()=>true,ensureDraft:async()=>({id:"test"})}).mount(document.getElementById("host"),{mode:"write",taskId:"test",key:"test"});</script></html>');return;}
 res.setHeader('content-type',url.pathname.endsWith('.html')?'text/html':url.pathname.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile('ui'+url.pathname));
 }catch(error:any){res.statusCode=error.status||500;res.end(JSON.stringify({error:error.message}));}});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1100}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+(server.address() as any).port);await page.locator('[data-block-text="0"]').filter({visible:true}).waitFor();
 await page.locator('[data-action=read-document]').click();const frame=()=>page.frameLocator('iframe.office-file-preview');
 const ready=async()=>{await frame().locator('.word-page').first().waitFor({timeout:90000});await frame().locator('#status').waitFor({state:'hidden',timeout:90000});};await ready();
 let revision=1;const saved=async()=>{revision++;await page.locator('[data-status]').filter({hasText:'الإصدار '+revision}).waitFor({timeout:90000});await ready();};
 const imageHandle=()=>frame().locator('[data-drag-index][aria-label*="الصورة"]');
 const imagePage=async()=>await imageHandle().evaluate((node:any)=>Number((node.closest('.word-page') as any).dataset.page));
 // Show every page at once so the cross-page drag never leaves the iframe.
 await page.setViewportSize({width:1500,height:4700});await page.evaluate("()=>{const frame=document.querySelector('iframe.office-file-preview');if(frame)frame.style.height='4400px';}");
 await page.waitForTimeout(600);
 const start=readStudio(work)!;if(start.kind!=='document')throw Error();
 const startIndex=start.content.blocks.findIndex((b:any)=>b.type==='image');
 // Drag the picture from its page up to page 1: the ghost follows across pages and the drop re-anchors it.
 const handleBox=(await imageHandle().boundingBox())!;
 const page1=await frame().locator('.word-page[data-page="1"]').boundingBox();
 await page.mouse.move(handleBox.x+10,handleBox.y+10);
 await page.mouse.down();
 await page.mouse.move(page1!.x+page1!.width*0.35,page1!.y+page1!.height*0.42,{steps:14});
 await page.mouse.up();
 await saved();
 const afterMove=readStudio(work)!;if(afterMove.kind!=='document')throw Error();
 const movedIndex=afterMove.content.blocks.findIndex(b=>b.type==='image');
 assert.ok(movedIndex<startIndex,`image re-anchored earlier in the flow (${movedIndex} < ${startIndex})`);
 assert.ok((afterMove.content.blocks[movedIndex]!.position?.y??9999)<400,'image position now lives near the top of the new page');
 assert.equal(await imagePage(),1,'the image drag handle now appears on page 1');
 // Resize with the corner handle; the saved width grows and the aspect is kept by the exporter.
 const beforeWidth=afterMove.content.blocks[movedIndex]!.position?.width;
 const corner=frame().locator('[data-resize-index="'+movedIndex+'"]');
 const cornerBox=(await corner.first().boundingBox())!;
 await page.mouse.move(cornerBox.x+8,cornerBox.y+8);
 await page.mouse.down();
 await page.mouse.move(cornerBox.x+8+70,cornerBox.y+8+18,{steps:8});
 await page.mouse.up();
 await saved();
 const afterResize=readStudio(work)!;if(afterResize.kind!=='document')throw Error();
 const resized=afterResize.content.blocks.find(b=>b.type==='image')!;
 assert.ok(typeof resized.position?.width==='number'&&resized.position.width>(beforeWidth??150),`width grew from ${beforeWidth} to ${resized.position?.width}`);
 const output=await exportStudio(afterResize,work);
 await fs.writeFile(out+'/crosspage-edited.docx',output.buffer);
 await fs.writeFile(out+'/crosspage-edited.pdf',await renderWordPreview(output.buffer));
 for(let i=0;i<3;i++){const data=await frame().locator('canvas').nth(i).evaluate(e=>(e as HTMLCanvasElement).toDataURL());await fs.writeFile(`${out}/page-${i+1}.png`,Buffer.from(data.split(',')[1]!,'base64'));}
 assert.deepEqual(errors,[]);
 console.log('PASS cross-page drag re-anchors on the target page, corner handle resizes, native Word export regenerated');
}finally{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
