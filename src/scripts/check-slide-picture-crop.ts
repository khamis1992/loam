import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { importStudio } from '../studio/import.js';
import { exportStudio } from '../studio/export.js';
import { saveStudio, validateStudio } from '../studio/store.js';
import { safeZip, part, first, all, serialize, A, P } from '../studio/ooxml.js';
import { renderSlidePreview } from '../studio/slide-preview.js';
const out='output/office-frontier',source=await fs.readFile(out+'/picture-replace-source.pptx'),zip=await safeZip(source),before=all(await part(zip,'ppt/slides/slide1.xml'),P,'pic');
const work=await fs.mkdtemp(out+'/picture-crop-');let artifact=await importStudio(work,source,'cropped-pictures.pptx',0);
if(artifact.kind!=='presentation')throw Error();
assert.deepEqual((await exportStudio(artifact,work)).buffer,source);
const picture=artifact.content.slides[0]!.sourcePictures![0]!;
assert.equal(picture.cropLeft,10);assert.equal(picture.cropRight,5);assert.equal(picture.cropTop,0);
Object.assign(picture,{cropLeft:22.125,cropRight:12.25,cropTop:8,cropBottom:14});
artifact=saveStudio(work,artifact,1);
const output=await exportStudio(artifact,work),after=await safeZip(output.buffer),pics=all(await part(after,'ppt/slides/slide1.xml'),P,'pic'),rect=first(pics[0],A,'srcRect');
for(const [edge,value]of [['l','22125'],['r','12250'],['t','8000'],['b','14000']])assert.equal(rect.getAttribute(edge!),value);
assert.equal(serialize(first(pics[0],P,'spPr')),serialize(first(before[0],P,'spPr')));assert.equal(serialize(first(pics[0],A,'blip')),serialize(first(before[0],A,'blip')));assert.equal(serialize(pics[1]),serialize(before[1]));
let preserved=0;for(const name of Object.keys(zip.files)){if(zip.files[name]!.dir||['ppt/slides/slide1.xml','ppt/presentation.xml'].includes(name))continue;assert.deepEqual(await zip.file(name)!.async('nodebuffer'),await after.file(name)!.async('nodebuffer'));preserved++;}
await fs.writeFile(out+'/picture-cropped.pptx',output.buffer);await fs.writeFile(out+'/picture-cropped-native.png',await renderSlidePreview(output.buffer,1));
const imported=await importStudio(await fs.mkdtemp(out+'/crop-reimport-'),output.buffer,'cropped.pptx',0);assert.equal((imported.content as any).slides[0].sourcePictures[0].cropLeft,22.125);
for(const patch of [{cropLeft:90,cropRight:10},{cropTop:80,cropBottom:20},{cropLeft:NaN}]){const bad=structuredClone(artifact);Object.assign((bad.content as any).slides[0].sourcePictures[0],patch);assert.throws(()=>validateStudio(bad));await assert.rejects(()=>exportStudio(bad,work));}
const outset=structuredClone(artifact);Object.assign((outset.content as any).slides[0].sourcePictures[0],{cropLeft:-10,cropRight:0});validateStudio(outset);await exportStudio(outset,work);
await fs.writeFile(out+'/picture-crop-result.json',JSON.stringify({crop:true,fractional:true,reimport:true,negativeOutset:true,invalidAreaRejected:true,sharedPicturePreserved:true,preservedParts:preserved},null,2));
console.log('PASS native crop, fractional offsets, reimport, outset, invalid-area rejection and original frame/media/shared-picture preservation');
