import {validateEffects} from './creative-fx.js';
import {validateIdentity} from './creative-identity.js';
import {validateColor} from './creative-color.js';
import {validateKeyframes} from './creative-keyframes.js';
export const uid=()=>crypto.randomUUID();
export function newTimeline(){return {format:'loam-timeline',version:1,title:'مونتاج جديد',width:1280,height:720,fps:30,background:'#101820',tracks:[{id:uid(),name:'الصورة الأساسية',kind:'visual',muted:false,hidden:false},{id:uid(),name:'طبقة مرئية',kind:'visual',muted:false,hidden:false},{id:uid(),name:'الموسيقى والصوت',kind:'audio',muted:false,hidden:false}],assets:[],clips:[]};}
export const timelineDuration=p=>Math.max(1/p.fps,...p.clips.map(c=>c.start+c.duration));
export function newClip(track,asset,start,range){return {id:uid(),trackId:track.id,assetId:asset?.id||null,name:asset?.name||'عنوان',kind:asset?.kind||'title',start,in:range?Math.max(0,range.in):0,duration:asset&&asset.kind!=='image'?(range?Math.max(1/60,range.duration):asset.duration):3,speed:1,volume:1,opacity:1,scale:1,x:0,y:0,transition:'none',transitionDuration:.5,text:asset?'':'اكتب عنوانك',color:'#ffffff',fontSize:64};}
const plainText=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.trim().length<=max&&!/[\u0000-\u001f]/.test(v);
const metaKeys=['width','height','duration','container','videoCodec','audioCodec','sampleRate','hasAudio','transparent'];
const proxyPattern=/^assets\/timeline\/[a-f\d-]+\.mp4$/;
/** Validate optional asset organization and probe fields; unknown keys are rejected like keyframe properties. */
export function validateAssetFields(a){
  if(a.folder!==undefined&&!plainText(a.folder,60))throw Error('اسم مجلد الأصل غير صالح.');
  if(a.tags!==undefined){if(!Array.isArray(a.tags)||a.tags.length>8||new Set(a.tags).size!==a.tags.length)throw Error('وسوم الأصل غير صالحة.');for(const tag of a.tags)if(!plainText(tag,40))throw Error('وسم الأصل غير صالح.');}
  if(a.meta!==undefined){const m=a.meta;if(!m||typeof m!=='object'||Array.isArray(m))throw Error('بيانات فحص الأصل غير صالحة.');if(!Object.keys(m).every(key=>metaKeys.includes(key)))throw Error('حقل بيانات فحص غير معروف.');for(const [key,value] of Object.entries(m)){if(value===undefined)continue;if(['width','height','sampleRate'].includes(key)&&!(typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=76800))throw Error('قيمة بيانات فحص خارج الحدود.');if(['container','videoCodec','audioCodec'].includes(key)&&!(typeof value==='string'&&value.length>0&&value.length<=40))throw Error('قيمة بيانات فحص غير صالحة.');if(key==='hasAudio'&&typeof value!=='boolean')throw Error('قيمة بيانات فحص غير صالحة.');if(key==='transparent'&&typeof value!=='boolean')throw Error('قيمة بيانات فحص غير صالحة.');if(key==='duration'&&!(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=86400))throw Error('قيمة بيانات فحص خارج الحدود.');}}
  if(a.proxy!==undefined){const x=a.proxy;if(!x||typeof x!=='object'||Array.isArray(x)||!Object.keys(x).every(key=>['path','bytes','width'].includes(key)))throw Error('بيانات proxy غير صالحة.');if(typeof x.path!=='string'||!proxyPattern.test(x.path))throw Error('مسار proxy غير صالح.');if(!(typeof x.bytes==='number'&&Number.isFinite(x.bytes)&&x.bytes>0)||!(typeof x.width==='number'&&Number.isFinite(x.width)&&x.width>=16&&x.width<=7680))throw Error('قيم proxy خارج الحدود.');}
  if(a.source!==undefined){const s=a.source;if(!s||typeof s!=='object'||Array.isArray(s)||!Object.keys(s).every(key=>['url','author','license','notes'].includes(key)))throw Error('بيانات مصدر الأصل غير صالحة.');if(s.url!==undefined&&!(typeof s.url==='string'&&/^https?:\/\/.{3,497}$/.test(s.url)))throw Error('رابط المصدر غير صالح.');for(const key of ['author','license'])if(s[key]!==undefined&&!(typeof s[key]==='string'&&s[key].trim().length>0&&s[key].length<=100))throw Error('قيمة '+key+' للمصدر غير صالحة.');if(s.notes!==undefined&&!(typeof s.notes==='string'&&s.notes.length<=300))throw Error('ملاحظات المصدر أطول من 300 حرف.');}
}
const hexColor=v=>typeof v==='string'&&/^#[a-f0-9]{6}$/i.test(v);
/** Track organization/mixing fields (lock, target, mixer, EQ, compressor, subtitle style, roles) are strictly validated. */
export function validateTrackFields(t){
  if(t.role!==undefined&&((t.role==='subtitles'&&t.kind!=='visual')||(t.role==='voice'&&t.kind!=='audio')))throw Error('دور المسار غير صالح.');
  for(const key of ['locked','targeted','solo'])if(t[key]!==undefined&&typeof t[key]!=='boolean')throw Error('قيمة مسار غير صالحة.');
  if(t.blend!==undefined&&!['normal','multiply','screen','overlay','darken','lighten','difference'].includes(t.blend))throw Error('وضع مزج غير مدعوم.');
  if(t.adjust!==undefined){if(typeof t.adjust!=='boolean'||t.kind!=='visual')throw Error('طبقة التعديل لمسار مرئي فقط.');validateColor({kind:'image',colorAdjust:t.colorAdjust});}
  else if(t.colorAdjust!==undefined)throw Error('تصحيح المسار يلزمه تفعيل طبقة التعديل.');
  if(t.volume!==undefined&&!(typeof t.volume==='number'&&Number.isFinite(t.volume)&&t.volume>=0&&t.volume<=2))throw Error('حجم المسار خارج الحدود.');
  if(t.pan!==undefined&&!(typeof t.pan==='number'&&Number.isFinite(t.pan)&&t.pan>=-1&&t.pan<=1))throw Error('بان المسار خارج الحدود.');
  if(t.eq!==undefined){const eq=t.eq;if(!eq||typeof eq!=='object'||Array.isArray(eq)||!Object.keys(eq).every(k=>['low','mid','high'].includes(k)))throw Error('إعدادات EQ غير صالحة.');for(const band of ['low','mid','high'])if(eq[band]!==undefined&&!(typeof eq[band]==='number'&&Number.isFinite(eq[band])&&eq[band]>=-12&&eq[band]<=12))throw Error('قيمة EQ خارج الحدود (±12dB).');}
  if(t.compressor!==undefined){const c=t.compressor;if(!c||typeof c!=='object'||Array.isArray(c)||!Object.keys(c).every(k=>['enabled','threshold','ratio'].includes(k)))throw Error('إعدادات الضاغط غير صالحة.');if(c.enabled!==undefined&&typeof c.enabled!=='boolean')throw Error('حالة الضاغط غير صالحة.');if(c.threshold!==undefined&&!(typeof c.threshold==='number'&&Number.isFinite(c.threshold)&&c.threshold>=-60&&c.threshold<=0))throw Error('عتبة الضاغط خارج الحدود.');if(c.ratio!==undefined&&!(typeof c.ratio==='number'&&Number.isFinite(c.ratio)&&c.ratio>=1&&c.ratio<=20))throw Error('نسبة الضاغط خارج الحدود.');}
  if(t.subsStyle!==undefined){const st=t.subsStyle;if(!st||typeof st!=='object'||Array.isArray(st)||!Object.keys(st).every(k=>['bg','bgOpacity','outline','outlineWidth','safe'].includes(k)))throw Error('نمط الترجمة غير صالح.');if(st.bg!==undefined&&!hexColor(st.bg))throw Error('لون خلفية الترجمة غير صالح.');if(st.outline!==undefined&&!hexColor(st.outline))throw Error('لون حدود الترجمة غير صالح.');if(st.bgOpacity!==undefined&&!(typeof st.bgOpacity==='number'&&Number.isFinite(st.bgOpacity)&&st.bgOpacity>=0&&st.bgOpacity<=1))throw Error('شفافية خلفية الترجمة خارج الحدود.');if(st.outlineWidth!==undefined&&!(typeof st.outlineWidth==='number'&&Number.isFinite(st.outlineWidth)&&st.outlineWidth>=0&&st.outlineWidth<=8))throw Error('سماكة حدود الترجمة خارج الحدود.');if(st.safe!==undefined&&!(typeof st.safe==='number'&&Number.isFinite(st.safe)&&st.safe>=0&&st.safe<=0.25))throw Error('هامش المنطقة الآمنة خارج الحدود.');}
}

export function validateTimeline(input){
  const fail=()=>{throw Error('ملف مونتاج غير صالح أو يحتوي إعدادات خارج الحدود.');};
  const number=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
  const text=(v,max)=>typeof v==='string'&&v.length<=max;
  const id=v=>text(v,100)&&/^[a-z\d_-]+$/i.test(v);
  if(!input||input.format!=='loam-timeline'||input.version!==1||!text(input.title,200)||![720,1080,1280,1920].includes(input.width)||![720,1080,1280,1920].includes(input.height)||![24,30,60].includes(input.fps)||!/^#[a-f\d]{6}$/i.test(input.background)||!Array.isArray(input.assets)||!Array.isArray(input.tracks)||!Array.isArray(input.clips)||input.assets.length>100||input.tracks.length<1||input.tracks.length>20||input.clips.length>300||input.markers!==undefined&&(!Array.isArray(input.markers)||input.markers.length>100)||input.identity!==undefined&&(typeof input.identity!=='object'||Array.isArray(input.identity))||input.platform!==undefined&&!(typeof input.platform==='string'&&['youtube','shorts','square','x','tiktok'].includes(input.platform))||input.duck!==undefined&&(!input.duck||typeof input.duck!=='object'||Array.isArray(input.duck)||!Object.keys(input.duck).every(k=>['enabled','amount'].includes(k))||input.duck.enabled!==undefined&&typeof input.duck.enabled!=='boolean'||input.duck.amount!==undefined&&!(typeof input.duck.amount==='number'&&Number.isFinite(input.duck.amount)&&input.duck.amount>=0&&input.duck.amount<=1))||input.range!==undefined&&(!input.range||typeof input.range!=='object'||Array.isArray(input.range)||!number(input.range.in,0,3600)||!number(input.range.out,0,3600)||input.range.out<=input.range.in))fail();
  const p=structuredClone(input),ids=new Set();
  for(const a of p.assets){const embedded=typeof a.data==='string'&&/^data:(image\/(png|jpeg|webp)|video\/(mp4|webm)|audio\/(mpeg|mp3|wav|x-wav|ogg|webm|mp4));base64,[a-z\d+/=]+$/i.test(a.data),stored=typeof a.path==='string'&&/^assets\/timeline\/[a-f\d-]+\.(png|jpg|webp|mp4|webm|mp3|wav|ogg|m4a)$/.test(a.path)&&typeof p.taskId==='string'&&/^task_[a-z\d_-]+$/i.test(p.taskId);if(!id(a.id)||ids.has(a.id)||!text(a.name,200)||!['video','image','audio'].includes(a.kind)||!number(a.duration,0,86400)||(!embedded&&!stored))fail();validateAssetFields(a);ids.add(a.id);}
  const tracks=new Set();for(const t of p.tracks){if(!id(t.id)||tracks.has(t.id)||!text(t.name,100)||!['visual','audio'].includes(t.kind)||typeof t.muted!=='boolean'||typeof t.hidden!=='boolean')fail();validateTrackFields(t);tracks.add(t.id);}
  if(p.markers)for(const m of p.markers){if(!id(m.id)||!number(m.time,0,3600)||typeof m.label!=='string'||m.label.length>200)fail();}
  const clips=new Set();for(const c of p.clips){const asset=p.assets.find(a=>a.id===c.assetId),track=p.tracks.find(t=>t.id===c.trackId);if(!id(c.id)||clips.has(c.id)||!track||!text(c.name,200)||!['video','image','audio','title'].includes(c.kind)||c.kind!=='title'&&(!asset||asset.kind!==c.kind)||track.kind==='audio'&&!['audio','video'].includes(c.kind)||!number(c.start,0,3600)||!number(c.in,0,86400)||!number(c.duration,1/60-1e-9,3600)||!number(c.speed,.25,4)||!number(c.volume,0,2)||!number(c.opacity,0,1)||!number(c.scale,.1,4)||!number(c.x,-2,2)||!number(c.y,-2,2)||!['none','dissolve','fade','slide','wipe'].includes(c.transition)||!number(c.transitionDuration,0,5)||c.transitionDirection!==undefined&&!['left','right'].includes(c.transitionDirection)||c.transitionCurve!==undefined&&!['linear','smooth'].includes(c.transitionCurve)||!text(c.text,2000)||!/^#[a-f\d]{6}$/i.test(c.color)||!number(c.fontSize,12,200))fail();if(asset&&['audio','video'].includes(asset.kind)&&c.in+c.duration*c.speed>asset.duration+.08)fail();if(c.group!==undefined&&!(id(c.group)))fail();if(c.transitionOffset!==undefined&&!number(c.transitionOffset,0,3600)||c.transitionSourceDuration!==undefined&&!number(c.transitionSourceDuration,1/60-1e-9,3600))fail();validateKeyframes(c);validateColor(c);validateEffects(c);clips.add(c.id);}
  if(p.identity!==undefined)validateIdentity(p.identity);
  if(timelineDuration(p)>3600)fail();return p;
}
export function transitionAt(c,time){const elapsed=time-c.start+(c.transitionOffset||0),total=c.transitionSourceDuration??c.duration,span=Math.min(c.transitionDuration,total/2);let incoming=span?Math.min(1,Math.max(0,elapsed/span)):1,outgoing=span?Math.min(1,Math.max(0,(total-elapsed)/span)):1;
  if(c.transitionCurve==='smooth'){const shape=x=>x*x*(3-2*x);incoming=shape(incoming);outgoing=shape(outgoing);}
  const direction=c.transitionDirection==='left'?-1:1;
  return {opacity:c.opacity*(c.transition==='fade'?Math.min(incoming,outgoing):c.transition==='dissolve'?incoming:1),offset:c.transition==='slide'?(1-incoming)*direction:0,wipe:c.transition==='wipe'?incoming:0,wipeDirection:direction,audio:Math.min(incoming,outgoing)};}
/** Point an existing asset at a replacement stored file and clamp its clips to the new source duration, keeping timing edits where possible. */
export function relinkAsset(p,assetId,{path,bytes,duration,name}){
  const asset=p.assets.find(a=>a.id===assetId);
  if(!asset)throw Error('أصل غير موجود في المشروع.');
  if(typeof path!=='string'||!path)throw Error('مسار الملف البديل غير صالح.');
  const replacement=asset.kind==='image'?0:Number(duration);
  if(asset.kind!=='image'&&!(replacement>1/60))throw Error('مدة الملف البديل غير صالحة أو قصيرة جدًا.');
  asset.path=path;asset.bytes=bytes;if(name)asset.name=String(name).slice(0,200);asset.duration=replacement;
  for(const c of p.clips)if(c.assetId===assetId&&asset.kind!=='image'){
    if(c.in>replacement)c.in=Math.max(0,replacement-c.duration*c.speed);
    if(c.in+c.duration*c.speed>replacement+.08){
      const room=Math.max(0,(replacement-c.in)/c.speed);
      if(room>=1/60)c.duration=room;
      else{c.in=0;c.duration=Math.max(1/60,replacement/c.speed);if(c.duration*c.speed>replacement+.08)throw Error('الملف البديل قصير جدًا على مقاطع هذا الأصل.');}
    }
  }
  return asset;
}
/** Remove assets from the project only when no clip references them; source files stay in the task. */
export function removeAssets(p,ids){
  const doomed=new Set(ids);
  for(const c of p.clips)if(c.assetId&&doomed.has(c.assetId))throw Error('لا يمكن حذف أصل مستخدم في مقاطع؛ احذف مقاطعه أولًا.');
  const before=p.assets.length;
  p.assets=p.assets.filter(a=>!doomed.has(a.id));
  return before-p.assets.length;
}
