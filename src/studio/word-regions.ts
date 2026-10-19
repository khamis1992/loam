import type JSZip from 'jszip';
import {all,patchText,serialize,part,W} from './ooxml.js';
import {StudioError,type StudioArtifact} from './store.js';

/** Distribute edited lines across the region's original paragraphs, preserving each paragraph's runs. */
function patchParagraphLines(paragraphs:any[],text:string){
 const lines=text.split('\n');
 paragraphs.forEach((paragraph,index)=>{const value=index===paragraphs.length-1?lines.slice(index).join('\n'):lines[index]??'';patchText(paragraph,W,value);});
}

/** Header/footer/text-box regions are text-patched in place; structure, references and other parts stay untouched. */
export async function patchWordRegions(zip:JSZip,nodes:any[],artifact:StudioArtifact,baseline:StudioArtifact):Promise<void>{
 const regions=artifact.kind==='document'?artifact.content.regions:undefined;
 const before=baseline.kind==='document'?baseline.content.regions:undefined;
 if(!regions?.length){
  if(before?.length)throw new StudioError('Keep every header, footer and text box region when editing this document');
  return;
 }
 if(!before||regions.length!==before.length||regions.some((region,index)=>region.kind!==before[index]?.kind||region.part!==before[index]?.part||region.node!==before[index]?.node))throw new StudioError('Keep the original header, footer and text box regions');
 const loaded=new Map<string,any>();
 for(const [index,region] of regions.entries()){
  if(region.text===before[index]!.text)continue;
  if(region.part){
   let partDoc=loaded.get(region.part);
   if(!partDoc){partDoc=await part(zip,region.part);loaded.set(region.part,partDoc);}
   const paragraphs=all(partDoc,W,'p');
   if(!paragraphs.length)throw new StudioError('This header or footer has no editable paragraphs');
   patchParagraphLines(paragraphs,region.text);
  }else if(region.node!==undefined){
   const node=nodes[region.node];
   if(!node||!all(node,W,'txbxContent').length)throw new StudioError('The original text box is missing; reimport the document');
   patchParagraphLines(all(all(node,W,'txbxContent')[0],W,'p'),region.text);
  }
 }
 for(const [name,partDoc] of loaded)zip.file(name,serialize(partDoc));
}
