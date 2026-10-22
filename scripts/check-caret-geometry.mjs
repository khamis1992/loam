import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
const out=process.env.WORD_REVIEW_DIR||'output/word-caret-preview';
const {taskId}=JSON.parse(await fs.readFile(out+'/installed-task.json','utf8'));
const artifact=JSON.parse(await fs.readFile(out+'/installed-artifact.json','utf8'));
const response=await fetch('http://127.0.0.1:3939/api/studio/preview?interactive=1&taskId='+taskId);assert.ok(response.ok);
const pdf=await getDocument({data:new Uint8Array(await response.arrayBuffer())}).promise;
const zip=await JSZip.loadAsync(await fs.readFile(out+'/installed-caret.docx'));const xml=await zip.file('word/document.xml').async('string');assert.ok(xml.includes('positionH'));assert.ok(xml.includes('tblpPr'));assert.ok(!xml.includes('loam.invalid'));
const imageIndex=artifact.content.blocks.findIndex(b=>b.type==='image'),position=artifact.content.blocks[imageIndex].position;let found;
for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n);for(const a of await page.getAnnotations()){if(a.url===`https://loam.invalid/edit/${imageIndex}/image`){const rect=page.getViewport({scale:1}).convertToViewportRectangle(a.rect);found={page:n,x:Math.min(rect[0],rect[2]),y:Math.min(rect[1],rect[3])};}}}
assert.ok(found);assert.ok(Math.abs(found.x-position.x)<1,JSON.stringify({found,position}));assert.ok(Math.abs(found.y-position.y)<1,JSON.stringify({found,position}));
await fs.writeFile(out+'/geometry-verification.json',JSON.stringify({imageTarget:position,wordRendered:found,tolerancePoints:1,noPreviewLinksInExport:true,nativeImageAndTableAnchors:true},null,2));console.log('PASS actual Word image position within one point of drag target; native anchors; clean exported DOCX');
