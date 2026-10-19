import {newClip} from './creative-timeline-model.js';
const timestamp=value=>{const match=/^(?:(\d{2,3}):)?(\d{2}):(\d{2})[,.](\d{3})$/.exec(value.trim());if(!match||Number(match[2])>59||Number(match[3])>59)throw Error('توقيت ترجمة غير صالح.');return Number(match[1]||0)*3600+Number(match[2])*60+Number(match[3])+Number(match[4])/1000;};
/** Parse SRT or WebVTT caption text into editable title clips on a subtitles track. */
export function captionClips(text,track){
  const clean=text.replace(/^\uFEFF/,'').replace(/\r/g,'').trim();
  const isVtt=/^WEBVTT/.test(clean);
  const blocks=clean.split(/\n\s*\n/).slice(isVtt?1:0).filter(block=>block.trim()&&!/^NOTE\b/.test(block.trim()));
  if(blocks.length>300)throw Error('الحد الأقصى 300 مقطع ترجمة.');
  return blocks.map(block=>{const lines=block.split('\n');if(/^\d+$/.test(lines[0]))lines.shift();const match=/^((?:\d{2,3}:)?\d{2}:\d{2}[,.]\d{3})\s+-->\s+((?:\d{2,3}:)?\d{2}:\d{2}[,.]\d{3})/.exec(lines.shift()||'');if(!match)throw Error('كل مقطع في ملف SRT/VTT يحتاج بداية ونهاية.');const start=timestamp(match[1]),end=timestamp(match[2]),body=lines.join('\n').replace(/<[^>]*>/g,'');if(end<=start||end>3600||!body.trim()||body.length>2000)throw Error('محتوى الترجمة أو مدتها غير صالح.');return {...newClip(track,null,start),name:'ترجمة · '+body.slice(0,32),text:body,duration:end-start,fontSize:42,y:.36};});
}
const stamp=(seconds,decimal)=>{const total=Math.max(0,Math.round(seconds*1000)),hours=Math.floor(total/3600000),minutes=Math.floor(total/60000)%60,secs=Math.floor(total/1000)%60,ms=total%1000;return [hours,minutes,secs].map(n=>String(n).padStart(2,'0')).join(':')+decimal+String(ms).padStart(3,'0');};
/** Serialize subtitle clips to SRT or WebVTT text, sorted by start time. */
export function toSubtitles(clips,format){
  const rows=[...clips].sort((a,b)=>a.start-b.start);
  if(!rows.length)throw Error('لا مقاطع ترجمة للتصدير.');
  const cue=(clip,index)=>{const text=clip.text.trim()||' ';const decimal=format==='vtt'?'.':',';return (format==='vtt'?'':index+'\n')+stamp(clip.start,decimal)+' --> '+stamp(clip.start+clip.duration,decimal)+'\n'+text;};
  return (format==='vtt'?'WEBVTT\n\n':'')+rows.map(cue).join('\n\n')+'\n';
}
export function templateClip(kind,track,time){
  const c=newClip(track,null,time);c.transition='fade';c.transitionDuration=.4;
  if(kind==='lower'){c.name='عنوان تعريفي';c.text='الاسم والعنوان الوظيفي';c.y=.3;c.fontSize=46;}
  else if(kind==='outro'){c.name='بطاقة ختامية';c.text='شكرًا للمشاهدة';c.fontSize=72;}
  else{c.name='عنوان افتتاحي';c.text='عنوان قصتك';c.fontSize=84;}
  return c;
}
