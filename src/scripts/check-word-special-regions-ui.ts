import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {importStudio} from '../studio/import.js';
import {readStudio,saveStudio} from '../studio/store.js';
import {exportStudio} from '../studio/export.js';
import {renderWordPreview} from '../studio/word-preview.js';
const out='output/word-special-regions';await fs.mkdir(out,{recursive:true});const work=await fs.mkdtemp(out+'/ui-');
await importStudio(work,await fs.readFile(out+'/special-source.docx'),'special.docx',0);
await fs.writeFile(out+'/cell-image.png',await sharp({create:{width:120,height:60,channels:3,background:'#2a8868'}}).png().toBuffer());
const server=createServer(async(req,res)=>{try{const url=new URL(req.url!,'http://localhost');
 if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
 if(url.pathname==='/api/studio'){if(req.method==='POST'){let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);if(body.validateExport)await exportStudio(body.artifact,work);res.setHeader('content-type','application/json');res.end(JSON.stringify({artifact:saveStudio(work,body.artifact,body.expectedRevision)}));return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({artifact:readStudio(work)}));return;}
 if(url.pathname==='/'){res.setHeader('content-type','text/html');res.end('<html dir="rtl"><link rel="stylesheet" href="/studio.css"><style>body{margin:20px;background:#14291f}#host{max-width:1100px;margin:auto}</style><div id="host"></div><script type="module">import{createStudio}from"/studio.js";createStudio({confirm:async()=>true,ensureDraft:async()=>({id:"test"})}).mount(document.getElementById("host"),{mode:"write",taskId:"test",key:"test"});</script></html>');return;}
 res.setHeader('content-type',url.pathname.endsWith('.html')?'text/html':url.pathname.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile('ui'+url.pathname));
 }catch(error:any){res.statusCode=error.status||500;res.end(JSON.stringify({error:error.message}));}});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+(server.address() as any).port);await page.locator('[data-block-text="0"]').filter({visible:true}).waitFor();
 // The regions panel lists headers, footers and text boxes of the imported file.
await page.locator('.office-regions').waitFor();assert.equal(await page.locator('[data-region-text]').count(),3);
 await page.locator('.office-regions > summary').click();
 const headerField=page.locator('[data-region-text]').first();
 await headerField.fill('LOAM SPECIAL REGIONS REVIEW — واجهة الرأس');
 const tableSection=page.locator('[data-block].document-rich').first();
 await tableSection.scrollIntoViewIfNeeded();
 await tableSection.locator('[data-cell-image-row]').selectOption('0');
 await tableSection.locator('[data-cell-image-column]').selectOption('1');
 await tableSection.locator('[data-cell-image-file]').setInputFiles(out+'/cell-image.png');
 await page.locator('[data-action=save]').click();
 await page.locator('[data-status]').filter({hasText:'الإصدار 2'}).waitFor({timeout:60000});
 const artifact=readStudio(work)!;if(artifact.kind!=='document')throw Error();
 assert.equal(artifact.content.regions![0]!.text,'LOAM SPECIAL REGIONS REVIEW — واجهة الرأس');
 const table=artifact.content.blocks.find(b=>b.type==='table')!;
 assert.deepEqual((table as any).cellImages.map((image:any)=>[image.row,image.column]),[[0,1]],'cell image saved from the UI');
 assert.match((table as any).cellImages[0].src,/^data:image\/(png|jpeg);base64,/);
 // The exported file renders through Word with the edited header and the in-cell image.
 const output=await exportStudio(artifact,work);
 await fs.writeFile(out+'/special-ui-edited.docx',output.buffer);
 const pdf=await renderWordPreview(output.buffer);
 await fs.writeFile(out+'/special-ui-edited.pdf',pdf);
 assert.deepEqual(errors,[]);
 console.log('PASS special regions UI: header editing, cell image insertion through the studio editor, native Word export');
}finally{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
