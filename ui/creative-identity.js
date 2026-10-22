import {uid} from './creative-timeline-model.js';

const hexColor=v=>typeof v==='string'&&/^#[a-f0-9]{6}$/i.test(v);
/** Brand identity stored on the project: palette, title font size/color, logo text + corner, applied to all title/subtitle clips. */
export function validateIdentity(identity){
  if(!identity||typeof identity!=='object'||Array.isArray(identity))throw Error('حزمة الهوية غير صالحة.');
  if(!Object.keys(identity).every(key=>['name','primary','secondary','accent','titleColor','titleFont','logoText','logoCorner','logoColor'].includes(key)))throw Error('حقل هوية غير معروف.');
  for(const key of ['primary','secondary','accent','titleColor','logoColor'])if(identity[key]!==undefined&&!hexColor(identity[key]))throw Error('لون الهوية غير صالح.');
  if(identity.name!==undefined&&!(typeof identity.name==='string'&&identity.name.length<=100))throw Error('اسم الهوية غير صالح.');
  if(identity.titleFont!==undefined&&!(Number.isFinite(identity.titleFont)&&identity.titleFont>=12&&identity.titleFont<=200))throw Error('حجم خط الهوية خارج الحدود.');
  if(identity.logoText!==undefined&&!(typeof identity.logoText==='string'&&identity.logoText.length<=60))throw Error('نص الشعار طويل.');
  if(identity.logoCorner!==undefined&&!['tl','tr','bl','br'].includes(identity.logoCorner))throw Error('زاوية الشعار غير صالحة.');
}
export function defaultIdentity(){return {name:'هويتي',primary:'#20d4c0',secondary:'#1b2634',accent:'#e0a06a',titleColor:'#ffffff',titleFont:64,logoText:'',logoCorner:'tr',logoColor:'#20d4c0'};}
/** Apply identity to every title/subtitle clip (color+font) and note the brand fields used by the logo clip. */
export function applyIdentity(project){
  const identity=project.identity;if(!identity)return 0;
  let changed=0;
  for(const clip of project.clips){
    const track=project.tracks.find(t=>t.id===clip.trackId);
    if(clip.kind==='title'){
      if(identity.titleColor&&clip.color!==identity.titleColor){clip.color=identity.titleColor;changed++;}
      if(identity.titleFont&&clip.fontSize!==identity.titleFont){clip.fontSize=identity.titleFont;changed++;}
    }
    void track;
  }
  return changed;
}
/** Logo as an editable title clip placed in the given corner. */
export function logoClip(identity,track,time){
  const clip={id:uid(),trackId:track.id,assetId:null,name:'شعار · '+(identity.logoText||identity.name).slice(0,20),kind:'title',start:time,in:0,duration:3,speed:1,volume:1,opacity:1,scale:1,transition:'none',transitionDuration:0,text:identity.logoText||identity.name,color:identity.logoColor||identity.primary,fontSize:36,x:0,y:0};
  const corners={tl:{x:-.42,y:-.42},tr:{x:.42,y:-.42},bl:{x:-.42,y:.42},br:{x:.42,y:.42}};
  const corner=corners[identity.logoCorner||'tr'];
  clip.x=corner.x;clip.y=corner.y;
  return clip;
}

/** Full editable video templates: each returns title clips + suggested size; durations/timings editable afterwards. */
export const videoTemplates={
  intro:{
    label:'افتتاحية',size:[1920,1080],fps:30,
    build(track,time,identity){const c={...baseTitle(track,time),duration:2.4,text:'عنوان قصتك',fontSize:identity?.titleFont??84,transition:'fade',transitionDuration:.5};return [c];}
  },
  lower:{
    label:'عنوان تعريفي',size:[1920,1080],fps:30,
    build(track,time,identity){return [{...baseTitle(track,time),duration:3.5,text:'الاسم والعنوان الوظيفي',fontSize:46,y:.3,transition:'slide',transitionDuration:.4}];}
  },
  outro:{
    label:'بطاقة ختامية',size:[1920,1080],fps:30,
    build(track,time,identity){return [{...baseTitle(track,time),duration:2.8,text:'شكرًا للمشاهدة',fontSize:72,transition:'dissolve',transitionDuration:.6}];}
  },
  ad:{
    label:'إعلان سريع (عمودي)',size:[1080,1920],fps:30,
    build(track,time,identity){
      const hook={...baseTitle(track,time),duration:1.2,text:'عرض محدود',fontSize:96,transition:'wipe',transitionDuration:.3};
      const body={...baseTitle(track,time+1.3),duration:2,text:'اكتشف الميزة الآن',fontSize:56,y:.15};
      const cta={...baseTitle(track,time+3.4),duration:1.6,text:'اطلب اليوم',fontSize:72,y:.25,transition:'fade',transitionDuration:.3};
      return [hook,body,cta];
    }
  },
  lesson:{
    label:'درس (شاشة كاملة)',size:[1920,1080],fps:30,
    build(track,time,identity){
      return [
        {...baseTitle(track,time),duration:2,text:'عنوان الدرس',fontSize:64,transition:'fade',transitionDuration:.4},
        {...baseTitle(track,time+2.2),duration:3,text:'النقطة الأولى',fontSize:44,y:-.1},
        {...baseTitle(track,time+5.3),duration:3,text:'النقطة الثانية',fontSize:44,y:-.1},
      ];
    }
  },
};
function baseTitle(track,time){return {id:uid(),trackId:track.id,assetId:null,name:'عنوان',kind:'title',start:time,in:0,duration:3,speed:1,volume:1,opacity:1,scale:1,x:0,y:0,transition:'none',transitionDuration:.4,text:'نص',color:'#ffffff',fontSize:64};}
export function buildTemplate(kind,track,time,identity){const template=videoTemplates[kind];if(!template)throw Error('قالب غير معروف.');return template.build(track,time,identity);}

/** Platform size presets and safe margins (fraction of each side). */
export const platformSizes=[
  {id:'youtube',label:'يوتيوب · 16:9',width:1920,height:1080,safe:.05},
  {id:'shorts',label:'Shorts/Reels · 9:16',width:1080,height:1920,safe:.08},
  {id:'square',label:'مربع · 1:1',width:1080,height:1080,safe:.06},
  {id:'x',label:'منشور X · 16:9',width:1280,height:720,safe:.05},
  {id:'tiktok',label:'تيك توك · 9:16',width:1080,height:1920,safe:.12},
];
/** Convert project aspect: re-encode width/height and rescale title positions to keep relative framing. */
export function convertAspect(project,presetId){
  const preset=platformSizes.find(p=>p.id===presetId);
  if(!preset)throw Error('مقاس منصة غير معروف.');
  const oldW=project.width,oldH=project.height;
  project.width=preset.width;project.height=preset.height;
  const oldAspect=oldW/oldH,newAspect=preset.width/preset.height;
  for(const clip of project.clips){
    if(clip.kind!=='title')continue;
    // x is a fraction of width; when aspect narrows, pull toward center to stay in frame
    if(newAspect<oldAspect)clip.x*=newAspect/oldAspect;
    else clip.y*=oldAspect/newAspect;
    clip.x=Math.max(-1,Math.min(1,clip.x));
    clip.y=Math.max(-1,Math.min(1,clip.y));
  }
  return preset;
}
/** Safe-area guides overlay drawn on the preview canvas borders. */
export function drawSafeArea(ctx,width,height,fraction){
  const mx=width*fraction,my=height*fraction;
  ctx.save();
  ctx.strokeStyle='rgba(224,160,106,.7)';
  ctx.setLineDash([8,6]);
  ctx.lineWidth=2;
  ctx.strokeRect(mx,my,width-mx*2,height-my*2);
  ctx.restore();
}
