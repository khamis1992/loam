import type JSZip from 'jszip';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {all,first,attr,part,safeZip,serialize,textOf,A,R,S} from './ooxml.js';
import {StudioError} from './store.js';
export const C='http://schemas.openxmlformats.org/drawingml/2006/chart';
export type SourceChart={id:string;title:string;labels:string[];series:Array<{name:string;values:number[]}>};
export function validateSourceCharts(input:unknown):SourceChart[]{
 if(!Array.isArray(input)||input.length>8)throw new StudioError('Too many original charts');
 const ids=new Set<string>(),text=(v:unknown,max:number):string=>{if(typeof v!=='string'||v.length>max)throw new StudioError('Invalid chart text');return v;};
 return input.map(c=>{if(!c||typeof c!=='object')throw new StudioError('Invalid chart');const id=text(c.id,100);if(!id||ids.has(id))throw new StudioError('Invalid chart ID');ids.add(id);
  if(!Array.isArray(c.labels)||!c.labels.length||c.labels.length>200||!Array.isArray(c.series)||!c.series.length||c.series.length>12)throw new StudioError('Invalid chart dimensions');
  const labels=c.labels.map((v:unknown)=>text(v,500));const series=c.series.map((s:any)=>{if(!s||!Array.isArray(s.values)||s.values.length!==labels.length||s.values.some((v:unknown)=>typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1e12))throw new StudioError('Invalid chart values');return {name:text(s.name,500),values:[...s.values] as number[]};});
  return {id,title:text(c.title,300),labels,series};
 });
}
const relFile=(file:string)=>path.posix.join(path.posix.dirname(file),'_rels',path.posix.basename(file)+'.rels');
async function related(zip:JSZip,file:string,id:string){
 const rels=await part(zip,relFile(file)),rel=all(rels,'*','Relationship').find(r=>attr(r,'Id')===id);
 if(!rel||attr(rel,'TargetMode')==='External')throw Error('External or missing chart data');
 const target=attr(rel,'Target'),name=path.posix.normalize(path.posix.join(path.posix.dirname(file),target));
 if(target.startsWith('/')||name.startsWith('../')||!zip.file(name))throw Error('Invalid chart data relationship');
 return {name,rels,rel};
}
function range(formula:string){
 const match=/^(?:'((?:[^']|'')+)'|([^'!\[\]]+))!\$?([A-Z]{1,3})\$?([1-9]\d*)(?::\$?([A-Z]{1,3})\$?([1-9]\d*))?$/.exec(formula);
 if(!match)throw Error('Unsupported chart formula');
 const column=(s:string)=>[...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0),label=(n:number):string=>n?label(Math.floor((n-1)/26))+String.fromCharCode(65+(n-1)%26):'';
 const x=column(match[3]!),y=Number(match[4]),ex=column(match[5]||match[3]!),ey=Number(match[6]||match[4]);
 if((ex!==x&&ey!==y)||ex<x||ey<y||(ex-x+1)*(ey-y+1)>200||ey>1048576||ex>16384)throw Error('Unsupported chart range');
 return {sheet:(match[1]||match[2]!).replace(/''/g,"'"),addresses:Array.from({length:Math.max(ex-x,ey-y)+1},(_,i)=>label(x+(ex===x?0:i))+(y+(ey===y?0:i)))};
}
function binding(container:any,numeric=false){
 if(!container)throw Error('Unsupported chart series');
 const formula=first(container,C,'f'),points=all(container,C,'pt'),count=Number(attr(first(container,C,'ptCount'),'val','-1'));
 if(!formula||all(container,C,'lvl').length>1||points.length!==count||count<1||count>200)throw Error('Unsupported chart cache');
 const ref=range(formula.textContent);if(ref.addresses.length!==count)throw Error('Chart range/cache mismatch');
 const values=points.map((p,i)=>{if(attr(p,'idx')!==String(i)||!first(p,C,'v'))throw Error('Sparse chart data');const v=first(p,C,'v').textContent;return numeric?Number(v):String(v);});
 if(numeric&&values.some(v=>!Number.isFinite(v)||Math.abs(Number(v))>1e12))throw Error('Unsupported numeric data');
 return {ref,points,values};
}
async function context(zip:JSZip,slideFile:string,node:any){
 const link=await related(zip,slideFile,node.getAttributeNS(R,'id')),doc=await part(zip,link.name);
 if(first(doc,C,'pivotSource'))throw Error('Pivot chart');
 const external=first(doc,C,'externalData');if(!external)throw Error('No embedded workbook');
 const workbook=await related(zip,link.name,external.getAttributeNS(R,'id'));if(!/\.xlsx$/i.test(workbook.name))throw Error('Unsupported chart workbook');
 const book=await safeZip(await zip.file(workbook.name)!.async('nodebuffer')),bookDoc=await part(book,'xl/workbook.xml');
 const sheets=new Map<string,{file:string;doc:any}>();
 for(const s of all(bookDoc,S,'sheet')){const r=await related(book,'xl/workbook.xml',s.getAttributeNS(R,'id'));sheets.set(attr(s,'name'),{file:r.name,doc:await part(book,r.name)});}
 const series=all(doc,C,'ser').map(ser=>{const cat=first(ser,C,'cat');if(!cat||(!first(cat,C,'strCache')&&!first(cat,C,'multiLvlStrCache')))throw Error('Numeric or unsupported categories');return {name:binding(first(ser,C,'tx')),labels:binding(cat),values:binding(first(ser,C,'val'),true)};});
 if(!series.length||series.length>12)throw Error('Unsupported series count');
 const labels=series[0]!.labels.values;
 for(const s of series){if(s.name.values.length!==1||JSON.stringify(s.labels.values)!==JSON.stringify(labels)||s.values.values.length!==labels.length)throw Error('Mixed category grids');
  for(const b of [s.name,s.labels,s.values]){const sheet=sheets.get(b.ref.sheet);if(!sheet)throw Error('Missing worksheet');for(const address of b.ref.addresses){const cell=all(sheet.doc,S,'c').find(c=>attr(c,'r')===address);if(!cell||first(cell,S,'f'))throw Error('Formula-driven or missing data cell');}}
 }
 return {link,doc,workbook,book,sheets,series};
}
export async function importSlideCharts(zip:JSZip,file:string,slide:any,warnings:string[]):Promise<SourceChart[]>{
 const result:SourceChart[]=[];
 for(const [i,node]of all(slide,C,'chart').entries()){
  try{const ctx=await context(zip,file,node);result.push(validateSourceCharts([{id:node.getAttributeNS(R,'id')+':'+i,title:textOf(first(ctx.doc,C,'title')||ctx.doc,A).slice(0,300),labels:ctx.series[0]!.labels.values.map(String),series:ctx.series.map(s=>({name:String(s.name.values[0]),values:s.values.values.map(Number)}))}])[0]!);}
  catch{warnings.push('مخطط محفوظ بتنسيقه الأصلي؛ تحرير بياناته غير متاح حاليًا لارتباطه الخارجي أو لبنية بياناته المعقدة.');}
 }
 return result;
}
export async function patchSlideCharts(zip:JSZip,file:string,slide:any,current:SourceChart[]=[],original:SourceChart[]=[]){
 current=validateSourceCharts(current);
 if(current.length!==original.length||new Set(current.map(c=>c.id)).size!==current.length)throw new StudioError('Preserve original chart IDs');
 for(const chart of current){const old=original.find(c=>c.id===chart.id);if(!old)throw new StudioError('Unknown original chart');if(JSON.stringify(chart)===JSON.stringify(old))continue;
  if(chart.title!==old.title||chart.labels.length!==old.labels.length||chart.series.length!==old.series.length||chart.series.some(s=>s.values.length!==old.labels.length))throw new StudioError('Preserve the original chart data dimensions and title');
  const node=all(slide,C,'chart').find((n,i)=>n.getAttributeNS(R,'id')+':'+i===chart.id);if(!node)throw new StudioError('Original chart is unavailable');
  const ctx=await context(zip,file,node),writes=new Map<string,string|number>();
  for(const [i,s]of ctx.series.entries())for(const [binding,values]of [[s.name,[chart.series[i]!.name]],[s.labels,chart.labels],[s.values,chart.series[i]!.values]] as const){
   values.forEach((value,k)=>{const key=binding.ref.sheet+'!'+binding.ref.addresses[k];if(writes.has(key)&&writes.get(key)!==value)throw new StudioError('Conflicting shared chart data cells');writes.set(key,value);if(value===binding.values[k])return;
    first(binding.points[k],C,'v').textContent=String(value);
    const sheet=ctx.sheets.get(binding.ref.sheet)!,cell=all(sheet.doc,S,'c').find(c=>attr(c,'r')===binding.ref.addresses[k]);
    while(cell.firstChild)cell.removeChild(cell.firstChild);
    if(typeof value==='number'){cell.removeAttribute('t');const v=sheet.doc.createElementNS(S,'v');v.textContent=String(value);cell.appendChild(v);}
    else{cell.setAttribute('t','inlineStr');const inline=sheet.doc.createElementNS(S,'is'),text=sheet.doc.createElementNS(S,'t');text.setAttribute('xml:space','preserve');text.textContent=value;inline.appendChild(text);cell.appendChild(inline);}
   });
  }
  for(const sheet of ctx.sheets.values())ctx.book.file(sheet.file,serialize(sheet.doc));
  // Clone the chart/workbook so a shared chart on another slide is untouched.
  const token=randomUUID(),chartFile='ppt/charts/loam-chart-'+token+'.xml',bookFile='ppt/embeddings/loam-chart-'+token+'.xlsx',id='loam-'+token;
  ctx.workbook.rel.setAttribute('Target',path.posix.relative(path.posix.dirname(chartFile),bookFile));
  zip.file(chartFile,serialize(ctx.doc));zip.file(relFile(chartFile),serialize(ctx.workbook.rels));zip.file(bookFile,await ctx.book.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
  const rel=ctx.link.rel.cloneNode(true);rel.setAttribute('Id',id);rel.setAttribute('Target',path.posix.relative(path.posix.dirname(file),chartFile));ctx.link.rels.documentElement.appendChild(rel);zip.file(relFile(file),serialize(ctx.link.rels));node.setAttributeNS(R,'r:id',id);
  const types=await part(zip,'[Content_Types].xml');for(const [name,type]of [[chartFile,'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'],[bookFile,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']]){const n=types.createElementNS('http://schemas.openxmlformats.org/package/2006/content-types','Override');n.setAttribute('PartName','/'+name);n.setAttribute('ContentType',type);types.documentElement.appendChild(n);}zip.file('[Content_Types].xml',serialize(types));
 }
}
