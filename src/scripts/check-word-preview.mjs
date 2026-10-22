import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const server=createServer(async(req,res)=>{try{if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<style>iframe{width:100%;height:850px;border:0}</style><main data-file-preview></main><script type="module">import{showWordPreview}from"/studio-preview.js";showWordPreview(document,"test");</script>');return;}if(req.url.startsWith('/api/studio/preview')){res.setHeader('content-type','application/pdf');res.end(await fs.readFile('output/word-native-preview/complex-preview.pdf'));return;}res.setHeader('content-type',req.url.endsWith('.html')?'text/html':'text/javascript');res.end(await fs.readFile('ui'+req.url));}catch(e){res.statusCode=500;res.end(String(e));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1100,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto('http://127.0.0.1:'+server.address().port);const frame=page.frameLocator('iframe');await frame.locator('.word-page').first().waitFor({timeout:20000});await frame.locator('#status').waitFor({state:'hidden'});
 assert.equal(await frame.locator('.word-page').count(),5);assert.match(await frame.locator('#counter').innerText(),/Microsoft Word/);
 for(let n=0;n<5;n++){const section=frame.locator('.word-page').nth(n);assert.match(await section.getAttribute('aria-description'),new RegExp(`Page\\s+${n+1}\\s+of\\s+5`));const data=await section.locator('canvas').evaluate(e=>e.toDataURL('image/png'));await fs.writeFile(`output/word-native-preview/preview-page-${n+1}.png`,Buffer.from(data.split(',')[1],'base64'));}
 assert.equal(await frame.locator('.word-page').nth(3).evaluate(e=>e.clientWidth>e.clientHeight),true);
 await frame.locator('#zoom').selectOption('100');assert.equal(await frame.locator('#pages.actual-size').count(),1);
 await frame.locator('#zoom').selectOption('fit');await page.setViewportSize({width:390,height:844});assert.equal(await frame.locator('body').evaluate(e=>e.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);console.log('PASS: five Word-rendered pages, page numbers, landscape, sandbox PDF canvas, fit/100% and mobile width.');
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
