import {A,P,all,first,attr} from './ooxml.js';
import {StudioError} from './store.js';
type Box=Record<string,string|number|boolean>;
const direct=(n:any,name:string)=>Array.from(n?.childNodes||[]).find((c:any)=>c.namespaceURI===A&&c.localName===name) as any;
function ensure(parent:any,name:string,prepend=false){let n=direct(parent,name);if(!n){n=parent.ownerDocument.createElementNS(A,'a:'+name);parent.insertBefore(n,prepend?parent.firstChild:null);}return n;}
function fill(parent:any,color:string){for(const n of Array.from(parent.childNodes) as any[])if(n.namespaceURI===A&&['solidFill','noFill','gradFill','blipFill','pattFill','grpFill'].includes(n.localName))parent.removeChild(n);const fill=parent.ownerDocument.createElementNS(A,'a:solidFill'),rgb=parent.ownerDocument.createElementNS(A,'a:srgbClr');rgb.setAttribute('val',color.slice(1));fill.appendChild(rgb);const next=(Array.from(parent.childNodes) as any[]).find(n=>['latin','ea','cs','sym','hlinkClick','hlinkMouseOver','extLst','ln','effectLst','effectDag','scene3d','sp3d'].includes(n.localName));parent.insertBefore(fill,next||null);}
export function patchSlideTextBox(shape:any,box:Box,old:Box,cx:number,cy:number){
 const changed=(k:string)=>box[k]!==undefined&&box[k]!==old[k];
 if(['x','y','w','h'].some(changed)){
  if(shape.parentNode?.localName==='grpSp')throw new StudioError('Ungroup this text box in PowerPoint before changing its position.');
  const props=first(shape,P,'spPr');if(!props)throw new StudioError('This text box has no editable shape properties');
  const xf=ensure(props,'xfrm',true),off=ensure(xf,'off',true),ext=ensure(xf,'ext');
  if(changed('x'))off.setAttribute('x',String(Math.round(Number(box.x)*cx/100)));else if(!attr(off,'x'))off.setAttribute('x',String(Math.round(Number(old.x)*cx/100)));
  if(changed('y'))off.setAttribute('y',String(Math.round(Number(box.y)*cy/100)));else if(!attr(off,'y'))off.setAttribute('y',String(Math.round(Number(old.y)*cy/100)));
  for(const [key,attribute,size] of [['w','cx',cx],['h','cy',cy]] as const)if(changed(key)||!attr(ext,attribute))ext.setAttribute(attribute,String(Math.round(Number(changed(key)?box[key]:old[key])*size/100)));
 }
 const keys=['fontSize','fontFamily','bold','italic','color'];
 if(keys.some(changed)){
  const body=first(shape,P,'txBody');const props=[...all(body,A,'r').map(r=>ensure(r,'rPr',true)),...all(body,A,'fld').map(r=>ensure(r,'rPr',true)),...all(body,A,'p').map(p=>ensure(ensure(p,'pPr',true),'defRPr')),...all(body,A,'endParaRPr')];
  for(const p of props){if(changed('fontSize'))p.setAttribute('sz',String(Math.round(Number(box.fontSize)*100)));for(const key of ['bold','italic'])if(changed(key))p.setAttribute(key==='bold'?'b':'i',box[key]?'1':'0');if(changed('color'))fill(p,String(box.color));if(changed('fontFamily'))for(const name of ['latin','ea','cs'])ensure(p,name).setAttribute('typeface',String(box.fontFamily));}
 }
 if(changed('alignment'))for(const p of all(first(shape,P,'txBody'),A,'p'))ensure(p,'pPr',true).setAttribute('algn',({left:'l',right:'r',center:'ctr',justify:'just'} as Record<string,string>)[String(box.alignment)]||'l');
 if(changed('background'))fill(first(shape,P,'spPr'),String(box.background));
}
