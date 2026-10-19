import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import type JSZip from 'jszip';
import {children} from './word-import.js';
import {all,first,attr,part,patchText,serialize,W,A,R} from './ooxml.js';
import {StudioError,type DocumentBlock} from './store.js';

function cellText(cell:any,value:string){
 const ps=children(cell,'p');const lines=value.split('\n');
 // Preserve paragraph/run properties and rich content whenever the value is unchanged.
 ps.forEach((p,i)=>{const text=i===ps.length-1?lines.slice(i).join('\n'):lines[i]||'';if(!all(p,W,'t').length){const r=p.ownerDocument.createElementNS(W,'w:r'),t=p.ownerDocument.createElementNS(W,'w:t');r.appendChild(t);p.appendChild(r);}patchText(p,W,text);});
}
function resizeGrid(node:any,count:number){const grid=first(node,W,'tblGrid');if(!grid)return;const cols=children(grid,'gridCol'),total=cols.reduce((sum,c)=>sum+Number(attr(c,'w:w','0')),0);while(grid.firstChild)grid.removeChild(grid.firstChild);for(let i=0;i<count;i++){const c=cols[Math.min(i,cols.length-1)]?.cloneNode(true)||node.ownerDocument.createElementNS(W,'w:gridCol');c.setAttributeNS(W,'w:w',String(Math.floor(total/count)));grid.appendChild(c);}for(const row of children(node,'tr'))for(const cell of children(row,'tc')){const width=first(cell,W,'tcW');if(width){width.setAttributeNS(W,'w:w',String(Math.floor(total/count)));width.setAttributeNS(W,'w:type','dxa');}}}
export async function editWordElement(zip:JSZip,node:any,block:DocumentBlock,old:DocumentBlock,appender?:any){
 if(block.type==='table'&&old.type==='table'){
  const rowNodes=children(node,'tr');
  // Newly added cell images are appended as extra paragraphs inside their cell; the cell keeps its own paragraphs.
  for(const image of (block.cellImages??[]).filter(image=>!(old.cellImages??[]).some(before=>before.row===image.row&&before.column===image.column&&before.src===image.src&&before.alt===image.alt))){
   if(!appender)throw new StudioError('Images inside table cells need an imported document.');
   // Model rows exclude the header row; XML rows start with it.
   const rowNode=rowNodes[image.row+1];
   const cell=rowNode&&children(rowNode,'tc')[image.column];
   if(!cell)throw new StudioError('This position is covered by a merged cell. Choose another cell for the image.');
   const width=Number(attr(first(cell,W,'tcW'),'w:w','0'))||Math.floor(9638/Math.max(1,block.columns.length));
   const built=await appender.build({type:'image',text:'',src:image.src,alt:image.alt},width);
   const imageNode=built.find((n:any)=>all(n,A,'blip').length);
   if(!imageNode)throw new StudioError('Could not build the cell image.');
   cell.appendChild(imageNode);
  }
  const values=[block.columns,...block.rows],before=[old.columns,...old.rows];let rows=children(node,'tr');
  const merged=all(node,W,'gridSpan').length||all(node,W,'vMerge').length||rows.some(r=>children(r,'tc').length!==old.columns.length);
  if(merged){if(values.length!==rows.length||block.columns.length!==old.columns.length)throw new StudioError('Preserve the grid of merged tables; edit existing cells or insert a separate table.');values.forEach((row,r)=>row.forEach((value,c)=>{if(value===before[r]?.[c])return;const cell=children(rows[r],'tc')[c];if(!cell)throw new StudioError('This position is covered by a merged cell. Edit the existing cell.');cellText(cell,value);}));return;}
  while(rows.length>values.length){node.removeChild(rows.pop());}
  while(rows.length<values.length){const row=rows[rows.length-1].cloneNode(true);for(const header of all(row,W,'tblHeader'))header.parentNode.removeChild(header);node.appendChild(row);rows.push(row);}
  if(block.columns.length!==old.columns.length){for(const row of rows){const cells=children(row,'tc');while(cells.length>block.columns.length)row.removeChild(cells.pop());while(cells.length<block.columns.length){const c=cells[cells.length-1].cloneNode(true);row.appendChild(c);cells.push(c);}}resizeGrid(node,block.columns.length);}
  values.forEach((row,r)=>row.forEach((value,c)=>{if(value!==before[r]?.[c])cellText(children(rows[r],'tc')[c],value);}));
 }else if(block.type==='stats'&&old.type==='stats'){
  const row=children(node,'tr')[0],cells=children(row,'tc');while(cells.length>block.items.length)row.removeChild(cells.pop());while(cells.length<block.items.length){const c=cells[cells.length-1].cloneNode(true);row.appendChild(c);cells.push(c);}if(block.items.length!==old.items.length)resizeGrid(node,block.items.length);
  block.items.forEach((item,i)=>{const ps=children(cells[i],'p'),prev=old.items[i];if(item.value!==prev?.value)patchText(ps[0],W,item.value);if(item.label!==prev?.label)patchText(ps[1],W,item.label);if(item.tone!==prev?.tone){const shade=first(cells[i],W,'shd');if(shade)shade.setAttributeNS(W,'w:fill',{teal:'EAF5F2',blue:'EDF2FC',amber:'FFF4DE'}[item.tone]);}});
 }else if(block.type==='image'&&old.type==='image'){
  const blip=first(node,A,'blip'),props=first(node,'*','docPr');
  if(props&&block.alt!==old.alt)props.setAttribute('descr',block.alt);
  if(block.src!==old.src){
   const data=await sharp(Buffer.from(block.src.split(',')[1]!,'base64'),{limitInputPixels:24_000_000}).rotate().png().toBuffer();
   const name='loam-edit-'+randomUUID()+'.png',id='loam-'+randomUUID();
   zip.file('word/media/'+name,data);
   const rels=await part(zip,'word/_rels/document.xml.rels'),rel=rels.createElementNS('http://schemas.openxmlformats.org/package/2006/relationships','Relationship');
   rel.setAttribute('Id',id);rel.setAttribute('Type',R+'/image');rel.setAttribute('Target','media/'+name);rels.documentElement.appendChild(rel);zip.file('word/_rels/document.xml.rels',serialize(rels));
   const types=await part(zip,'[Content_Types].xml'),ct=types.createElementNS('http://schemas.openxmlformats.org/package/2006/content-types','Override');ct.setAttribute('PartName','/word/media/'+name);ct.setAttribute('ContentType','image/png');types.documentElement.appendChild(ct);zip.file('[Content_Types].xml',serialize(types));
   blip.setAttributeNS(R,'r:embed',id);
   // Keep the original drawing frame, crop, wrapping and positioning intact.
  }
 }
 if(['table','stats','image'].includes(block.type)&&block.text!==old.text)throw new StudioError('Edit the original caption paragraph separately to preserve its placement.');
}
