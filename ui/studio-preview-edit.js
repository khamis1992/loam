import {reflowSegments,formatRange,splitSegments,normalizeSegments} from './inline-segments.js';
/** Apply only a known block operation; preserve all original source identity metadata. */
export function previewEdit(artifact,operation,revision){
 if(artifact.kind!=='document'||artifact.revision!==revision)throw Error('تغيّر المستند. ألغِ التعديل وحدّث المعاينة أولًا.');
 const {index,kind,block}=operation||{},blocks=artifact.content.blocks;
 if(kind==='split-insert'){
  const previous=blocks[index],offset=operation.offset,text=operation.sourceText??previous?.text;
  if(!Number.isSafeInteger(index)||!previous||!['paragraph','heading','bullet'].includes(previous.type)||typeof text!=='string'||text.length>20000||!Number.isSafeInteger(offset)||offset<0||offset>text.length||!block)throw Error('موضع المؤشر غير صالح');
  const sourceSegments=Array.isArray(operation.sourceSegments)&&operation.sourceSegments.every(s=>s&&typeof s.text==='string')?operation.sourceSegments:undefined;
  const segments=normalizeSegments(reflowSegments(sourceSegments??previous.segments??[{text:previous.text}],text));
  const next=structuredClone(artifact),left=next.content.blocks[index],right=structuredClone(left),inserted=structuredClone(block);
  left.text=text.slice(0,offset);right.text=text.slice(offset);delete right.sourceNode;delete right.sourceIndex;
  const [leftSegments,rightSegments]=segments?splitSegments(segments,offset):[];
  left.segments=normalizeSegments(leftSegments);if(!left.segments)delete left.segments;
  right.segments=normalizeSegments(rightSegments);if(!right.segments)delete right.segments;
  if(previous.sourceNode!==undefined||previous.continuationOf!==undefined)right.continuationOf=previous.sourceNode??previous.continuationOf;
  delete inserted.sourceNode;delete inserted.sourceIndex;delete inserted.continuationOf;delete inserted.segments;
  next.content.blocks.splice(index+1,0,inserted,right);return next;
 }
 if(kind==='move'){
  // Re-anchoring across pages: the block order decides where the element flows, position is page-relative.
  const previous=blocks[index],to=operation.to;
  if(!Number.isSafeInteger(index)||!previous||!['image','stats','table'].includes(previous.type)||!Number.isSafeInteger(to)||to<0||to>blocks.length||to===index||to===index+1)throw Error('لا يمكن نقل العنصر إلى هذا الموضع.');
  const position=operation.position??previous.position;
  if(!position)throw Error('حدّد موضعًا على الصفحة الجديدة.');
  const next=structuredClone(artifact),[moved]=next.content.blocks.splice(index,1);
  moved.position={x:Number(position.x),y:Number(position.y),...(position.width!==undefined?{width:Number(position.width)}:{})};
  next.content.blocks.splice(to>index?to-1:to,0,moved);
  return next;
 }
 if(!Number.isSafeInteger(index)||index<0||index>blocks.length||!block||!['replace','insert'].includes(kind))throw Error('تعديل غير صالح');
 const next=structuredClone(artifact),copy=structuredClone(block);
 if(kind==='replace'){
  const previous=blocks[index];if(!previous||previous.type!==copy.type)throw Error('العنصر المحدد غير متاح');
  for(const key of ['sourceNode','sourceIndex','continuationOf','style']){delete copy[key];if(previous[key]!==undefined)copy[key]=structuredClone(previous[key]);}
  if(previous.segments){
   // A whole-paragraph bold/italic toggle flattens the inline segments deliberately.
   for(const key of ['bold','italic'])if(copy[key]!==undefined&&copy[key]!==previous[key])copy.segments=formatRange(copy.segments??previous.segments,0,(copy.segments??previous.segments).reduce((sum,s)=>sum+s.text.length,0),{[key]:copy[key]});
   const base=Array.isArray(copy.segments)&&copy.segments.map(s=>s.text).join('')===copy.text?copy.segments:previous.segments;
   copy.segments=normalizeSegments(reflowSegments(base,copy.text));
   if(!copy.segments)delete copy.segments;
  }
  next.content.blocks[index]=copy;
 }else{delete copy.sourceNode;delete copy.sourceIndex;delete copy.style;delete copy.segments;next.content.blocks.splice(index,0,copy);}
 return next;
}
