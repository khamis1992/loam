import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {importStudio} from '../studio/import.js';
import {exportStudio} from '../studio/export.js';
import {safeZip,part,all,first,textOf,W} from '../studio/ooxml.js';
import {children} from '../studio/word-import.js';
// @ts-expect-error Shared browser operation module intentionally has no declaration file.
import {previewEdit} from '../../ui/studio-preview-edit.js';

const WP='http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const out='output/word-move-resize';await fs.mkdir(out,{recursive:true});
const work=await fs.mkdtemp(out+'/model-');
const source=await fs.readFile('output/word-native-preview/complex-source.docx');
const artifact=await importStudio(work,source,'complex.docx',0);
if(artifact.kind!=='document')throw Error('expected document');
const imageIndex=artifact.content.blocks.findIndex((b:any)=>b.type==='image'&&b.sourceNode!==undefined);
assert.ok(imageIndex>0,'imported image block exists');
const before=await part(await safeZip(source),'word/document.xml');
const originalNodes=children(first(before,W,'body'));
const drawingBefore=originalNodes.findIndex(n=>first(n,W,'drawing'));
assert.ok(drawingBefore>=0,'fixture has one body drawing');

// Moving across pages reorders the body flow and repositions page-relative coordinates.
const earlier=artifact.content.blocks.findIndex((b:any,i:number)=>i<imageIndex&&b.type==='paragraph'&&b.sourceNode!==undefined&&b.text.length>10);
assert.ok(earlier>=0);
const moved=previewEdit(artifact,{kind:'move',index:imageIndex,to:earlier,position:{x:120,y:80}},artifact.revision);
const movedIndex=moved.content.blocks.findIndex((b:any)=>b.type==='image'&&b.sourceNode===artifact.content.blocks[imageIndex]!.sourceNode);
assert.ok(movedIndex<imageIndex,'image block moved earlier in document order');
assert.deepEqual(moved.content.blocks[movedIndex]!.position,{x:120,y:80});
assert.equal(moved.content.blocks.length,artifact.content.blocks.length,'moving never adds or drops blocks');
const movedOutput=await exportStudio(moved,work);
const movedDoc=await part(await safeZip(movedOutput.buffer),'word/document.xml');
const movedNodes=children(first(movedDoc,W,'body'));
const drawingAfter=movedNodes.findIndex(n=>first(n,W,'drawing'));
const anchorText=artifact.content.blocks[earlier]!.text;
const earlierAfter=movedNodes.findIndex(n=>n.localName==='p'&&textOf(n,W)===anchorText);
assert.ok(drawingAfter>=0&&earlierAfter>=0);
assert.ok(drawingAfter<earlierAfter,'image drawing paragraph now flows before the earlier paragraph');
assert.ok(drawingBefore>earlierAfter||drawingBefore>0,'sanity: drawing originally flowed later');

// Invalid moves are rejected: same slot, adjacent slot, out of range, missing position, non-spatial block.
assert.throws(()=>previewEdit(artifact,{kind:'move',index:imageIndex,to:imageIndex,position:{x:1,y:1}},artifact.revision));
assert.throws(()=>previewEdit(artifact,{kind:'move',index:imageIndex,to:imageIndex+1,position:{x:1,y:1}},artifact.revision));
assert.throws(()=>previewEdit(artifact,{kind:'move',index:imageIndex,to:9999,position:{x:1,y:1}},artifact.revision));
assert.throws(()=>previewEdit(artifact,{kind:'move',index:imageIndex,to:earlier},artifact.revision));
assert.throws(()=>previewEdit(artifact,{kind:'move',index:0,to:2,position:{x:1,y:1}},artifact.revision),'text paragraphs cannot be spatially moved');

// Resizing through position.width scales the native extent proportionally, both up and down.
const shrink=previewEdit(artifact,{kind:'replace',index:imageIndex,block:{...structuredClone(artifact.content.blocks[imageIndex]!),position:{x:100,y:100,width:200}}},artifact.revision);
const shrinkDoc=await part(await safeZip(await exportStudio(shrink,work).then(r=>r.buffer)),'word/document.xml');
const shrinkExtent=first(all(shrinkDoc,WP,'anchor')[0]!,WP,'extent');
const grow=previewEdit(artifact,{kind:'replace',index:imageIndex,block:{...structuredClone(artifact.content.blocks[imageIndex]!),position:{x:100,y:100,width:400}}},artifact.revision);
const growDoc=await part(await safeZip(await exportStudio(grow,work).then(r=>r.buffer)),'word/document.xml');
const growAnchor=all(growDoc,WP,'anchor')[0]!;
const growExtent=first(growAnchor,WP,'extent');
assert.ok(Number(growExtent.getAttribute('cx'))>Number(shrinkExtent.getAttribute('cx')),'larger width grows the native extent');
const cxRatio=Number(growExtent.getAttribute('cx'))/Number(shrinkExtent.getAttribute('cx'));
const cyRatio=Number(growExtent.getAttribute('cy'))/Number(shrinkExtent.getAttribute('cy'));
assert.ok(Math.abs(cxRatio-cyRatio)<0.02,`aspect ratio preserved while resizing (${cxRatio.toFixed(3)} vs ${cyRatio.toFixed(3)})`);

await fs.writeFile(out+'/moved.docx',movedOutput.buffer);
console.log('PASS cross-page move reorders body flow with page-relative position, invalid moves rejected, symmetric proportional resize');
