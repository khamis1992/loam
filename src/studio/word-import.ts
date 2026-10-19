import path from 'node:path';
import type JSZip from 'jszip';
import {all,first,attr,textOf,part,W,A,R} from './ooxml.js';
import type {DocumentBlock} from './store.js';
export const children=(node:any,name?:string):any[]=>Array.from(node?.childNodes||[]).filter((n:any)=>n.nodeType===1&&(!name||n.localName===name));
const flag=(run:any,name:string)=>{const node=first(run,W,name);return !!node&&!/^(0|false|off)$/i.test(attr(node,'w:val'));};
const knownHighlights=['yellow','green','cyan','magenta','blue','red','darkBlue','darkCyan','darkGreen','darkMagenta','darkRed','darkYellow','darkGray','lightGray','black','white','none'];
const segmentsSignature=(segment:Record<string,unknown>)=>JSON.stringify(['bold','italic','underline','color','highlight','size','font'].map(key=>segment[key]??null));
/** Direct-child runs of a simple paragraph (only pPr and r children) with their explicit formatting, adjacent equal runs merged. */
export function runSegmentsOf(node:any):import('./store.js').InlineSegment[]|undefined{
 const kids=children(node);
 if(!kids.length||!kids.every((k:any)=>k.localName==='pPr'||k.localName==='r'))return undefined;
 const merged:import('./store.js').InlineSegment[]=[];
 for(const run of kids.filter((k:any)=>k.localName==='r')){
  // Rebuilding runs would drop drawings, fields or other run content; only plain text runs are editable inline.
  if(children(run).some((c:any)=>!['rPr','t','br','cr','tab'].includes(c.localName)))return undefined;
  const content=textOf(run,W);if(!content)continue;
  const segment:Record<string,unknown>={text:content};
  if(flag(run,'b'))segment.bold=true;
  if(flag(run,'i'))segment.italic=true;
  const underline=first(run,W,'u');if(underline&&!/^(0|false|off|none)$/i.test(attr(underline,'w:val')))segment.underline=true;
  const color=attr(first(run,W,'color'),'w:val');if(/^[a-f\d]{6}$/i.test(color))segment.color='#'+color.toUpperCase();
  const highlight=attr(first(run,W,'highlight'),'w:val');if(knownHighlights.includes(highlight)&&highlight!=='none')segment.highlight=highlight;
  const size=Number(attr(first(run,W,'sz'),'w:val','0'));if(size>=8&&size<=288)segment.size=size/2;
  const font=attr(first(run,W,'rFonts'),'w:ascii');if(font)segment.font=font;
  const last=merged[merged.length-1];
  if(last&&segmentsSignature(last)===segmentsSignature(segment))last.text+=segment.text as string;else merged.push(segment as import('./store.js').InlineSegment);
 }
 if(!merged.length)return undefined;
 // Uniform single-segment paragraphs carry no inline formatting worth preserving beyond the block-level style.
 return merged.length>1||merged.some(segment=>segment.underline!==undefined||segment.highlight!==undefined)?merged:undefined;
}
export async function importWordBlocks(zip:JSZip,doc:any):Promise<DocumentBlock[]>{
 const blocks:DocumentBlock[]=[];
 const rels=await part(zip,'word/_rels/document.xml.rels');
 for(const [sourceNode,node] of children(first(doc,W,'body')).entries()){
  if(node.localName==='sectPr')continue;
  if(node.localName==='tbl'){
   const rows=children(node,'tr').map(r=>children(r,'tc'));
   const simple=rows.length>0&&rows.length<=201&&rows.every(r=>r.length>0&&r.length<=6)&&!all(node,W,'tbl').length;
   if(simple){
    const cards=rows.length===1&&rows[0]!.length<=4&&rows[0]!.every(c=>children(c,'p').length===2&&/[\d٠-٩]/.test(textOf(children(c,'p')[0],W)));
    if(cards){blocks.push({sourceNode,...(()=>{const width=all(node,W,'gridCol').reduce((sum,c)=>sum+Number(attr(c,'w:w','0')),0)/20;return width>0&&width<=1584?{frameWidth:width}:{};})(),type:'stats',text:'',items:rows[0]!.map(c=>{const ps=children(c,'p'),fill=attr(first(c,W,'shd'),'w:fill').toUpperCase();return {value:textOf(ps[0],W),label:textOf(ps[1],W),tone:fill==='EDF2FC'?'blue':fill==='FFF4DE'?'amber':'teal'};})});continue;}
    const width=Math.max(...rows.map(r=>r.length));const values=rows.map(r=>Array.from({length:width},(_,i)=>r[i]?children(r[i],'p').map(p=>textOf(p,W)).join('\n'):''));
    blocks.push({sourceNode,type:'table',text:'',columns:values[0]!,rows:values.slice(1)});continue;
   }
  }
  const blips=all(node,A,'blip');
  if(node.localName==='p'&&blips.length===1&&!textOf(node,W)){
   const rel=all(rels,'*','Relationship').find(r=>attr(r,'Id')===blips[0].getAttributeNS(R,'embed'));
   const target=rel&&attr(rel,'Target');
   if(target&&attr(rel,'TargetMode')!=='External'){
    const name=path.posix.normalize(path.posix.join('word',target));
    if(name.startsWith('word/')&&/\.(png|jpe?g)$/i.test(name)&&zip.file(name)){
     const data=await zip.file(name)!.async('nodebuffer');
     if(data.length<1_000_000){blocks.push({sourceNode,type:'image',text:'',alt:attr(first(node,'*','docPr'),'descr',''),src:`data:image/${/png$/i.test(name)?'png':'jpeg'};base64,`+data.toString('base64')});continue;}
    }
   }
  }
  const props=first(node,W,'pPr'),run=first(node,W,'rPr'),font=first(run||node,W,'rFonts'),size=first(run||node,W,'sz'),color=attr(first(run||node,W,'color'),'w:val');
  const type=/heading|title/i.test(attr(first(props||node,W,'pStyle'),'w:val'))?'heading':first(props||node,W,'numPr')?'bullet':'paragraph',segments=runSegmentsOf(node);
  blocks.push({sourceNode,type,text:textOf(node,W),...(segments?{segments}:{}),bold:!!first(run||node,W,'b')&&!/^(0|false|off)$/i.test(attr(first(run||node,W,'b'),'w:val')),italic:!!first(run||node,W,'i')&&!/^(0|false|off)$/i.test(attr(first(run||node,W,'i'),'w:val')),style:{fontFamily:attr(font,'w:ascii','Arial'),fontSize:Number(attr(size,'w:val','22'))/2,color:/^[a-f\d]{6}$/i.test(color)?'#'+color:'#18202b',alignment:attr(first(props||node,W,'jc'),'w:val','left')}});
 }
 return blocks;
}
const regionLabel=(kind:string,name:string,text:string)=>{const head=text.split('\n')[0]!.trim().slice(0,40);return (kind==='header'?'رأس':kind==='footer'?'تذييل':'مربع نص')+' '+(head||name);};
/** Header/footer parts and text boxes stay outside the body flow; capture their text for editing without restructuring. */
export async function importWordRegions(zip:JSZip,doc:any,blocks:DocumentBlock[]):Promise<import('./store.js').DocumentRegion[]|undefined>{
 const regions:import('./store.js').DocumentRegion[]=[];
 const rels=await part(zip,'word/_rels/document.xml.rels');
 const seen=new Set<string>();
 for(const reference of all(doc,W,'headerReference').concat(all(doc,W,'footerReference'))){
  const kind=reference.localName==='headerReference'?'header':'footer';
  const rel=all(rels,'*','Relationship').find(r=>attr(r,'Id')===reference.getAttributeNS(R,'id'));
  const target=rel&&attr(rel,'Target');
  if(!target||attr(rel,'TargetMode')==='External')continue;
  const name=path.posix.normalize(path.posix.join('word',target));
  if(!/^word\/(header|footer)\d*\.xml$/.test(name)||!zip.file(name)||seen.has(name))continue;
  seen.add(name);
  const headerDoc=await part(zip,name),paragraphs=all(headerDoc,W,'p');
  const text=paragraphs.map(p=>textOf(p,W)).join('\n');
  if(!text.trim())continue;
  regions.push({kind,part:name,label:regionLabel(kind,name.replace(/^word\//,''),text),text});
 }
 for(const [sourceNode,node] of children(first(doc,W,'body')).entries()){
  for(const box of all(node,W,'txbxContent')){
   const text=all(box,W,'p').map(p=>textOf(p,W)).join('\n');
   if(!text.trim())continue;
   regions.push({kind:'textbox',node:sourceNode,label:regionLabel('textbox','',(block=>block)(text)),text});
  }
 }
 return regions.length?regions:undefined;
}

