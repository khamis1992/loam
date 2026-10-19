export const frameTime=(time,fps)=>Math.max(0,Math.round(time*fps)/fps);
export function timecode(time,fps){const frames=Math.max(0,Math.round(time*fps));return [Math.floor(frames/(fps*3600)),Math.floor(frames/(fps*60))%60,Math.floor(frames/fps)%60,frames%fps].map(n=>String(n).padStart(2,'0')).join(':');}
export function parseTimecode(value,fps){const parts=/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());if(!parts||Number(parts[2])>59||Number(parts[3])>59||Number(parts[4])>=fps)throw Error('استخدم توقيت ساعات:دقائق:ثوانٍ:إطارات صحيحًا.');return Number(parts[1])*3600+Number(parts[2])*60+Number(parts[3])+Number(parts[4])/fps;}
function clipFor(project,id){const c=project.clips.find(c=>c.id===id);if(!c)throw Error('اختر مقطعًا أولًا.');return c;}
export function trimAtCursor(project,id,time,edge){const c=clipFor(project,id),point=frameTime(time,project.fps),minimum=1/project.fps,end=c.start+c.duration;if(point<c.start+minimum-1e-8||point>end-minimum+1e-8)throw Error('ضع المؤشر داخل المقطع مع إبقاء إطار واحد على الأقل.');c.transitionSourceDuration??=c.duration;if(edge==='start'){const removed=point-c.start;c.start=point;c.in+=removed*c.speed;c.duration=end-point;c.animationOffset=(c.animationOffset||0)+removed;c.transitionOffset=(c.transitionOffset||0)+removed;}else if(edge==='end')c.duration=point-c.start;else throw Error('حافة قص غير صالحة.');}
export function rippleDelete(project,id){const c=clipFor(project,id),end=c.start+c.duration,others=project.clips.filter(x=>x.id!==id&&x.trackId===c.trackId);if(others.some(x=>x.start<end-1e-8&&x.start+x.duration>c.start+1e-8))throw Error('المقطع متداخل مع مقطع آخر؛ استخدم الحذف العادي لحماية الانتقال.');for(const next of others)if(next.start>=end-1e-8)next.start=Math.max(0,next.start-c.duration);project.clips=project.clips.filter(x=>x.id!==id);}
export function snapClipStart(project,clip,start,cursor,pixelsPerSecond){let position=frameTime(start,project.fps);const tolerance=Math.min(.2,8/Math.max(1,pixelsPerSecond)),targets=[0,cursor,...project.clips.filter(c=>c.id!==clip.id).flatMap(c=>[c.start,c.start+c.duration])];let best=tolerance;for(const target of targets)for(const proposed of [target,target-clip.duration]){const distance=Math.abs(position-proposed);if(proposed>=0&&distance<best){position=proposed;best=distance;}}return frameTime(position,project.fps);}
const frame=project=>1/project.fps;
function sourceSpan(project,c){const asset=project.assets.find(a=>a.id===c.assetId);if(!asset||c.kind==='title'||asset.kind==='image')return null;return asset.duration;}
function neighbors(project,c){const others=project.clips.filter(x=>x.id!==c.id&&x.trackId===c.trackId).sort((a,b)=>a.start-b.start);const before=others.filter(x=>x.start+x.duration<=c.start+1e-8).at(-1),after=others.find(x=>x.start>=c.start+c.duration-1e-8);return {before,after,overlapping:others.some(x=>x.start<c.start+c.duration-1e-8&&x.start+x.duration>c.start+1e-8)};}
/** Ripple trim the tail at the playhead, then pull later clips on the track left to close the gap. */
export function rippleTrimEnd(project,id,point){const c=clipFor(project,id),minimum=frame(project),end=c.start+c.duration;point=frameTime(point,project.fps);if(point<c.start+minimum-1e-8||point>end-minimum+1e-8)throw Error('ضع المؤشر داخل المقطع مع إبقاء إطار واحد على الأقل.');const removed=end-point;c.duration=point-c.start;for(const next of project.clips)if(next.trackId===c.trackId&&next.start>=end-1e-8)next.start=Math.max(0,next.start-removed);}
/** Ripple trim the head at the playhead: the clip keeps its start, ends earlier, and later clips close the gap. */
export function rippleTrimStart(project,id,point){const c=clipFor(project,id),minimum=frame(project);point=frameTime(point,project.fps);if(point<c.start+minimum-1e-8||point>c.start+c.duration-minimum+1e-8)throw Error('ضع المؤشر داخل المقطع مع إبقاء إطار واحد على الأقل.');const removed=point-c.start;c.transitionSourceDuration??=c.duration;c.in+=removed*c.speed;c.duration-=removed;c.animationOffset=(c.animationOffset||0)+removed;c.transitionOffset=(c.transitionOffset||0)+removed;for(const next of project.clips)if(next.trackId===c.trackId&&next.id!==c.id&&next.start>=c.start+c.duration+removed-1e-8)next.start=Math.max(0,next.start-removed);}
/** Roll the cut between this clip and the next adjacent clip to the playhead; total track length is unchanged. */
export function rollTrim(project,id,point){const c=clipFor(project,id),minimum=frame(project);point=frameTime(point,project.fps);const {after,overlapping}=neighbors(project,c);if(overlapping)throw Error('Roll يحتاج مقاطع غير متداخلة.');if(!after)throw Error('لا يوجد مقطع تالٍ على المسار لتحريك القطع معه.');const delta=point-(c.start+c.duration);if(Math.abs(delta)<1e-9)return;if(c.duration+delta<minimum-1e-8||after.duration-delta<minimum-1e-8)throw Error('القطع الجديد يترك أقل من إطار في أحد المقطعين.');const span=sourceSpan(project,after);if(span!==null&&(after.in-delta*after.speed<0||after.in-delta*after.speed+after.duration*after.speed>span+.08))throw Error('بداية مصدر المقطع التالي لا تسمح بهذا التحريك.');c.transitionSourceDuration??=c.duration;after.transitionSourceDuration??=after.duration;c.duration+=delta;after.start=point;after.in=Math.max(0,after.in-delta*after.speed);}
/** Slip shifts the source in-point inside the clip without moving it on the timeline. */
export function slipClip(project,id,delta){const c=clipFor(project,id),span=sourceSpan(project,c);if(span===null)throw Error('Slip يعمل على مقاطع الفيديو والصوت.');if(!(typeof delta==='number'&&Number.isFinite(delta)))throw Error('قيمة Slip غير صالحة.');const next=c.in+delta*c.speed;if(next<0||next+c.duration*c.speed>span+.08)throw Error('حدود المصدر لا تسمح بهذا الانزلاق.');c.in=next;}
/** Slide moves the clip between its neighbors without touching its content or the neighbors' positions. */
export function slideClip(project,id,delta){const c=clipFor(project,id);if(!(typeof delta==='number'&&Number.isFinite(delta)))throw Error('قيمة Slide غير صالحة.');const {before,after,overlapping}=neighbors(project,c);if(overlapping)throw Error('Slide يحتاج مقاطع غير متداخلة.');const floor=before?before.start+before.duration:0,ceiling=after?after.start-c.duration:3600;const next=c.start+delta;if(next<floor-1e-8||next>ceiling+1e-8)throw Error('لا مساحة كافية بين الجارين لهذه الإزاحة.');c.start=frameTime(next,project.fps);}
import {uid} from './creative-timeline-model.js';
/** Presentation-only properties: pasting never moves clips or changes their sources. */
export function copyProperties(c){return structuredClone({volume:c.volume,opacity:c.opacity,scale:c.scale,x:c.x,y:c.y,transition:c.transition,transitionDuration:c.transitionDuration,...(c.colorAdjust?{colorAdjust:c.colorAdjust}:{}),...(c.kind==='title'?{fontSize:c.fontSize,color:c.color}:{})});}
export function pasteProperties(target,properties){for(const key of Object.keys(properties))target[key]=structuredClone(properties[key]);}
/** Detach a video clip's audio: the copy keeps the source kind (video) on an audio track and the pair moves as one group. */
export function detachAudio(project,id){
  const c=clipFor(project,id);
  if(c.kind!=='video')throw Error('فصل الصوت يعمل على مقاطع الفيديو.');
  if(project.clips.some(x=>x.group&&x.group===c.group&&x.id!==c.id&&x.trackId!==c.trackId&&x.kind==='video'))throw Error('لهذا المقطع صوت مفصول بالفعل.');
  let track=project.tracks.find(t=>t.kind==='audio'&&!t.locked);
  if(!track){track={id:uid(),name:'صوت مفصول',kind:'audio',muted:false,hidden:false};project.tracks.push(track);}
  const group=c.group||uid();
  const audio={...structuredClone(c),id:uid(),trackId:track.id,group,name:'صوت · '+c.name.slice(0,190)};
  c.group=group;c.volume=0;
  project.clips.push(audio);
  return audio;
}
export function groupClips(project,ids){
  if(ids.length<2)throw Error('التجميع يحتاج مقطعين على الأقل.');
  const clips=ids.map(x=>clipFor(project,x));
  for(const c of clips)if(project.tracks.find(t=>t.id===c.trackId)?.locked)throw Error('لا تجميع على مسار مقفل.');
  const group=uid();for(const c of clips)c.group=group;
}
export function ungroupClip(project,id){const c=clipFor(project,id);if(!c.group)throw Error('المقطع ليس ضمن مجموعة.');for(const x of project.clips)if(x.group===c.group)delete x.group;}
export function moveClipWithGroup(project,id,nextStart){
  const c=clipFor(project,id),delta=nextStart-c.start;
  const members=c.group?project.clips.filter(x=>x.group===c.group):[c];
  for(const m of members)m.start=Math.max(0,frameTime(m.start+delta,project.fps));
}
export function addMarker(project,time,label){if(project.markers&&project.markers.length>=100)throw Error('الحد الأقصى 100 علامة.');project.markers??=[];project.markers.push({id:uid(),time:frameTime(time,project.fps),label:String(label||'').slice(0,200)});}
export function removeMarker(project,id){if(!project.markers)return;project.markers=project.markers.filter(m=>m.id!==id);}
/** Preview in/out range: playback and seeking clamp to it; export keeps the full timeline. */
export function setRange(project,inPoint,outPoint){
  const start=frameTime(inPoint,project.fps),end=outPoint==null?null:frameTime(outPoint,project.fps);
  if(end!=null&&end<=start+1e-9)throw Error('نقطة الخروج يجب أن تسبق نقطة الدخول وأن تفصل بينهما قيمة موجبة.');
  if(end==null)delete project.range;else project.range={in:start,out:end};
}
