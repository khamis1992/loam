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

// NOTICE: The bullet parsing section below is an original clean-room TypeScript
// model inspired by DeckCraft-style "bullets to native charts/diagrams" flows.
// It turns plain bullet lists into the same series/categories data model used
// above (see SourceChart), plus a simple node/edge diagram model.
// No third-party code is copied.

export type ChartKind='bar'|'line'|'pie'|'area';
export type BulletChart={kind:ChartKind;title:string;categories:string[];series:Array<{name:string;values:number[]}>};
const CHART_KINDS=new Set<ChartKind>(['bar','line','pie','area']);
const BULLET_MARKER=/^\s*(?:[-*•–—]|\d+[.)])\s+/;
const chartFail=(message:string):never=>{throw new StudioError(message);};
function chartLines(input:unknown):string[]{
  const raw=typeof input==='string'?input.split(/\r?\n/):Array.isArray(input)?input:chartFail('Expected bullet lines as a string or string array');
  const lines:string[]=[];
  for(const line of raw){if(typeof line!=='string'||line.length>1000)chartFail('Invalid bullet line');const text=line.trim();if(text)lines.push(text);}
  if(!lines.length||lines.length>400)chartFail('Expected 1..400 non-empty bullet lines');
  return lines;
}
function chartValue(token:string):number{
  const clean=token.trim().replace(/%$/,'').replace(/^\+/,'');
  if(!clean)chartFail('Empty chart value');
  const value=Number(clean);
  if(!Number.isFinite(value)||Math.abs(value)>1e12)chartFail('Invalid chart value: '+token);
  return value;
}
export function parseBulletChartData(input:unknown,opts?:{kind?:ChartKind;title?:string;seriesName?:string}):BulletChart{
  if(opts?.kind!==undefined&&!CHART_KINDS.has(opts.kind))chartFail('Invalid chart kind');
  let kind:ChartKind=opts?.kind??'bar',title=opts?.title??'',categories:string[]|null=null;
  const rows:Array<{name:string;values:number[]}>=[];
  for(const line of chartLines(input)){
    const body=line.replace(BULLET_MARKER,'');
    const colon=body.indexOf(':');
    if(colon<0){rows.push({name:body.trim(),values:[chartValue(body.trim())]});continue;}
    const head=body.slice(0,colon).trim(),headKey=head.toLowerCase(),tail=body.slice(colon+1).trim();
    if(!head||!tail)chartFail('Invalid chart bullet: '+line);
    if(headKey==='title'){if(title)chartFail('Duplicate chart title');title=tail;if(tail.length>300)chartFail('Chart title too long');continue;}
    if(headKey==='type'||headKey==='chart'){if(!CHART_KINDS.has(tail.toLowerCase() as ChartKind))chartFail('Unknown chart type: '+tail);kind=tail.toLowerCase() as ChartKind;continue;}
    if(headKey==='categories'||headKey==='labels'||headKey==='x'){if(categories)chartFail('Duplicate chart categories');categories=tail.split(',').map(v=>v.trim());if(!categories.length||categories.some(v=>!v||v.length>500))chartFail('Invalid chart categories');continue;}
    const values=tail.split(',').map(chartValue);
    if(!values.length||values.length>200||head.length>500)chartFail('Invalid chart series: '+line);
    rows.push({name:head,values});
  }
  if(!rows.length)chartFail('No chart data in bullets');
  const names=new Set(rows.map(r=>r.name));if(names.size!==rows.length)chartFail('Duplicate chart series names');
  const single=rows.every(r=>r.values.length===1);
  const result:BulletChart=single&&!categories
    ?{kind,title,categories:rows.map(r=>r.name),series:[{name:opts?.seriesName||title||'Values',values:rows.map(r=>r.values[0]!)}]}
    :(()=>{const length=rows[0]!.values.length;
      if(rows.some(r=>r.values.length!==length))chartFail('Chart series must have equal lengths');
      if(categories&&categories.length!==length)chartFail('Categories/series length mismatch');
      return {kind,title,categories:categories??Array.from({length},(_,i)=>String(i+1)),series:rows.map(r=>({name:r.name,values:r.values}))};})();
  if(result.kind==='pie'&&result.series.length>1)chartFail('Pie charts support one series');
  if(result.categories.length>200||result.series.length>12)chartFail('Chart dimensions exceed limits');
  return result;
}

export type DiagramLayout='flow'|'hierarchy'|'sequential';
export type DiagramNode={id:string;label:string};
export type DiagramEdge={from:string;to:string};
export type BulletDiagram={title:string;layout:DiagramLayout;nodes:DiagramNode[];edges:DiagramEdge[]};
const ARROW=/(?:=>|->|→|⟶)/;
export function parseBulletDiagram(input:unknown,opts?:{title?:string}):BulletDiagram{
  let title=opts?.title??'';
  const items=chartLines(input).map(line=>{
    const indent=/^\s*/.exec(line)![0].replace(/\t/g,'  ').length;
    const label=(BULLET_MARKER.test(line)?line.replace(BULLET_MARKER,''):line).trim();
    if(!label)chartFail('Empty diagram step');
    if(label.length>300)chartFail('Diagram label too long');
    if(/^title:/i.test(label)){if(title)chartFail('Duplicate diagram title');title=label.slice(6).trim();if(!title)chartFail('Missing diagram title');return null;}
    return {depth:Math.floor(indent/2),label};
  }).filter((l):l is {depth:number;label:string}=>l!==null);
  if(!items.length)chartFail('No diagram steps');
  const nodes:DiagramNode[]=[],edges:DiagramEdge[]=[];
  const flow=items.some(i=>ARROW.test(i.label)),hierarchy=!flow&&new Set(items.map(i=>i.depth)).size>1;
  const addItem=(label:string):string=>{
    if(nodes.length>=60)chartFail('Diagram exceeds 60 nodes');
    const id='n'+(nodes.length+1);nodes.push({id,label});return id;
  };
  if(flow){
    const byLabel=new Map<string,string>();
    const nodeFor=(label:string):string=>{const found=byLabel.get(label);if(found)return found;const id=addItem(label);byLabel.set(label,id);return id;};
    for(const item of items){
      const parts=item.label.split(ARROW).map(p=>p.trim());
      if(parts.length===1)nodeFor(item.label);
      else for(let i=0;i+1<parts.length;i++){const from=nodeFor(parts[i]!),to=nodeFor(parts[i+1]!);if(from!==to)edges.push({from,to});}
    }
  }else if(hierarchy){
    const stack:Array<{depth:number;id:string}>=[];
    for(const item of items){
      while(stack.length&&stack[stack.length-1]!.depth>=item.depth)stack.pop();
      const id=addItem(item.label);
      if(stack.length)edges.push({from:stack[stack.length-1]!.id,to:id});
      stack.push({depth:item.depth,id});
    }
  }else{
    let prev:string|null=null;
    for(const item of items){const id=addItem(item.label);if(prev)edges.push({from:prev,to:id});prev=id;}
  }
  if(edges.length>120)chartFail('Diagram exceeds 120 edges');
  return {title,layout:flow?'flow':hierarchy?'hierarchy':'sequential',nodes,edges};
}
