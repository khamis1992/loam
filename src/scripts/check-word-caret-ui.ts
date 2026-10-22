import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {importStudio} from '../studio/import.js';
import {readStudio,saveStudio} from '../studio/store.js';
import {exportStudio} from '../studio/export.js';
import {interactiveWordCopy} from '../studio/word-preview-links.js';
import {renderWordPreview} from '../studio/word-preview.js';
const out='output/word-caret-preview';await fs.mkdir(out,{recursive:true});const work=await fs.mkdtemp(out+'/ui-');
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
 const page=await browser.newPage({viewport:{width:1500,height:1100}});await page.goto('http://127.0.0.1:'+(server.address() as any).port);await page.locator('[data-action=read-document]').click();
 const frame=()=>page.frameLocator('iframe.office-file-preview');const ready=async()=>{await frame().locator('.word-page').first().waitFor({timeout:90000});await frame().locator('#status').waitFor({state:'hidden',timeout:90000});};await ready();let revision=1;
 const saveWaitMs:number[]=[];let saveStarted=0;
 const saved=async()=>{revision++;await page.locator('[data-status]').filter({hasText:'الإصدار '+revision}).waitFor({timeout:90000});const regenerated=frame().locator('#status');await regenerated.waitFor({state:'visible',timeout:90000}).catch(()=>{});await regenerated.waitFor({state:'hidden',timeout:90000});saveWaitMs.push(Date.now()-saveStarted);};
 const commit=async(click:()=>Promise<any>)=>{saveStarted=Date.now();await click();await saved();};
 await frame().locator('[data-target="0/text"]').first().click();await frame().getByRole('textbox',{name:'الكتابة داخل السطر'}).fill('Annual operating report — direct caret editing');await commit(()=>frame().locator('[data-caret-save]').click());
 await frame().locator('[data-target="2/stat/0/value"]').first().click();await frame().getByRole('textbox',{name:'الكتابة داخل السطر'}).fill('98%');await commit(()=>frame().locator('[data-caret-save]').click());
 await frame().locator('[data-target="4/cell/23/2"]').first().click();await frame().getByRole('textbox',{name:'الكتابة داخل السطر'}).fill('Caret verified');await commit(()=>frame().locator('[data-caret-save]').click());
 await frame().locator('[data-target="6/text"]').first().click();const caret=frame().getByRole('textbox',{name:'الكتابة داخل السطر'});await caret.fill('Landscape dashboard — revised cells and illustration');await frame().locator('[data-caret-insert]').click();await frame().locator('[data-cancel]').last().click();assert.equal(await caret.innerText(),'Landscape dashboard — revised cells and illustration');await caret.press('Home');for(let i=0;i<10;i++)await caret.press('ArrowRight');await frame().locator('[data-caret-insert]').click();await frame().locator('[data-inline-text]').fill('INSERTED AT THE TEXT CARET');await commit(()=>frame().locator('[data-commit]').click());
 const drag=async(index:number,dx:number,dy:number)=>{const handle=frame().locator(`[data-drag-index="${index}"]`);await handle.scrollIntoViewIfNeeded();const box=(await handle.boundingBox())!;await page.mouse.move(box.x+10,box.y+10);await page.mouse.down();await page.mouse.move(box.x+10+dx,box.y+10+dy,{steps:8});saveStarted=Date.now();await page.mouse.up();await saved();};
 await drag(10,130,70);await drag(2,8,45);
 const landscape=frame().locator('.word-page[data-page="4"] canvas');await landscape.scrollIntoViewIfNeeded();const landscapeBox=(await landscape.boundingBox())!;await landscape.dblclick({position:{x:landscapeBox.width*.67,y:landscapeBox.height*.65}});await frame().locator('[data-new-type]').selectOption('stats');await commit(()=>frame().locator('[data-commit]').click());
 const a=readStudio(work)!;if(a.kind!=='document')throw Error();assert.match(a.content.blocks[0]!.text,/direct caret/);assert.equal((a.content.blocks[2] as any).items[0].value,'98%');assert.ok(a.content.blocks[2]!.position);assert.ok(a.content.blocks.find(b=>b.type==='image')!.position);assert.equal(a.content.blocks[7]!.text,'INSERTED AT THE TEXT CARET');assert.equal(a.content.blocks[6]!.text+a.content.blocks[8]!.text,'Landscape dashboard — revised cells and illustration');assert.equal(a.content.blocks.filter(b=>b.position).length,3);
 const output=await exportStudio(a,work);await fs.writeFile(out+'/caret-edited.docx',output.buffer);await fs.writeFile(out+'/caret-edited.pdf',await renderWordPreview(output.buffer));await fs.writeFile(out+'/artifact.json',JSON.stringify(a,null,2));
 for(let i=0;i<await frame().locator('canvas').count();i++){const data=await frame().locator('canvas').nth(i).evaluate(e=>(e as HTMLCanvasElement).toDataURL());await fs.writeFile(`${out}/page-${i+1}.png`,Buffer.from(data.split(',')[1]!,'base64'));}
 await fs.writeFile(out+'/save-wait-times.json',JSON.stringify({saveWaitMs,median:saveWaitMs.slice().sort((a,b)=>a-b)[Math.floor(saveWaitMs.length/2)]},null,2));
 console.log('PASS direct text/card/cell caret, mid-paragraph insertion, native Word image/card coordinates, regenerated preview; save-to-preview waits ms: ['+saveWaitMs.join(', ')+']');
}finally{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
