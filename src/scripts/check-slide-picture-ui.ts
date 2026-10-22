import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {importStudio} from '../studio/import.js';
import {saveStudio} from '../studio/store.js';
import {exportStudio} from '../studio/export.js';
import {renderSlidePreview} from '../studio/slide-preview.js';
import {safeZip,part,first,serialize,A,P} from '../studio/ooxml.js';
const out='output/office-frontier',work=await fs.mkdtemp(out+'/picture-ui-');
const zip=await safeZip(await fs.readFile(out+'/slides-with-image.pptx')),doc=await part(zip,'ppt/slides/slide1.xml'),pic=first(doc,P,'pic'),fill=first(pic,P,'blipFill'),xf=first(first(pic,P,'spPr'),A,'xfrm');
xf.setAttribute('rot','300000');xf.setAttribute('flipH','1');
let crop=first(fill,A,'srcRect');if(!crop){crop=doc.createElementNS(A,'a:srcRect');fill.insertBefore(crop,first(fill,A,'stretch'));}crop.setAttribute('l','10000');crop.setAttribute('r','5000');
const media=Object.keys(zip.files).filter(n=>/^ppt\/media\/.+\.(png|jpe?g)$/i.test(n));assert.equal(media.length,1);
const fixture=sharp(Buffer.from('<svg width="600" height="400" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="400" fill="#d7eadf"/><rect x="0" y="30" width="160" height="340" fill="#da915a"/><circle cx="360" cy="180" r="90" fill="#147263"/><path d="M470 50 L570 50 L570 350 Z" fill="#172e29"/></svg>'));
zip.file(media[0]!,await (/png$/i.test(media[0]!)?fixture.png():fixture.jpeg()).toBuffer());
zip.file('ppt/slides/slide1.xml',serialize(doc));const source=await zip.generateAsync({type:'nodebuffer'});
let artifact=await importStudio(work,source,'original-picture.pptx',0);if(artifact.kind!=='presentation')throw Error();
await fs.writeFile(out+'/original-picture-before.png',await renderSlidePreview(source,1));
const server=createServer(async(req,res)=>{try{const u=new URL(req.url!,'http://localhost');if(u.pathname==='/api/studio/slide-preview'){res.setHeader('content-type','image/png');res.end(await renderSlidePreview((await exportStudio(artifact,work)).buffer,1));return;}if(u.pathname==='/api/studio'){if(req.method==='POST'){let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);await exportStudio(body.artifact,work);artifact=saveStudio(work,body.artifact,body.expectedRevision);}res.setHeader('content-type','application/json');res.end(JSON.stringify({artifact}));return;}if(u.pathname==='/'){res.setHeader('content-type','text/html');res.end('<html dir="rtl"><link rel="stylesheet" href="/studio.css"><style>*{box-sizing:border-box}body{margin:20px;background:#10231b}</style><div id="host"></div><script type="module">import{createStudio}from"/studio.js";createStudio({ensureDraft:async()=>({id:"picture"}),confirm:async()=>true}).mount(document.getElementById("host"),{mode:"write",taskId:"picture",key:"picture"});</script></html>');return;}res.setHeader('content-type',u.pathname.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile('ui'+u.pathname));}catch(e){res.statusCode=400;res.end(JSON.stringify({error:String(e)}));}});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1450,height:1100}});await page.goto('http://127.0.0.1:'+(server.address() as any).port);await page.locator('.office-native-ready').waitFor({timeout:120000});
 await page.locator('summary').filter({hasText:'الصورة الأصلية'}).click();
 const field=(key:string)=>page.locator(`[data-source-picture="0"][data-picture-prop="${key}"]`);
 const handle=page.locator('[data-source-picture-drag="0"]');await handle.scrollIntoViewIfNeeded();const handleBox=(await handle.boundingBox())!;
 const beforeDrag=await field('x').inputValue();await page.mouse.move(handleBox.x+5,handleBox.y+5);await page.mouse.down();await page.mouse.move(handleBox.x+70,handleBox.y+40,{steps:4});await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await field('x').inputValue(),beforeDrag);assert.equal(await page.locator('.office-source-picture.dragging').count(),0);assert.equal(artifact.revision,1);
 const originalX=await field('x').inputValue();await field('x').fill('99');await field('x').press('Tab');assert.equal(await field('x').inputValue(),originalX,'Invalid geometry restores the last accepted value');
 for(const [key,value] of [['w','25.125'],['h','35.375'],['x','60.125'],['y','32.125']]){await field(key!).fill(value!);await field(key!).press('Tab');}
 await field('text').fill('صورة أصلية معدّلة مع الاحتفاظ بالقصّ');await page.locator('[data-action=save]').click();await page.locator('[data-status]').filter({hasText:'الإصدار 2'}).waitFor();await page.locator('.office-native-status').filter({hasText:'تتجدد بعد الحفظ'}).waitFor({timeout:120000});
 await handle.scrollIntoViewIfNeeded();const start=(await handle.boundingBox())!,canvas=(await page.locator('.office-slide').boundingBox())!;
 await page.mouse.move(start.x+5,start.y+5);await page.mouse.down();await page.mouse.move(start.x+45,start.y+25,{steps:5});await page.mouse.up();
 const expectedX=60.125+40/canvas.width*100,expectedY=32.125+20/canvas.height*100;assert.ok(Math.abs(Number(await field('x').inputValue())-expectedX)<.001);assert.ok(Math.abs(Number(await field('y').inputValue())-expectedY)<.001);
 await page.locator('[data-action=save]').click();await page.locator('[data-status]').filter({hasText:'الإصدار 3'}).waitFor();await page.locator('.office-native-status').filter({hasText:'تتجدد بعد الحفظ'}).waitFor({timeout:120000});
 await handle.focus();await handle.press('ArrowLeft');assert.ok(Math.abs(Number(await field('x').inputValue())-(expectedX-.5))<.001);await page.locator('[data-action=save]').click();await page.locator('[data-status]').filter({hasText:'الإصدار 4'}).waitFor();await page.locator('.office-native-status').filter({hasText:'تتجدد بعد الحفظ'}).waitFor({timeout:120000});
 const resize=page.locator('[data-source-picture-resize="0"]');await resize.scrollIntoViewIfNeeded();const corner=(await resize.boundingBox())!;
 const resizeStart=async()=>{await page.mouse.move(corner.x+5,corner.y+5);await page.mouse.down();await page.mouse.move(corner.x-25,corner.y-15,{steps:5});};
 await resizeStart();await page.keyboard.press('Escape');await page.mouse.up();assert.equal(Number(await field('w').inputValue()),25.125);assert.equal(artifact.revision,4);
 await resizeStart();await page.mouse.up();const resizedW=Number(await field('w').inputValue()),resizedH=Number(await field('h').inputValue());assert.ok(resizedW<25.125);assert.ok(Math.abs(resizedW/resizedH-25.125/35.375)<.00001);
 await page.locator('[data-action=save]').click();await page.locator('[data-status]').filter({hasText:'الإصدار 5'}).waitFor();await page.locator('.office-native-status').filter({hasText:'تتجدد بعد الحفظ'}).waitFor({timeout:120000});
 await page.screenshot({path:out+'/original-picture-editor.png'});
 const output=await exportStudio(artifact,work),after=await safeZip(output.buffer),updated=first(await part(after,'ppt/slides/slide1.xml'),P,'pic'),updatedXf=first(first(updated,P,'spPr'),A,'xfrm');
 await fs.writeFile(out+'/original-picture-edited.pptx',output.buffer);await fs.writeFile(out+'/original-picture-after.png',await renderSlidePreview(output.buffer,1));
 if(artifact.kind!=='presentation')throw Error();assert.ok(Math.abs(Number(artifact.content.slides[0]!.sourcePictures![0]!.x)-(expectedX-.5))<.001);assert.ok(Math.abs(Number(artifact.content.slides[0]!.sourcePictures![0]!.w)-resizedW)<.0001);
 const size=first(await part(after,'ppt/presentation.xml'),P,'sldSz');assert.equal(Number(first(updatedXf,A,'off').getAttribute('x')),Math.round(Number(size.getAttribute('cx'))*(expectedX-.5)/100));
 const savedPicture=artifact.content.slides[0]!.sourcePictures![0]!;for(const [key,dimension]of [['w','cx'],['h','cy']])assert.equal(Number(first(updatedXf,A,'ext').getAttribute(dimension!)),Math.round(Number(size.getAttribute(dimension!))*Number(savedPicture[key!])/100));
 assert.equal(updatedXf.getAttribute('rot'),'300000');assert.equal(updatedXf.getAttribute('flipH'),'1');assert.equal(serialize(first(updated,P,'blipFill')),serialize(fill));
 let preserved=0;for(const name of Object.keys(zip.files)){if(zip.files[name]!.dir||['ppt/slides/slide1.xml','ppt/presentation.xml'].includes(name))continue;assert.deepEqual(await zip.file(name)!.async('nodebuffer'),await after.file(name)!.async('nodebuffer'));preserved++;}
 const prior=structuredClone(savedPicture);
 await page.locator('[data-source-picture-file="0"]').setInputFiles('output/office-frontier/picture-replacement.png');
 await page.locator('[data-status]').filter({hasText:'تم استبدال الصورة'}).waitFor();
 await page.locator('[data-action=save]').click();await page.locator('[data-status]').filter({hasText:'الإصدار 6'}).waitFor();await page.locator('.office-native-status').filter({hasText:'تتجدد بعد الحفظ'}).waitFor({timeout:120000});
 const replacement=(artifact.content as any).slides[0].sourcePictures[0];assert.ok(/^data:image\/(png|jpeg);base64,/.test(replacement.src));for(const key of ['x','y','w','h','text'])assert.equal(replacement[key],prior[key]);
 const replaced=await exportStudio(artifact,work),rz=await safeZip(replaced.buffer),rp=first(await part(rz,'ppt/slides/slide1.xml'),P,'pic');assert.equal(serialize(first(rp,P,'spPr')),serialize(first(updated,P,'spPr')));assert.equal(serialize(first(rp,A,'srcRect')),serialize(first(updated,A,'srcRect')));
 await fs.writeFile(out+'/original-picture-replaced-ui.pptx',replaced.buffer);await fs.writeFile(out+'/original-picture-replaced-ui-native.png',await renderSlidePreview(replaced.buffer,1));await page.locator('summary').filter({hasText:'الصورة الأصلية'}).click();await page.screenshot({path:out+'/original-picture-replaced-ui.png'});
 assert.equal(Number(await field('cropLeft').inputValue()),10);assert.equal(Number(await field('cropRight').inputValue()),5);
 await field('cropLeft').fill('95');await field('cropLeft').press('Tab');assert.equal(Number(await field('cropLeft').inputValue()),10);assert.equal(artifact.revision,6);
 for(const [key,value]of [['cropLeft','22.125'],['cropRight','12.25'],['cropTop','8'],['cropBottom','14']]){await field(key!).fill(value!);await field(key!).press('Tab');}
 await page.locator('[data-action=save]').click();await page.locator('[data-status]').filter({hasText:'الإصدار 7'}).waitFor();await page.locator('.office-native-status').filter({hasText:'تتجدد بعد الحفظ'}).waitFor({timeout:120000});
 const cropped=await exportStudio(artifact,work),cz=await safeZip(cropped.buffer),cp=first(await part(cz,'ppt/slides/slide1.xml'),P,'pic');assert.equal(first(cp,A,'srcRect').getAttribute('l'),'22125');assert.equal(serialize(first(cp,P,'spPr')),serialize(first(rp,P,'spPr')));
 await fs.writeFile(out+'/picture-cropped-ui.pptx',cropped.buffer);await fs.writeFile(out+'/picture-cropped-ui-native.png',await renderSlidePreview(cropped.buffer,1));await page.screenshot({path:out+'/picture-cropped-ui.png'});
 console.log('PASS picture geometry/gestures, replacement, crop controls, invalid-crop recovery, native refresh and preserved frame/media');
}finally{await browser.close();server.closeAllConnections();server.close();}

