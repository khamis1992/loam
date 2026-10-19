/** Inline run-segment helpers shared by the preview iframe and Node operations.
 * Offsets are JavaScript string code units; boundary adjustments keep surrogate pairs intact. */
const signature = segment => JSON.stringify([segment.bold??null,segment.italic??null,segment.underline??null,segment.color??null,segment.highlight??null,segment.size??null,segment.font??null]);
const high = value => value>=0xD800&&value<=0xDBFF, low = value => value>=0xDC00&&value<=0xDFFF;
/** Keep common-prefix/suffix boundaries from splitting a surrogate pair. */
const pairSafe = (text,index,fromStart) => {
 if(fromStart)return high(text.charCodeAt(index-1))&&low(text.charCodeAt(index))?index-1:index;
 return low(text.charCodeAt(index))&&high(text.charCodeAt(index-1))?index+1:index;
};
const length = segments => segments.reduce((sum,segment)=>sum+segment.text.length,0);
export const sameFormat = (a,b)=>signature(a)===signature(b);
/** Drop empty segments and merge adjacent segments with identical formatting. */
export function mergeSegments(segments){
 const out=[];
 for(const segment of segments){
  if(!segment.text)continue;
  const last=out[out.length-1];
  if(last&&sameFormat(last,segment))last.text+=segment.text;else out.push({...segment});
 }
 return out;
}
/** Segments covering [start,end) in code units, splitting boundary segments when needed. */
export function cutSegments(segments,start,end){
 const out=[];let position=0;
 for(const segment of segments){
  const next=position+segment.text.length;
  if(next>start&&position<end)out.push({...segment,text:segment.text.slice(Math.max(start,position)-position,Math.min(end,next)-position)});
  position=next;
 }
 return out;
}
/** Index of the segment containing offset; prefer the left neighbour when offset sits exactly between two segments. */
export function segmentAt(segments,offset,preferLeft){
 let position=0;
 for(let index=0;index<segments.length;index++){
  const next=position+segments[index].text.length;
  if(offset<next)return index;
  if(offset===next&&index<segments.length-1&&preferLeft)return index;
  position=next;
 }
 return segments.length-1;
}
/** Re-flow segments onto edited text: the unchanged prefix and suffix keep their formatting and any replaced middle inherits the format at the edit boundary. */
export function reflowSegments(segments,newText){
 const oldText=segments.map(segment=>segment.text).join('');
 if(oldText===newText)return mergeSegments(segments);
 let prefix=0;while(prefix<oldText.length&&prefix<newText.length&&oldText[prefix]===newText[prefix])prefix++;
 let suffix=0;while(suffix<oldText.length-prefix&&suffix<newText.length-prefix&&oldText[oldText.length-1-suffix]===newText[newText.length-1-suffix])suffix++;
 prefix=pairSafe(oldText,prefix,true);suffix=pairSafe(oldText,oldText.length-suffix,false);suffix=oldText.length-suffix;
 const parts=cutSegments(segments,0,prefix),middle=newText.slice(prefix,newText.length-suffix);
 if(middle){
  const index=segmentAt(segments,prefix,middle.length>0);
  parts.push({...segments[index],text:middle});
 }
 parts.push(...cutSegments(segments,oldText.length-suffix,oldText.length));
 return mergeSegments(parts);
}
/** Apply explicit formatting properties over [start,end): null removes the property so the original run formatting shows through. */
export function formatRange(segments,start,end,properties){
 const inner=cutSegments(segments,start,end).map(segment=>{
  const next={...segment};
  for(const [key,value] of Object.entries(properties)){
   if(value===null)delete next[key];else next[key]=value;
  }
  return next;
 });
 return mergeSegments([...cutSegments(segments,0,start),...inner,...cutSegments(segments,end,length(segments))]);
}
/** Split segments at a caret offset for paragraph splitting. */
export function splitSegments(segments,offset){
 const left=mergeSegments(cutSegments(segments,0,offset)),right=mergeSegments(cutSegments(segments,offset,length(segments)));
 return [left.length?left:undefined,right.length?right:undefined];
}
/** A single segment without explicit formatting carries no information; represent that as no segments at all. */
export function normalizeSegments(segments){
 const merged=segments?mergeSegments(segments):[];
 if(!merged.length)return undefined;
 if(merged.length===1&&!Object.keys(merged[0]).some(key=>key!=='text'))return undefined;
 return merged;
}
