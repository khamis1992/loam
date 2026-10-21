import {newClip} from './creative-timeline-model.js';
export function captionClips(text,track){
  const time=value=>{const match=/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value.trim());if(!match||Number(match[2])>59||Number(match[3])>59)throw Error('توقيت SRT غير صالح.');return Number(match[1])*3600+Number(match[2])*60+Number(match[3])+Number(match[4])/1000;};
  const blocks=text.replace(/^\uFEFF/,'').replace(/\r/g,'').trim().split(/\n\s*\n/);if(blocks.length>300)throw Error('الحد الأقصى 300 مقطع ترجمة.');
  return blocks.map(block=>{const lines=block.split('\n');if(/^\d+$/.test(lines[0]))lines.shift();const match=/^(.+?)\s+-->\s+(.+?)$/.exec(lines.shift()||'');if(!match)throw Error('ملف SRT يحتاج بداية ونهاية لكل مقطع.');const start=time(match[1]),end=time(match[2]),text=lines.join('\n').replace(/<[^>]*>/g,'');if(end<=start||end>3600||!text.trim()||text.length>2000)throw Error('محتوى الترجمة أو مدتها غير صالح.');return {...newClip(track,null,start),name:'ترجمة · '+text.slice(0,32),text,duration:end-start,fontSize:42,y:.36};});
}
export function templateClip(kind,track,time){
  const c=newClip(track,null,time);c.transition='fade';c.transitionDuration=.4;
  if(kind==='lower'){c.name='عنوان تعريفي';c.text='الاسم والعنوان الوظيفي';c.y=.3;c.fontSize=46;}
  else if(kind==='outro'){c.name='بطاقة ختامية';c.text='شكرًا للمشاهدة';c.fontSize=72;}
  else{c.name='عنوان افتتاحي';c.text='عنوان قصتك';c.fontSize=84;}
  return c;
}
