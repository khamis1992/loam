import {patchSlideCharts} from './slide-chart-data.js';
import {patchSlidePictures} from './slide-picture-edit.js';
import {patchSlidePictureMedia} from './slide-picture-media.js';
import {patchSlideTableCells} from './slide-table-import.js';
import {patchSlideTextBox} from './slide-text-edit.js';
import {patchSheetFormat} from './sheet-roundtrip-format.js';
import {richWordAppender} from './word-merge.js';
import {wordBlockNodes} from './word-position.js';
import {children} from './word-import.js';
import {editWordElement} from './word-edit.js';
import {patchParagraphRuns} from './word-runs.js';
import {patchWordRegions} from './word-regions.js';
import path from 'node:path';
import { loadImport } from './import.js';
import { safeZip,part,all,first,attr,textOf,patchText,serialize,xml,W,A,P,S } from './ooxml.js';
import { StudioError,type StudioArtifact,type DocumentBlock } from './store.js';
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function putText(node:any,namespace:string,value:string){const paragraphs=all(node,namespace,'p');if(namespace===A&&paragraphs.length>1){const lines=value.split('\n');paragraphs.forEach((p,i)=>patchText(p,namespace,i===paragraphs.length-1?lines.slice(i).join('\n'):lines[i]||''));}else patchText(node,namespace,value);}
function plainParagraph(text:string){const p=xml(`<w:p xmlns:w="${W}"><w:r><w:t xml:space="preserve"></w:t></w:r></w:p>`).documentElement;patchText(p,W,text);return p;}
function continuedParagraph(block:any,nodes:any[],doc:any){
 const original=nodes[block.continuationOf];if(!original||original.localName!=='p')throw new StudioError('Invalid paragraph continuation');
 const node=doc.importNode(plainParagraph(block.text),true),props=first(original,W,'pPr'),runProps=first(original,W,'rPr');
 if(props)node.insertBefore(props.cloneNode(true),node.firstChild);
 if(runProps)first(node,W,'r').insertBefore(runProps.cloneNode(true),first(node,W,'r').firstChild);
 return node;
}
function blockStyle(node:any,block:any,old:any={},skipRuns=false){if(block.type===old.type&&block.bold===old.bold&&block.italic===old.italic)return;const doc=node.ownerDocument;let props=first(node,W,'pPr');if(!props){props=doc.createElementNS(W,'w:pPr');node.insertBefore(props,node.firstChild);}if(block.type!==old.type){for(const n of [...all(props,W,'pStyle'),...all(props,W,'numPr')])n.parentNode.removeChild(n);if(block.type==='heading'){const n=doc.createElementNS(W,'w:pStyle');n.setAttributeNS(W,'w:val','Heading1');props.appendChild(n);}else if(block.type==='bullet'){const t=first(node,W,'t');if(t)t.textContent='• '+t.textContent;}}
 if(skipRuns)return;
 for(const run of all(node,W,'r')){let rp=first(run,W,'rPr');if(!rp){rp=doc.createElementNS(W,'w:rPr');run.insertBefore(rp,run.firstChild);}for(const key of ['bold','italic'])if(block[key]!==old[key]){const name=key==='bold'?'b':'i';for(const n of all(rp,W,name))n.parentNode.removeChild(n);const n=doc.createElementNS(W,'w:'+name);n.setAttributeNS(W,'w:val',block[key]?'1':'0');rp.appendChild(n);}}
}

export async function exportImported(artifact:StudioArtifact,workspace:string):Promise<Buffer>{
 const {buffer,manifest}=loadImport(workspace,artifact.sourceId!);if(manifest.artifact.kind!==artifact.kind)throw new StudioError('Imported source kind mismatch');if(same(artifact.content,manifest.artifact.content))return buffer;
 const zip=await safeZip(buffer),baseline=manifest.artifact;
 if(artifact.kind==='document'&&baseline.kind==='document'){
 if(baseline.content.blocks.some(b=>b.sourceNode!==undefined)){
  const doc=await part(zip,'word/document.xml'),body=first(doc,W,'body'),nodes=children(body),section=nodes.find(n=>n.localName==='sectPr');
  const appender=await richWordAppender(zip,doc,artifact.title);
  for(const block of artifact.content.blocks){if(block.sourceNode===undefined)continue;const node=nodes[block.sourceNode],old=baseline.content.blocks.find(b=>b.sourceNode===block.sourceNode);if(!node||!old)throw new StudioError('Unknown imported element');
   if(['stats','table','image'].includes(block.type))await editWordElement(zip,node,block,old,appender);
   else {if(node.localName!=='p')throw new StudioError('This complex element is preserved as-is.');if(block.segments?.length){patchParagraphRuns(node,block,old);blockStyle(node,block,old,true);}else{if(block.text!==old.text){if(!all(node,W,'t').length)node.appendChild(doc.importNode(plainParagraph('').firstChild,true));patchText(node,W,block.text);}blockStyle(node,block,old);}}
  }
  for(const node of nodes)if(node!==section)body.removeChild(node);
  for(const [index,block] of artifact.content.blocks.entries()){if(block.sourceNode!==undefined)body.insertBefore(nodes[block.sourceNode],section||null);else if(['stats','table','image'].includes(block.type)){const layout=artifact.content.blocks.slice(index+1).map(b=>b.sourceNode===undefined&&b.continuationOf===undefined?null:first(nodes[(b.sourceNode??b.continuationOf)!],W,'sectPr')).find(Boolean)||section;await appender.append(block,section||null,layout);}else {const node=block.continuationOf!==undefined?continuedParagraph(block,nodes,doc):doc.importNode(plainParagraph(block.text),true);if(block.segments?.length)patchParagraphRuns(node,block,{} as DocumentBlock);blockStyle(node,block,block.continuationOf!==undefined?block:{},!!block.segments?.length);body.insertBefore(node,section||null);}}
  // A section-ending paragraph split at the caret must end the section only at its final continuation.
  const rebuilt=wordBlockNodes(doc,artifact);
  for(const source of new Set(artifact.content.blocks.map(b=>b.continuationOf).filter(n=>n!==undefined))){const matches=artifact.content.blocks.map((b,i)=>b.sourceNode===source||b.continuationOf===source?rebuilt[i]:null).filter(n=>n&&first(n,W,'sectPr'));for(const n of matches.slice(0,-1)){const s=first(n,W,'sectPr');s.parentNode.removeChild(s);}}
  await patchWordRegions(zip,nodes,artifact,baseline);
  appender.finish();zip.file('word/document.xml',serialize(doc));
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
 }
 const doc=await part(zip,'word/document.xml'),paragraphs=all(doc,W,'p'),seen=new Set<number>();
 const rich=artifact.content.blocks.some(b=>['stats','table','image'].includes(b.type))?await richWordAppender(zip,doc,artifact.title):null;
 for(const block of artifact.content.blocks){if(['stats','table','image'].includes(block.type)){if(block.sourceIndex!==undefined)throw new StudioError('New rich blocks cannot replace source paragraphs');await rich!.append(block);continue;}if(block.sourceIndex!==undefined){if(seen.has(block.sourceIndex)||!paragraphs[block.sourceIndex])throw new StudioError('Invalid or duplicate source paragraph');seen.add(block.sourceIndex);const original=baseline.content.blocks[block.sourceIndex];const node=paragraphs[block.sourceIndex];if(original?.text!==block.text){if(all(node,W,'t').length)patchText(node,W,block.text);else node.appendChild(doc.importNode(plainParagraph(block.text).firstChild,true));}blockStyle(node,block,original);}else{const body=first(doc,W,'body'),paragraph=doc.importNode(plainParagraph(block.text),true);blockStyle(paragraph,block);body.insertBefore(paragraph,first(body,W,'sectPr')||null);}}
 paragraphs.forEach((p,i)=>{if(!seen.has(i)){if(p.parentNode?.localName==='tc'&&all(p.parentNode,W,'p').length===1){while(p.firstChild)p.removeChild(p.firstChild);}else p.parentNode?.removeChild(p);}});rich?.finish();zip.file('word/document.xml',serialize(doc));
 }else if(artifact.kind==='presentation'&&baseline.kind==='presentation'){
 const presentation=await part(zip,'ppt/presentation.xml'),slideSize=first(presentation,P,'sldSz'),slideWidth=Number(attr(slideSize,'cx','12192000')),slideHeight=Number(attr(slideSize,'cy','6858000')),ids=all(presentation,P,'sldId'),list=first(presentation,P,'sldIdLst'),seen=new Set<number>();
 for(const slide of artifact.content.slides){if(slide.sourceIndex===undefined)throw new StudioError('Adding slides to an imported presentation is not yet supported. Edit, reorder or remove the existing slides.');if(seen.has(slide.sourceIndex)||!manifest.parts[slide.sourceIndex])throw new StudioError('Invalid source slide');seen.add(slide.sourceIndex);const file=manifest.parts[slide.sourceIndex]!,doc=await part(zip,file),original=baseline.content.slides[slide.sourceIndex]!;const shapes=all(doc,P,'sp').filter(n=>first(n,P,'txBody'));const boxes=slide.textBoxes||[];if(boxes.length!==(original.textBoxes||[]).length||boxes.some(b=>!original.textBoxes?.some(o=>o.id===b.id)))throw new StudioError('Preserve every original text box ID when editing imported slides');
 for(let i=0;i<shapes.length;i++){const shape=shapes[i],id=attr(first(shape,P,'cNvPr'),'id',String(i)),box=boxes.find(b=>b.id===id),old=original.textBoxes?.find(b=>b.id===id);let text=box?String(box.text):i===0?slide.title:i===1?slide.body:undefined;if(box&&old&&box.text===old.text){if(i===0&&slide.title!==original.title)text=slide.title;else if(i===1&&slide.body!==original.body)text=slide.body;}if(text!==undefined&&text!==(old?.text??textOf(shape,A)))putText(shape,A,text);if(box&&old)patchSlideTextBox(shape,box,old,slideWidth,slideHeight);}
 await patchSlideCharts(zip,file,doc,slide.sourceCharts,original.sourceCharts);
 patchSlidePictures(doc,slide.sourcePictures,original.sourcePictures,slideWidth,slideHeight);
 await patchSlidePictureMedia(zip,file,doc,slide.sourcePictures,original.sourcePictures);
 patchSlideTableCells(doc,slide.tableCells,original.tableCells,putText);
 if(slide.background!==original.background){let bg=first(doc,P,'bg');if(!bg){bg=doc.createElementNS(P,'p:bg');first(doc,P,'cSld').insertBefore(bg,first(doc,P,'spTree'));}while(bg.firstChild)bg.removeChild(bg.firstChild);const fragment=xml(`<p:bgPr xmlns:p="${P}" xmlns:a="${A}"><a:solidFill><a:srgbClr val="${slide.background.slice(1)}"/></a:solidFill><a:effectLst/></p:bgPr>`);bg.appendChild(doc.importNode(fragment.documentElement,true));}
 zip.file(file,serialize(doc));if(slide.notes!==original.notes){const relfile=path.posix.join(path.posix.dirname(file),'_rels',path.posix.basename(file)+'.rels');if(zip.file(relfile)){const rels=await part(zip,relfile),rel=all(rels,'*','Relationship').find(n=>attr(n,'Type').endsWith('/notesSlide'));if(rel){const notefile=path.posix.normalize(path.posix.join(path.posix.dirname(file),attr(rel,'Target'))),notes=await part(zip,notefile),body=all(notes,P,'sp').find(n=>attr(first(n,P,'ph'),'type')==='body');if(body)putText(body,A,slide.notes);zip.file(notefile,serialize(notes));}else if(slide.notes)throw new StudioError('This imported slide has no notes part. Its notes cannot be added yet.');}else if(slide.notes)throw new StudioError('This imported slide has no notes part. Its notes cannot be added yet.');}
 list.appendChild(ids[slide.sourceIndex]);}
 ids.forEach((id,i)=>{if(!seen.has(i))list.removeChild(id);});zip.file('ppt/presentation.xml',serialize(presentation));
 }else if(artifact.kind==='spreadsheet'&&baseline.kind==='spreadsheet'){
 const book=await part(zip,'xl/workbook.xml'),sheetnodes=all(book,S,'sheet'),list=first(book,S,'sheets'),seen=new Set<number>();
 for(const sheet of artifact.content.sheets){if(sheet.sourceIndex===undefined)throw new StudioError('Adding sheets to an imported workbook is not yet supported. Edit or rename its existing sheets.');if(seen.has(sheet.sourceIndex)||!manifest.parts[sheet.sourceIndex])throw new StudioError('Invalid source sheet');seen.add(sheet.sourceIndex);const oldName=baseline.content.sheets[sheet.sourceIndex]!.name;if(sheet.name!==oldName)throw new StudioError('Renaming imported sheets is not yet supported because formulas may reference the original names.');const file=manifest.parts[sheet.sourceIndex]!,doc=await part(zip,file),data=first(doc,S,'sheetData'),old=baseline.content.sheets[sheet.sourceIndex]!;const rowNodes=all(data,S,'row'),rows=new Map(rowNodes.map(n=>[Number(attr(n,'r')),n]));
 const count=Math.max(sheet.cells.length,old.cells.length);for(let r=0;r<count;r++){const row=sheet.cells[r]||[],before=old.cells[r]||[];for(let c=0;c<Math.max(row.length,before.length);c++){const value=row[c]||'';if(value===(before[c]||''))continue;let col='',n=c+1;while(n){n--;col=String.fromCharCode(65+n%26)+col;n=Math.floor(n/26);}const address=col+(r+1);let rowNode=rows.get(r+1);if(!rowNode){rowNode=doc.createElementNS(S,'row');rowNode.setAttribute('r',String(r+1));const next=all(data,S,'row').find(n=>Number(attr(n,'r'))>r+1);data.insertBefore(rowNode,next||null);rows.set(r+1,rowNode);}let cell=all(rowNode,S,'c').find(n=>attr(n,'r')===address);if(!cell){cell=doc.createElementNS(S,'c');cell.setAttribute('r',address);const columnNumber=(label:string)=>{let v=0;for(const ch of label.replace(/\d/g,''))v=v*26+ch.charCodeAt(0)-64;return v;};const next=all(rowNode,S,'c').find(n=>columnNumber(attr(n,'r'))>c+1);rowNode.insertBefore(cell,next||null);}const originalCellType=attr(cell,'t');while(cell.firstChild)cell.removeChild(cell.firstChild);cell.removeAttribute('t');if(value.startsWith('=')&&value.length>1){const f=doc.createElementNS(S,'f');f.textContent=value.slice(1);cell.appendChild(f);}else if((!originalCellType||originalCellType==='n')&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&/^\d{4}-\d{2}-\d{2}$/.test(before[c]||'')&&Number.isFinite(Date.parse(value))){const v=doc.createElementNS(S,'v');const epoch=attr(first(book,S,'workbookPr'),'date1904')==='1'?Date.UTC(1904,0,1):Date.UTC(1899,11,30);v.textContent=String((Date.parse(value+'T00:00:00Z')-epoch)/86400000);cell.appendChild(v);}else if(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)&&value.replace(/[-.]/g,'').length<=15){const v=doc.createElementNS(S,'v');v.textContent=value;cell.appendChild(v);}else{cell.setAttribute('t','inlineStr');const is=doc.createElementNS(S,'is'),t=doc.createElementNS(S,'t');t.setAttribute('xml:space','preserve');t.textContent=value;is.appendChild(t);cell.appendChild(is);}}}
 await patchSheetFormat(zip,doc,sheet,old);
 const dimension=first(doc,S,'dimension');if(dimension)dimension.parentNode.removeChild(dimension);zip.file(file,serialize(doc));sheetnodes[sheet.sourceIndex].setAttribute('name',sheet.name);list.appendChild(sheetnodes[sheet.sourceIndex]);}
 sheetnodes.forEach((n,i)=>{if(!seen.has(i))list.removeChild(n);});let calc=first(book,S,'calcPr');if(!calc){calc=book.createElementNS(S,'calcPr');book.documentElement.appendChild(calc);}calc.setAttribute('fullCalcOnLoad','1');calc.setAttribute('forceFullCalc','1');zip.file('xl/workbook.xml',serialize(book));
 }
 return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}

