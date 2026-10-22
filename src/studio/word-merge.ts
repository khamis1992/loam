import {Packer} from 'docx';
import JSZip from 'jszip';
import {randomUUID} from 'node:crypto';
import {createWordDocument} from './word.js';
import {all,first,attr,part,xml,serialize,W,A,R} from './ooxml.js';
import {StudioError,type DocumentBlock} from './store.js';

const REL='http://schemas.openxmlformats.org/package/2006/relationships';
const CT='http://schemas.openxmlformats.org/package/2006/content-types';
const WP='http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
function sectionWidth(section:any):number {
  const size=section&&first(section,W,'pgSz'),margin=section&&first(section,W,'pgMar'),cols=section&&first(section,W,'cols');
  let width=Number(attr(size,'w:w','12240'))-Number(attr(margin,'w:left','1440'))-Number(attr(margin,'w:right','1440'))-Number(attr(margin,'w:gutter','0'));
  const explicitCols=cols?all(cols,W,'col'):[];
  if(explicitCols.length)width=Math.min(...explicitCols.map(c=>Number(attr(c,'w:w'))));
  else {const count=Number(attr(cols,'w:num','1'));width=(width-(count-1)*Number(attr(cols,'w:space','720')))/count;}
  if(!Number.isFinite(width)||width<720||width>31680)throw new StudioError('Unsupported template content width');
  return Math.floor(width);
}

/** Merge only new native content/media; never replace the template's styles or sections. */
export async function richWordAppender(zip:JSZip,doc:any,title:string){
  const body=first(doc,W,'body');
  const section=Array.from(body.childNodes as ArrayLike<any>).find((n:any)=>n.localName==='sectPr');
  const relName='word/_rels/document.xml.rels';
  const rels=zip.file(relName)?await part(zip,relName):xml(`<Relationships xmlns="${REL}"/>`);
  const types=await part(zip,'[Content_Types].xml');
  const used=new Set(all(rels,'*','Relationship').map(n=>attr(n,'Id')));
  let drawingId=Math.max(0,...all(doc,WP,'docPr').map(n=>Number(attr(n,'id','0'))).filter(Number.isFinite));
  for(const name of Object.keys(zip.files).filter(n=>/^word\/(?:header|footer)[^/]*\.xml$/.test(n))){
    drawingId=Math.max(drawingId,...all(await part(zip,name),WP,'docPr').map(n=>Number(attr(n,'id','0'))).filter(Number.isFinite));
  }
  let mediaChanged=false;
  return {
    /** Build imported nodes for one block with relationships remapped; the caller inserts them where needed. A numeric layout means a direct content width in twips. */
    async build(block:DocumentBlock,layoutSection:any=section){
      const width=typeof layoutSection==='number'?layoutSection:sectionWidth(layoutSection);
      const fragment=await JSZip.loadAsync(await Packer.toBuffer(await createWordDocument({kind:'document',title,revision:1,content:{blocks:[block]}},{omitTitle:true,contentWidth:width})));
      const source=await part(fragment,'word/document.xml'),sourceBody=first(source,W,'body');
      const sourceRels=await part(fragment,relName);
      for(const blip of all(sourceBody,A,'blip')){
        const old=blip.getAttributeNS(R,'embed');
        const rel=all(sourceRels,'*','Relationship').find(n=>attr(n,'Id')===old);
        if(!rel||!attr(rel,'Type').endsWith('/image')||attr(rel,'TargetMode')==='External')throw new StudioError('Invalid generated image relationship');
        const target=attr(rel,'Target');if(!/^media\/[\w.-]+\.png$/.test(target))throw new StudioError('Invalid generated media path');
        const media=fragment.file('word/'+target);if(!media)throw new StudioError('Missing generated image');
        const name='loam-'+randomUUID()+'.png';let id='loam-'+randomUUID();while(used.has(id))id='loam-'+randomUUID();used.add(id);
        zip.file('word/media/'+name,await media.async('nodebuffer'));
        const added=rels.createElementNS(REL,'Relationship');added.setAttribute('Id',id);added.setAttribute('Type',R+'/image');added.setAttribute('Target','media/'+name);rels.documentElement.appendChild(added);
        const contentType=types.createElementNS(CT,'Override');contentType.setAttribute('PartName','/word/media/'+name);contentType.setAttribute('ContentType','image/png');types.documentElement.appendChild(contentType);
        blip.setAttributeNS(R,'r:embed',id);mediaChanged=true;
      }
      for(const drawing of all(sourceBody,WP,'docPr'))drawing.setAttribute('id',String(++drawingId));
      const out:any[]=[];
      for(const node of Array.from(sourceBody.childNodes as ArrayLike<any>)){
        if(node.nodeType!==1||node.localName==='sectPr')continue;
        // Local namespace declarations avoid altering or conflicting with template prefixes.
        const copy=doc.importNode(node,true);
        for(const ns of Array.from(source.documentElement.attributes as ArrayLike<any>))if(ns.name.startsWith('xmlns:'))copy.setAttributeNS('http://www.w3.org/2000/xmlns/',ns.name,ns.value);
        out.push(copy);
      }
      return out;
    },
    async append(block:DocumentBlock,before:any=section||null,layoutSection:any=section){
      for(const node of await this.build(block,layoutSection))body.insertBefore(node,before);
    },
    finish(){if(mediaChanged){zip.file(relName,serialize(rels));zip.file('[Content_Types].xml',serialize(types));}}
  };
}
