import {all,first,attr,textOf,A,P} from './ooxml.js';
import {StudioError} from './store.js';
type Cell=Record<string,string|number|boolean>;
const children=(node:any,name:string):any[]=>Array.from(node?.childNodes||[]).filter((n:any)=>n.nodeType===1&&n.localName===name);
function tableTargets(doc:any){const result=new Map<string,any>();for(const [i,frame]of all(doc,P,'graphicFrame').entries()){const table=first(frame,A,'tbl');if(!table)continue;const id=attr(first(frame,P,'cNvPr'),'id',String(i));children(table,'tr').forEach((row,r)=>children(row,'tc').forEach((cell,c)=>result.set(`${id}/${r}/${c}`,cell)));}return result;}
export function importSlideTableCells(doc:any,width:number,height:number,warnings:string[]):Cell[]{
 const result:Cell[]=[];
 for(const [i,frame]of all(doc,P,'graphicFrame').entries()){
  const table=first(frame,A,'tbl');if(!table)continue;const transform=first(frame,P,'xfrm');
  let grouped=false;for(let p=frame.parentNode;p;p=p.parentNode)if(p.localName==='grpSp')grouped=true;
  if(grouped||Number(attr(transform,'rot','0'))!==0){warnings.push('يبقى الجدول المجمّع أو المدور محفوظًا، لكن تحرير خلاياه داخل المعاينة غير مدعوم حاليًا.');continue;}
  const off=first(transform,A,'off'),ext=first(transform,A,'ext'),x=Number(attr(off,'x','0')),y=Number(attr(off,'y','0')),w=Number(attr(ext,'cx','0')),h=Number(attr(ext,'cy','0'));
  const columns=children(first(table,A,'tblGrid'),'gridCol').map(n=>Number(attr(n,'w','0'))),rows=children(table,'tr'),heights=rows.map(n=>Number(attr(n,'h','0'))),totalW=columns.reduce((a,b)=>a+b,0),totalH=heights.reduce((a,b)=>a+b,0);
  if(totalW<=0||totalH<=0||w<=0||h<=0)continue;
  const id=attr(first(frame,P,'cNvPr'),'id',String(i));let rowY=0;
  rows.forEach((row,r)=>{let colX=0;children(row,'tc').forEach((cell,c)=>{
   const colW=columns[c]||0;
   if(!['1','true'].includes(attr(cell,'hMerge'))&&!['1','true'].includes(attr(cell,'vMerge'))){
    const span=Math.max(1,Number(attr(cell,'gridSpan','1'))),rowSpan=Math.max(1,Number(attr(cell,'rowSpan','1'))),run=first(cell,A,'rPr');
    result.push({id:`${id}/${r}/${c}`,text:children(first(cell,A,'txBody'),'p').map(p=>textOf(p,A)).join('\n'),x:(x+w*colX/totalW)/width*100,y:(y+h*rowY/totalH)/height*100,w:w*columns.slice(c,c+span).reduce((a,b)=>a+b,0)/totalW/width*100,h:h*heights.slice(r,r+rowSpan).reduce((a,b)=>a+b,0)/totalH/height*100,fontSize:Number(attr(run,'sz','1800'))/100,fontFamily:'Arial'});
   }colX+=colW;
  });rowY+=heights[r]||0;});
 }
 return result;
}
export function patchSlideTableCells(doc:any,current:Cell[]=[],original:Cell[]=[],putText:(node:any,namespace:string,text:string)=>void){
 if(current.length!==original.length||new Set(current.map(c=>c.id)).size!==current.length)throw new StudioError('Preserve every original table cell ID');
 const nodes=tableTargets(doc);
 for(const cell of current){const old=original.find(c=>c.id===cell.id);if(!old)throw new StudioError('Invalid source table cell');const {text,...properties}=cell,{text:before,...oldProperties}=old;if(JSON.stringify(properties)!==JSON.stringify(oldProperties))throw new StudioError('Only text editing is supported for original table cells');if(text!==before){const target=nodes.get(String(cell.id));if(!target)throw new StudioError('Original table cell is unavailable');const body=first(target,A,'txBody');if(!all(body,A,'t').length){let paragraph=first(body,A,'p');if(!paragraph){paragraph=doc.createElementNS(A,'a:p');body.appendChild(paragraph);}const run=doc.createElementNS(A,'a:r'),t=doc.createElementNS(A,'a:t');run.appendChild(t);paragraph.insertBefore(run,first(paragraph,A,'endParaRPr')||null);}putText(body,A,String(text));}}
}
