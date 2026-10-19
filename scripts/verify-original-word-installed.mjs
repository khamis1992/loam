import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
const out='output/word-original-edit',base='http://127.0.0.1:3939',test=JSON.parse(await fs.readFile(out+'/installed-task.json','utf8'));
const {artifact}=await (await fetch(base+'/api/studio?taskId='+test.taskId)).json(),blocks=artifact.content.blocks;
assert.equal(blocks.find(b=>b.sourceNode===5).items[0].value,'98%');assert.equal(blocks.find(b=>b.sourceNode===8).rows[1][2],'مكتملة');assert.notEqual(blocks.find(b=>b.sourceNode===10).src,test.artifact.content.blocks.find(b=>b.sourceNode===10).src);
assert.equal(blocks[8].sourceNode,undefined);assert.ok(blocks[8].text.includes('أُدرجت من الواجهة'));assert.equal(blocks[9].sourceNode,8);
const response=await fetch(base+'/api/studio/export?taskId='+test.taskId);assert.ok(response.ok);const bytes=Buffer.from(await response.arrayBuffer());await fs.writeFile(out+'/installed-original-edits.docx',bytes);
const before=await JSZip.loadAsync(await fs.readFile(out+'/source.docx')),after=await JSZip.loadAsync(bytes),parser=new DOMParser(),serializer=new XMLSerializer(),w='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const parse=async zip=>parser.parseFromString(await zip.file('word/document.xml').async('string'),'application/xml');const bd=await parse(before),ad=await parse(after),children=doc=>Array.from(doc.getElementsByTagNameNS(w,'body')[0].childNodes).filter(n=>n.nodeType===1),bn=children(bd),an=children(ad);
for(const old of test.artifact.content.blocks){if([5,8,10].includes(old.sourceNode))continue;assert.equal(serializer.serializeToString(an[blocks.findIndex(b=>b.sourceNode===old.sourceNode)]),serializer.serializeToString(bn[old.sourceNode]));}
const preserved=[];for(const name of Object.keys(before.files).filter(n=>!before.files[n].dir&&!['word/document.xml','word/_rels/document.xml.rels','[Content_Types].xml'].includes(n))){assert.deepEqual(await after.file(name).async('nodebuffer'),await before.file(name).async('nodebuffer'));preserved.push(name);}
await fs.writeFile(out+'/installed-verification.json',JSON.stringify({version:'0.5.9',taskId:test.taskId,revision:artifact.revision,editedOriginals:['stats','table','image'],insertedAt:8,unchangedElementsPreserved:true,preservedParts:preserved},null,2));console.log('PASS installed UI original edits and inline insertion; untouched original nodes and '+preserved.length+' supporting parts unchanged');
