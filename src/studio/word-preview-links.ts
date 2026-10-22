import { safeZip, part, first, all, W, R, A, serialize, textOf } from './ooxml.js';
import { children } from './word-import.js';
import type { StudioArtifact, DocumentBlock } from './store.js';
import {wordBlockNodes} from './word-position.js';

/** Invisible PDF link rectangles supplied by Word, never written to the exported DOCX. */
export async function interactiveWordCopy(buffer: Buffer, artifact: Extract<StudioArtifact,{kind:'document'}>): Promise<Buffer> {
  const zip=await safeZip(buffer),doc=await part(zip,'word/document.xml'),rels=await part(zip,'word/_rels/document.xml.rels');
  // A header or drawing in an imported file must not impersonate editor controls.
  for(const file of Object.values(zip.files).filter(f=>f.name.endsWith('.rels'))){
    const relationships=file.name==='word/_rels/document.xml.rels'?rels:await part(zip,file.name);
    for(const rel of all(relationships,'*','Relationship'))if(/^https?:\/\/loam\.invalid\//i.test(rel.getAttribute('Target')||''))rel.parentNode.removeChild(rel);
    zip.file(file.name,serialize(relationships));
  }
  // Remove pre-existing links from this disposable copy so document content cannot forge editor targets.
  for(const link of all(doc,W,'hyperlink')){while(link.firstChild)link.parentNode.insertBefore(link.firstChild,link);link.parentNode.removeChild(link);}
  for(const link of all(doc,A,'hlinkClick'))link.parentNode.removeChild(link);
  const body=first(doc,W,'body'),nodes=children(body).filter(n=>n.localName!=='sectPr');
  const ids=new Set(all(rels,'*','Relationship').map(n=>n.getAttribute('Id')));let serial=0;
  const link=(p:any,target:string)=>{
    if(!p)return;
    const runs=children(p).filter(n=>n.localName!=='pPr');if(!runs.length)return;
    let id:string;do{id='loamPreview'+(++serial);}while(ids.has(id));ids.add(id);
    const rel=rels.createElementNS(rels.documentElement.namespaceURI,'Relationship');rel.setAttribute('Id',id);rel.setAttribute('Type',R+'/hyperlink');rel.setAttribute('TargetMode','External');rel.setAttribute('Target','https://loam.invalid/edit/'+target);rels.documentElement.appendChild(rel);
    const h=doc.createElementNS(W,'w:hyperlink');h.setAttributeNS(R,'r:id',id);p.appendChild(h);for(const run of runs)h.appendChild(run);
    for(const drawing of all(p,'*','docPr')){for(const old of all(drawing,A,'hlinkClick'))old.parentNode.removeChild(old);const click=doc.createElementNS(A,'a:hlinkClick');click.setAttributeNS(R,'r:id',id);drawing.appendChild(click);}
  };
  const tag=(node:any,b:DocumentBlock,index:number)=>{
    if(b.type==='table'&&node.localName==='tbl')children(node,'tr').forEach((row,r)=>children(row,'tc').forEach((cell,c)=>children(cell,'p').forEach(p=>link(p,`${index}/${r===0?'column/'+c:'cell/'+(r-1)+'/'+c}`))));
    else if(b.type==='stats'&&node.localName==='tbl')children(children(node,'tr')[0],'tc').forEach((cell,c)=>children(cell,'p').forEach((p,n)=>link(p,`${index}/stat/${c}/${n===0?'value':'label'}`)));
    else if(b.type==='image'&&node.localName==='p')link(node,`${index}/image`);
    else if(node.localName==='p')link(node,`${index}/text`);
  };
  // Export order is deterministic: each imported source element is one body node;
  // newly generated rich blocks have their caption/gap nodes alongside them.
  const mapped=wordBlockNodes(doc,artifact);
  for(const [index,b] of artifact.content.blocks.entries()){
    if(b.sourceIndex!==undefined)return buffer; // Legacy imports must be upgraded before spatial editing.
    const n=mapped[index];if(n)tag(n,b,index);
  }
  zip.file('word/document.xml',serialize(doc));zip.file('word/_rels/document.xml.rels',serialize(rels));
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
