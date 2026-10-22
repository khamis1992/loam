import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Document,Packer,Paragraph,TextRun,UnderlineType,ExternalHyperlink} from 'docx';
import {importStudio} from '../studio/import.js';
import {exportStudio} from '../studio/export.js';
import {validateStudio} from '../studio/store.js';
import {safeZip,part,all,first,attr,W} from '../studio/ooxml.js';
import {children} from '../studio/word-import.js';
// @ts-expect-error Shared browser operation module intentionally has no declaration file.
import {previewEdit} from '../../ui/studio-preview-edit.js';

const out='output/word-inline-format';await fs.mkdir(out,{recursive:true});
const mixed='First plain part bold words and colored plus underlined وختامًا عربيًا';
const source=await Packer.toBuffer(new Document({sections:[{children:[
 new Paragraph({children:[
  new TextRun({text:'First plain part ',font:'Georgia',size:24}),
  new TextRun({text:'bold words',bold:true,font:'Georgia',size:24}),
  new TextRun({text:' and ',font:'Georgia',size:24}),
  new TextRun({text:'colored',color:'C00000',font:'Georgia',size:24}),
  new TextRun({text:' plus underlined',underline:{type:UnderlineType.SINGLE},font:'Georgia',size:24}),
  new TextRun({text:' وختامًا عربيًا',font:'Georgia',size:24}),
 ]}),
 new Paragraph({children:[new TextRun({text:'Anchor paragraph without inline variety.',font:'Georgia'})]}),
 new Paragraph({children:[new ExternalHyperlink({children:[new TextRun({text:'Link paragraph ',bold:true})],link:'https://example.com'}),new TextRun({text:'after the link',color:'00AA00'})]}),
]}]}));
await fs.writeFile(out+'/mixed-source.docx',source);
const work=await fs.mkdtemp(out+'/model-');
const artifact=await importStudio(work,source,'mixed.docx',0);
if(artifact.kind!=='document')throw Error('expected document');
const index=artifact.content.blocks.findIndex(block=>block.type==='paragraph'&&block.segments?.length);
assert.ok(index>=0,'mixed paragraph must import inline segments');
const block=artifact.content.blocks[index]!;
assert.equal(block.segments!.map(segment=>segment.text).join(''),block.text);
const bold=block.segments!.find(segment=>segment.text==='bold words')!;
assert.equal(bold.bold,true);
const colored=block.segments!.find(segment=>segment.text==='colored')!;
assert.equal(colored.color,'#C00000');
const underlined=block.segments!.find(segment=>segment.text.includes('underlined'))!;
assert.equal(underlined.underline,true);
const plainCount=block.segments!.filter(segment=>segment.bold===undefined&&segment.color===undefined&&segment.underline===undefined).length;
assert.ok(plainCount>=2,'plain neighbours must survive as their own segments');
const uniform=artifact.content.blocks.find(b=>b.text.startsWith('Anchor paragraph'));
assert.equal(uniform?.segments,undefined,'uniform paragraph must not carry segments');
const linked=artifact.content.blocks.find(b=>b.text.includes('after the link'));
assert.equal(linked?.segments,undefined,'hyperlink paragraphs stay excluded from inline editing');

// Typing inside the paragraph keeps every untouched word's formatting and inherits at the edit boundary.
const typed=previewEdit(artifact,{kind:'replace',index,block:{...structuredClone(block),text:mixed.replace('plain part ','plain edited part ')}},artifact.revision);
const typedSegments=typed.content.blocks[index]!.segments!;
assert.equal(typedSegments.map((s:any)=>s.text).join(''),typed.content.blocks[index]!.text);
assert.equal(typedSegments.find((s:any)=>s.text==='bold words')?.bold,true);
assert.equal(typedSegments.find((s:any)=>s.text==='colored')?.color,'#C00000');
assert.ok(typedSegments.some((s:any)=>s.text.includes('edited')&&s.bold===undefined&&s.color===undefined),'inserted words inherit the surrounding plain format');

// Export rebuilds native runs, cloning the original rPr of each preserved range.
const runsOf=async(buffer:Buffer,sourceNode:number)=>{const doc=await part(await safeZip(buffer),'word/document.xml');const node=children(first(doc,W,'body'))[sourceNode]!;return {node,runs:children(node).filter(n=>n.localName==='r').map(run=>({text:all(run,W,'t').map(t=>t.textContent).join(''),rPr:first(run,W,'rPr')}))};};
const typedOutput=await exportStudio(typed,work);
const {runs}=await runsOf(typedOutput.buffer,block.sourceNode!);
assert.equal(runs.map(run=>run.text).join(''),typed.content.blocks[index]!.text);
const boldRun=runs.find(run=>run.text==='bold words')!;
assert.equal(attr(first(boldRun.rPr,W,'b'),'w:val'),'1');
assert.equal(attr(first(boldRun.rPr,W,'rFonts'),'w:ascii'),'Georgia','original font must be preserved by rPr cloning');
const coloredRun=runs.find(run=>run.text==='colored')!;
assert.equal(attr(first(coloredRun.rPr,W,'color'),'w:val'),'C00000');
assert.equal(first(coloredRun.rPr,W,'b'),undefined,'colour run must not inherit bold from a neighbour template');
const underlinedRun=runs.find(run=>run.text.includes('underlined'))!;
assert.equal(attr(first(underlinedRun.rPr,W,'u'),'w:val'),'single');
assert.equal(runs.length,typedSegments.length,'adjacent equal formats must merge into single runs');

// Formatting a sub-range through the shared helpers produces exact run boundaries after export.
// @ts-expect-error Shared browser module intentionally has no declaration file.
const {formatRange}=await import('../../ui/inline-segments.js');
const start=mixed.indexOf('colored'),end=start+'colored plus'.length;
const formatted=previewEdit(artifact,{kind:'replace',index,block:{...structuredClone(block),segments:formatRange(block.segments!,start,end,{bold:true,highlight:'yellow',size:14})}},artifact.revision);
const formattedSegments=formatted.content.blocks[index]!.segments!;
assert.equal(formattedSegments.map((s:any)=>s.text).join(''),mixed);
const highlighted=formattedSegments.filter((s:any)=>s.highlight==='yellow');
assert.equal(highlighted.map((s:any)=>s.text).join(''),'colored plus');
assert.ok(highlighted.every((s:any)=>s.bold===true&&s.size===14));
const formattedOutput=await exportStudio(formatted,work);
const {runs:formatRuns}=await runsOf(formattedOutput.buffer,block.sourceNode!);
const highlightedRuns=formatRuns.filter(run=>first(run.rPr,W,'highlight'));
assert.equal(highlightedRuns.map(run=>run.text).join(''),'colored plus');
for(const run of highlightedRuns){
 assert.equal(attr(first(run.rPr,W,'highlight'),'w:val'),'yellow');
 assert.equal(attr(first(run.rPr,W,'b'),'w:val'),'1');
 assert.equal(attr(first(run.rPr,W,'sz'),'w:val'),'28');
}
assert.equal(attr(first(highlightedRuns[0]!.rPr,W,'color'),'w:val'),'C00000','explicit segment colour survives with the new properties');
assert.equal(first(highlightedRuns[1]!.rPr,W,'u')===undefined||attr(first(highlightedRuns[1]!.rPr,W,'u'),'w:val'),'single','the plus half keeps its original underline');

// Splitting at the caret distributes the segments across both halves and keeps section structure.
const offset=mixed.indexOf('and ');
const split=previewEdit(artifact,{kind:'split-insert',index,offset,block:{type:'paragraph',text:'Inserted between halves.'}},artifact.revision);
assert.equal(split.content.blocks[index]!.text+split.content.blocks[index+2]!.text,mixed);
const leftHalf=split.content.blocks[index]!,rightHalf=split.content.blocks[index+2]!;
assert.equal(leftHalf.segments?.find((s:any)=>s.text.trim()==='bold words')?.bold,true);
assert.equal(rightHalf.segments?.find((s:any)=>s.text==='colored')?.color,'#C00000');
const splitOutput=await exportStudio(split,work);
const splitDoc=await part(await safeZip(splitOutput.buffer),'word/document.xml');
assert.equal(all(splitDoc,W,'sectPr').length,1,'splitting must not create extra sections');
const {runs:leftRuns}=await runsOf(splitOutput.buffer,leftHalf.sourceNode!);
assert.equal(leftRuns.map(run=>run.text).join(''),leftHalf.text);
assert.equal(attr(first(leftRuns.find(run=>run.text.trim()==='bold words')!.rPr,W,'b'),'w:val'),'1');

// An unchanged artifact must round-trip byte-identically.
const untouched=await exportStudio(artifact,work);
assert.ok(untouched.buffer.equals(source),'no-op export must keep the original bytes');

// Validation rejects segments that disagree with the text or use unsupported values.
const invalid=(segments:unknown)=>{const bad=structuredClone(artifact);bad.content.blocks[index]!.segments=segments as any;return()=>validateStudio(bad);};
assert.throws(invalid([{text:'nope'}]),/Inline formatting must cover/);
assert.throws(invalid([{text:mixed,color:'red'}]),/Inline colors/);
assert.throws(invalid([{text:mixed,highlight:'neon'}]),/highlight/);
assert.throws(invalid([{text:mixed,size:12.3}]),/font size/);
assert.throws(invalid([{text:''}]),/not be empty/);
console.log('PASS inline segment import, reflow on typing, native run rebuild with preserved rPr, sub-range formatting, caret split distribution, byte-identical no-op, validation guards');
