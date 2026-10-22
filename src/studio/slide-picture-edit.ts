import {A,P,all,first,attr} from './ooxml.js';
import {patchSlideTextBox} from './slide-text-edit.js';
import {StudioError} from './store.js';
import {cropKeys,importPictureCrop,patchPictureCrop} from './slide-picture-crop.js';
type Picture=Record<string,string|number|boolean>;
export function importSlidePictures(doc:any,width:number,height:number,warnings:string[]):Picture[]{
 const result:Picture[]=[];
 for(const [index,picture]of all(doc,P,'pic').entries()){
  let grouped=false;for(let parent=picture.parentNode;parent;parent=parent.parentNode)if(parent.localName==='grpSp')grouped=true;
  if(grouped){warnings.push('الصورة ضمن مجموعة محفوظة؛ تعديل موضعها يتطلب فك المجموعة في PowerPoint حاليًا.');continue;}
  const properties=first(picture,P,'spPr'),transform=properties&&first(properties,A,'xfrm');if(!transform)continue;
  const off=first(transform,A,'off'),ext=first(transform,A,'ext'),info=first(picture,P,'cNvPr');if(!off||!ext||!info)continue;
  result.push({id:attr(info,'id',String(index)),text:attr(info,'descr'),...importPictureCrop(picture),x:Number(attr(off,'x','0'))/width*100,y:Number(attr(off,'y','0'))/height*100,w:Number(attr(ext,'cx','0'))/width*100,h:Number(attr(ext,'cy','0'))/height*100});
 }
 return result;
}
export function patchSlidePictures(doc:any,current:Picture[]=[],original:Picture[]=[],width:number,height:number){
 if(current.length!==original.length||new Set(current.map(p=>p.id)).size!==current.length)throw new StudioError('Preserve every original picture ID');
 const pictures=all(doc,P,'pic');
 for(const picture of current){const old=original.find(p=>p.id===picture.id);if(!old)throw new StudioError('Invalid original picture ID');
  if(Object.keys(picture).some(k=>!['id','text','x','y','w','h','src',...cropKeys].includes(k)))throw new StudioError('Only original picture geometry, crop, image and description can be edited');
  const shape=pictures.find((p,i)=>attr(first(p,P,'cNvPr'),'id',String(i))===picture.id);if(!shape)throw new StudioError('Original picture is unavailable');
  const changed=['x','y','w','h'].some(k=>picture[k]!==old[k]);
  if(changed&&(!['x','y','w','h'].every(k=>Number.isFinite(picture[k]))||Number(picture.x)<0||Number(picture.y)<0||Number(picture.w)<1||Number(picture.h)<1||Number(picture.x)+Number(picture.w)>100.001||Number(picture.y)+Number(picture.h)>100.001))throw new StudioError('Keep the resized picture inside the slide');
  patchSlideTextBox(shape,picture,old,width,height);
  patchPictureCrop(shape,picture,old);
  if(picture.text!==old.text)first(shape,P,'cNvPr').setAttribute('descr',String(picture.text));
 }
}
