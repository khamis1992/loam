import {patchPrintSettings,type SheetPrint} from './sheet-print.js';
import type JSZip from 'jszip';
import {borderSides} from './sheet-borders.js';
import {part,first,all,attr,serialize,S} from './ooxml.js';
import {StudioError} from './store.js';
type Sheet={styles?:Record<string,Record<string,string|number|boolean>>;columnWidths?:number[];rowHeights?:number[];merges?:string[];hiddenRows?:boolean[];hiddenColumns?:boolean[];printSettings?:SheetPrint};
const children=(n:any,name:string):any[]=>Array.from(n.childNodes||[]).filter((x:any)=>x.nodeType===1&&x.localName===name);
const index=(s:string)=>[...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
function row(doc:any,r:number){const data=first(doc,S,'sheetData');let node=children(data,'row').find(n=>Number(attr(n,'r'))===r);if(!node){node=doc.createElementNS(S,'row');node.setAttribute('r',String(r));data.insertBefore(node,children(data,'row').find(n=>Number(attr(n,'r'))>r)||null);}return node;}
function cell(doc:any,address:string){const match=/^([A-Z]+)(\d+)$/.exec(address)!;const parent=row(doc,Number(match[2]));let node=children(parent,'c').find(n=>attr(n,'r')===address);if(!node){node=doc.createElementNS(S,'c');node.setAttribute('r',address);parent.insertBefore(node,children(parent,'c').find(n=>index(attr(n,'r').replace(/\d/g,''))>index(match[1]!))||null);}return node;}
function replaceChild(doc:any,parent:any,name:string,attrs:Record<string,string>|null){for(const old of children(parent,name))parent.removeChild(old);if(attrs){const n=doc.createElementNS(S,name);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);parent.appendChild(n);}}

/** Append derived styles; never mutate a shared original style used by other cells. */
export async function patchSheetFormat(zip:JSZip,doc:any,current:Sheet,old:Sheet){
 for(const key of ['hiddenRows','hiddenColumns'] as const)if(JSON.stringify(current[key]||[])!==JSON.stringify(old[key]||[]))throw new StudioError('Changing row or column visibility in imported workbooks is not supported yet.');
 if(JSON.stringify(current.merges||[])!==JSON.stringify(old.merges||[]))throw new StudioError('Changing merged ranges in imported workbooks is not supported yet.');
 patchPrintSettings(doc,current.printSettings,old.printSettings);
 const addresses=new Set(Object.keys(current.styles||{}));
 const changed=[...addresses].filter(a=>JSON.stringify(current.styles?.[a]||{})!==JSON.stringify(old.styles?.[a]||{}));
 if(changed.length){
  if(!zip.file('xl/styles.xml'))throw new StudioError('This workbook has no style part. Add formatting in Excel before importing it.');
  const styles=await part(zip,'xl/styles.xml'),root=styles.documentElement;
  const list=(name:string)=>{let n=first(styles,S,name);if(!n){n=styles.createElementNS(S,name);const order=['numFmts','fonts','fills','borders','cellStyleXfs','cellXfs','cellStyles','dxfs','tableStyles','colors','extLst'];root.insertBefore(n,Array.from(root.childNodes).find((x:any)=>order.indexOf(x.localName)>order.indexOf(name))||null);}return n;};
  const fonts=list('fonts'),fills=list('fills'),xfs=list('cellXfs');
  const append=(parent:any,node:any,name:string)=>{const items=children(parent,name),serialized=serialize(node),existing=items.findIndex(n=>serialize(n)===serialized);if(existing>=0)return existing;parent.appendChild(node);parent.setAttribute('count',String(items.length+1));return items.length;};
  for(const address of changed){
   const value=current.styles?.[address]||{},before=old.styles?.[address]||{},target=cell(doc,address),column=index(address.replace(/\d/g,'')),columnStyle=all(doc,S,'col').find(n=>Number(attr(n,'min'))<=column&&Number(attr(n,'max'))>=column),styleId=target.hasAttribute('s')?attr(target,'s'):target.parentNode.hasAttribute('s')?attr(target.parentNode,'s'):attr(columnStyle,'style','0'),original=children(xfs,'xf')[Number(styleId)];if(!original)throw new StudioError('Invalid original cell style');
   const xf=original.cloneNode(true),different=(key:string)=>value[key]!==undefined&&value[key]!==before[key];
   if(borderSides.some(side=>different('border'+side)||different('border'+side+'Color'))){
    const borders=list('borders'),border=children(borders,'border')[Number(attr(xf,'borderId','0'))]?.cloneNode(true)||styles.createElementNS(S,'border');
    for(const side of borderSides){const key='border'+side,colorKey=key+'Color';if(!different(key)&&!different(colorKey))continue;const name=side.toLowerCase();let edge=children(border,name)[0];if(!edge){edge=styles.createElementNS(S,name);const order=['start','end','left','right','top','bottom','diagonal','vertical','horizontal'];border.insertBefore(edge,Array.from(border.childNodes).find((n:any)=>order.indexOf(n.localName)>order.indexOf(name))||null);}if(different(key)){if(value[key]==='none')edge.removeAttribute('style');else edge.setAttribute('style',String(value[key]));}if(different(colorKey))replaceChild(styles,edge,'color',{rgb:'FF'+String(value[colorKey]).slice(1)});
    }
    xf.setAttribute('borderId',String(append(borders,border,'border')));xf.setAttribute('applyBorder','1');
   }
   if(['fontFamily','fontSize','bold','italic','color'].some(different)){
    const font=children(fonts,'font')[Number(attr(xf,'fontId','0'))]?.cloneNode(true)||styles.createElementNS(S,'font');
    for(const [key,name]of [['fontFamily','name'],['fontSize','sz'],['bold','b'],['italic','i'],['color','color']] as const){if(!different(key))continue;const v=value[key];replaceChild(styles,font,name,v===undefined?null:key==='color'?{rgb:'FF'+String(v).slice(1)}:{val:typeof v==='boolean'?(v?'1':'0'):String(v)});}
    xf.setAttribute('fontId',String(append(fonts,font,'font')));xf.setAttribute('applyFont','1');
   }
   if(different('background')){const fill=styles.createElementNS(S,'fill'),pattern=styles.createElementNS(S,'patternFill');pattern.setAttribute('patternType',value.background?'solid':'none');fill.appendChild(pattern);if(value.background){const color=styles.createElementNS(S,'fgColor');color.setAttribute('rgb','FF'+String(value.background).slice(1));pattern.appendChild(color);}xf.setAttribute('fillId',String(append(fills,fill,'fill')));xf.setAttribute('applyFill','1');}
   if(different('numberFormat')){const format=String(value.numberFormat||'General');let id=0;if(format!=='General'){const formats=list('numFmts'),entries=children(formats,'numFmt'),existing=entries.find(n=>attr(n,'formatCode')===format);id=existing?Number(attr(existing,'numFmtId')):Math.max(163,...entries.map(n=>Number(attr(n,'numFmtId'))))+1;if(!existing){const n=styles.createElementNS(S,'numFmt');n.setAttribute('numFmtId',String(id));n.setAttribute('formatCode',format);formats.appendChild(n);formats.setAttribute('count',String(entries.length+1));}}xf.setAttribute('numFmtId',String(id));xf.setAttribute('applyNumberFormat','1');}
   if(different('alignment')){let a=first(xf,S,'alignment');if(!a){a=styles.createElementNS(S,'alignment');xf.insertBefore(a,first(xf,S,'protection')||first(xf,S,'extLst')||null);}if(value.alignment&&value.alignment!=='general')a.setAttribute('horizontal',String(value.alignment==='both'?'justify':value.alignment==='start'?'left':value.alignment==='end'?'right':value.alignment));else a.removeAttribute('horizontal');xf.setAttribute('applyAlignment','1');}
   if(different('wrapText')||different('verticalAlignment')){let a=first(xf,S,'alignment');if(!a){a=styles.createElementNS(S,'alignment');xf.insertBefore(a,first(xf,S,'protection')||first(xf,S,'extLst')||null);}if(different('wrapText'))a.setAttribute('wrapText',value.wrapText?'1':'0');if(different('verticalAlignment'))a.setAttribute('vertical',value.verticalAlignment==='middle'?'center':String(value.verticalAlignment));xf.setAttribute('applyAlignment','1');}
   target.setAttribute('s',String(append(xfs,xf,'xf')));
  }
  zip.file('xl/styles.xml',serialize(styles));
 }
 current.rowHeights?.forEach((height,i)=>{if(height===old.rowHeights?.[i])return;const n=row(doc,i+1);n.setAttribute('ht',String(height));n.setAttribute('customHeight','1');});
 current.columnWidths?.forEach((width,i)=>{if(width===old.columnWidths?.[i])return;let cols=first(doc,S,'cols');if(!cols){cols=doc.createElementNS(S,'cols');doc.documentElement.insertBefore(cols,first(doc,S,'sheetData'));}const col=i+1,existing=children(cols,'col').find(n=>Number(attr(n,'min'))<=col&&Number(attr(n,'max'))>=col);const n=existing?existing.cloneNode(true):doc.createElementNS(S,'col');if(existing){const min=Number(attr(existing,'min')),max=Number(attr(existing,'max'));if(min<col){const left=existing.cloneNode(true);left.setAttribute('max',String(col-1));cols.insertBefore(left,existing);}if(max>col){const right=existing.cloneNode(true);right.setAttribute('min',String(col+1));cols.insertBefore(right,existing);}cols.removeChild(existing);}n.setAttribute('min',String(col));n.setAttribute('max',String(col));n.setAttribute('width',String(width));n.setAttribute('customWidth','1');cols.insertBefore(n,children(cols,'col').find(c=>Number(attr(c,'min'))>col)||null);});
}
