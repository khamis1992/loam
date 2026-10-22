import {children,runSegmentsOf} from './word-import.js';
import {first,textOf,W} from './ooxml.js';
import {StudioError,type DocumentBlock,type InlineSegment} from './store.js';

/** CT_RPr child order; inserting managed properties at their schema position keeps Word's strict parser satisfied. */
const ORDER: Record<string, number> = {rStyle:0,rFonts:1,b:2,bCs:3,i:4,iCs:5,caps:6,smallCaps:7,strike:8,dstrike:9,outline:10,shadow:11,emboss:12,imprint:13,noProof:14,snapToGrid:15,vanish:16,webHidden:17,color:18,spacing:19,w:20,kern:21,position:22,sz:23,szCs:24,highlight:25,u:26,effect:27,bdr:28,shd:29,fitText:30,vertAlign:31,rtl:32,cs:33,em:34,lang:35,eastAsianLayout:36,specVanish:37,oMath:38};
const high=(value:number)=>value>=0xD800&&value<=0xDBFF,low=(value:number)=>value>=0xDC00&&value<=0xDFFF;

function sameSegments(a?:InlineSegment[],b?:InlineSegment[]){
 if(a===b)return true;
 if(!a||!b||a.length!==b.length)return false;
 return a.every((segment,index)=>{const other=b[index]!;const keys=new Set([...Object.keys(segment),...Object.keys(other)]);return [...keys].every(key=>key==='text'?segment.text===other.text:(segment as any)[key]===(other as any)[key]);});
}
function simpleRunParagraph(node:any):any[]{
 const kids=children(node);
 for(const kid of kids)if(kid.localName!=='pPr'&&kid.localName!=='r')throw new StudioError('This paragraph contains links, fields or other complex content that cannot be edited with inline formatting yet.');
 const runs=kids.filter(kid=>kid.localName==='r');
 for(const run of runs)for(const child of children(run))if(!['rPr','t','br','cr','tab'].includes(child.localName))throw new StudioError('This paragraph contains drawings or field content that cannot be edited with inline formatting yet.');
 return runs;
}
function place(rPr:any,name:string):any{
 for(const child of children(rPr))if(child.localName===name)rPr.removeChild(child);
 const element=rPr.ownerDocument.createElementNS(W,'w:'+name);
 const anchor=children(rPr).find(child=>{const order=ORDER[child.localName];return order!==undefined&&order>ORDER[name]!;});
 if(anchor)rPr.insertBefore(element,anchor);else rPr.appendChild(element);
 return element;
}
function applySegmentProperties(run:any,segment:InlineSegment){
 if(['bold','italic','underline','color','highlight','size','font'].every(key=>(segment as any)[key]===undefined))return;
 let rPr=first(run,W,'rPr');
 if(!rPr){rPr=run.ownerDocument.createElementNS(W,'w:rPr');run.insertBefore(rPr,run.firstChild);}
 if(segment.bold!==undefined)for(const name of ['b','bCs'])place(rPr,name).setAttributeNS(W,'w:val',segment.bold?'1':'0');
 if(segment.italic!==undefined)for(const name of ['i','iCs'])place(rPr,name).setAttributeNS(W,'w:val',segment.italic?'1':'0');
 if(segment.underline!==undefined)place(rPr,'u').setAttributeNS(W,'w:val',segment.underline?'single':'none');
 if(segment.color!==undefined)place(rPr,'color').setAttributeNS(W,'w:val',segment.color.slice(1));
 if(segment.highlight!==undefined)place(rPr,'highlight').setAttributeNS(W,'w:val',segment.highlight);
 if(segment.size!==undefined)for(const name of ['sz','szCs'])place(rPr,name).setAttributeNS(W,'w:val',String(Math.round(segment.size*2)));
 if(segment.font!==undefined){const fonts=place(rPr,'rFonts');for(const key of ['ascii','hAnsi','cs'])fonts.setAttributeNS(W,'w:'+key,segment.font);}
}
/** Original rPr template per baseline segment: the source run with the largest character overlap. */
function baselineTemplates(runs:any[],baseline:InlineSegment[],total:number):(any|null)[]{
 const spans:any[]=[];let position=0;
 for(const run of runs){const length=textOf(run,W).length;spans.push({run,start:position,end:position+length});position+=length;}
 if(position!==total)throw new StudioError('The original paragraph no longer matches its imported text; reimport the document to edit inline formatting.');
 const templates:(any|null)[]=[];let offset=0;
 for(const segment of baseline){
  const end=offset+segment.text.length;let best:any=null,bestOverlap=0;
  for(const span of spans){const overlap=Math.min(end,span.end)-Math.max(offset,span.start);if(overlap>bestOverlap){bestOverlap=overlap;best=first(span.run,W,'rPr');}}
  templates.push(best);offset=end;
 }
 return templates;
}
/** Map a position in the edited text onto the imported text through the common prefix/suffix of the edit. */
function aligner(oldText:string,newText:string){
 let prefix=0;while(prefix<oldText.length&&prefix<newText.length&&oldText[prefix]===newText[prefix])prefix++;
 let suffix=0;while(suffix<oldText.length-prefix&&suffix<newText.length-prefix&&oldText[oldText.length-1-suffix]===newText[newText.length-1-suffix])suffix++;
 if(high(oldText.charCodeAt(prefix-1))&&low(oldText.charCodeAt(prefix)))prefix--;
 const suffixStart=low(oldText.charCodeAt(oldText.length-suffix))&&high(oldText.charCodeAt(oldText.length-suffix-1))?oldText.length-suffix+1:oldText.length-suffix;
 const delta=newText.length-oldText.length;
 return (position:number)=>position<=prefix?position:position>=newText.length-(newText.length-suffixStart-delta)?Math.min(oldText.length,Math.max(prefix,position-delta)):prefix;
}
/** Rebuild the paragraph's plain runs from inline segments, cloning the matching original rPr for unchanged ranges. */
export function patchParagraphRuns(node:any,block:DocumentBlock,old:DocumentBlock):void{
 const segments=block.segments;
 if(!segments||!segments.length)return;
 if(block.text===old.text&&sameSegments(segments,old.segments))return;
 const runs=simpleRunParagraph(node);
 const baseline=(old.segments&&old.segments.length?old.segments:runSegmentsOf(node))??segments;
 const oldText=baseline.map(segment=>segment.text).join(''),newText=segments.map(segment=>segment.text).join('');
 if(newText!==block.text)throw new StudioError('Inline formatting must cover the paragraph text exactly');
 const templates=baselineTemplates(runs,baseline,oldText.length);
 const boundaries:number[]=[];let offset=0;for(const segment of baseline){offset+=segment.text.length;boundaries.push(offset);}
 const align=aligner(oldText,newText);
 const doc=node.ownerDocument,created:any[]=[];let position=0;
 for(const segment of segments){
  const end=position+segment.text.length,mapped=align(Math.floor((position+end)/2));
  const template=templates[boundaries.findIndex(boundary=>mapped<boundary)]??templates[templates.length-1];
  const run=doc.createElementNS(W,'w:r');
  if(template)run.appendChild(template.cloneNode(true));
  applySegmentProperties(run,segment);
  const parts=segment.text.split('\n');
  parts.forEach((line,index)=>{if(index)run.appendChild(doc.createElementNS(W,'w:br'));if(line){const text=doc.createElementNS(W,'w:t');text.setAttribute('xml:space','preserve');text.textContent=line;run.appendChild(text);}});
  created.push(run);position=end;
 }
 for(const run of runs)node.removeChild(run);
 let anchor=first(node,W,'pPr');
 for(const run of created){if(anchor)node.insertBefore(run,anchor.nextSibling);else node.insertBefore(run,node.firstChild);anchor=run;}
}
