import {safeZip,part,first,all,serialize,W,xml} from './ooxml.js';
import {children} from './word-import.js';
import {StudioError,type StudioArtifact} from './store.js';

/** Body-node mapping shared by positioning and the PDF hit-map. */
export function wordBlockNodes(doc:any,artifact:Extract<StudioArtifact,{kind:'document'}>){
 const nodes=children(first(doc,W,'body')).filter(n=>n.localName!=='sectPr');let cursor=artifact.sourceId?0:1;
 return artifact.content.blocks.map((b,index)=>{
  if(!artifact.sourceId&&index===0&&b.type==='heading'&&b.text.trim()===artifact.title.trim())return nodes[0];
  if(b.sourceNode!==undefined)return nodes[cursor++];
  if(b.sourceIndex!==undefined)return null;
  if(b.type==='table'){if(b.text)cursor++;const n=nodes[cursor];cursor+=2;return n;}
  if(b.type==='stats'||b.type==='image'){const n=nodes[cursor];cursor+=2;return n;}
  return nodes[cursor++];
 });
}
const WP='http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
/** Persist page coordinates as native Word anchors, not preview-only transforms. Units: points. */
export async function positionWord(buffer:Buffer,artifact:Extract<StudioArtifact,{kind:'document'}>){
 if(!artifact.content.blocks.some(b=>b.position))return buffer;
 const zip=await safeZip(buffer),doc=await part(zip,'word/document.xml'),nodes=wordBlockNodes(doc,artifact);
 artifact.content.blocks.forEach((b,i)=>{
  if(!b.position)return;const node=nodes[i];if(!node)throw new StudioError('Reimport this document before positioning elements.');
  const {x,y,width}=b.position;
  if(b.type==='image'){
   const old=first(node,WP,'inline')||first(node,WP,'anchor');if(!old)throw new StudioError('This drawing does not support positioning.');
   const anchor=xml(`<wp:anchor xmlns:wp="${WP}" distT="91440" distB="91440" distL="91440" distR="91440" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="0"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${Math.round(x*12700)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${Math.round(y*12700)}</wp:posOffset></wp:positionV></wp:anchor>`).documentElement;
   const next=doc.importNode(anchor,true);for(const name of ['extent','effectExtent']){const n=first(old,WP,name);if(n)next.appendChild(n.cloneNode(true));}
   const wrap=doc.createElementNS(WP,'wp:wrapSquare');wrap.setAttribute('wrapText','bothSides');next.appendChild(wrap);
   for(const name of ['docPr','cNvGraphicFramePr','graphic']){const n=first(old,'*',name);if(n)next.appendChild(n.cloneNode(true));}
   if(width){const extent=first(next,WP,'extent'),size=Number(extent?.getAttribute('cx'));if(size>0&&Math.abs(width*12700-size)>1){const ratio=width*12700/size;for(const e of [extent,...all(next,'http://schemas.openxmlformats.org/drawingml/2006/main','ext')]){e.setAttribute('cx',String(Math.round(Number(e.getAttribute('cx'))*ratio)));e.setAttribute('cy',String(Math.round(Number(e.getAttribute('cy'))*ratio)));}}}
   old.parentNode.replaceChild(next,old);
  }else if(b.type==='stats'||b.type==='table'){
   let props=first(node,W,'tblPr');if(!props){props=doc.createElementNS(W,'w:tblPr');node.insertBefore(props,node.firstChild);}
   for(const p of all(props,W,'tblpPr'))p.parentNode.removeChild(p);
   const p=doc.createElementNS(W,'w:tblpPr');for(const [key,val] of Object.entries({horzAnchor:'page',vertAnchor:'page',tblpX:Math.round(x*20),tblpY:Math.round(y*20),leftFromText:120,rightFromText:120,topFromText:120,bottomFromText:120}))p.setAttributeNS(W,'w:'+key,String(val));props.insertBefore(p,props.firstChild);
   if(width){const grid=all(node,W,'gridCol'),total=grid.reduce((n,c)=>n+Number(c.getAttributeNS(W,'w')),0);if(total>0){const ratio=width*20/total;for(const col of grid)col.setAttributeNS(W,'w:w',String(Math.round(Number(col.getAttributeNS(W,'w'))*ratio)));for(const cell of all(node,W,'tcW'))if(cell.getAttributeNS(W,'type')==='dxa')cell.setAttributeNS(W,'w:w',String(Math.round(Number(cell.getAttributeNS(W,'w'))*ratio)));const tableWidth=first(props,W,'tblW');if(tableWidth){tableWidth.setAttributeNS(W,'w:type','dxa');tableWidth.setAttributeNS(W,'w:w',String(Math.round(width*20)));}}}
  }else{
   let props=first(node,W,'pPr');if(!props){props=doc.createElementNS(W,'w:pPr');node.insertBefore(props,node.firstChild);}
   for(const p of all(props,W,'framePr'))p.parentNode.removeChild(p);
   const p=doc.createElementNS(W,'w:framePr');for(const [key,val] of Object.entries({hAnchor:'page',vAnchor:'page',x:Math.round(x*20),y:Math.round(y*20),wrap:'around',hSpace:120,vSpace:120}))p.setAttributeNS(W,'w:'+key,String(val));props.insertBefore(p,props.firstChild);
   if(width)p.setAttributeNS(W,'w:w',String(Math.round(width*20)));
  }
 });
 zip.file('word/document.xml',serialize(doc));return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
