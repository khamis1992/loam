import {animatedValue} from './creative-keyframes.js';

/** Bézier ease segments live on the OUTGOING key: handles are [dt,dv] fractions of the gap (clamped 0..1 for dt, -1..2 for dv). */
export const easeLabels={linear:'خطي',smooth:'ناعم',hold:'ثبات',bezier:'منحنى Bézier'};
export function validateEaseHandles(key){
  if(key.ease!=='bezier'){if(key.handles!==undefined)throw Error('المقابض تصاحب نمط Bézier فقط.');return;}
  const handles=key.handles;
  if(!handles||typeof handles!=='object'||Array.isArray(handles)||!Object.keys(handles).every(k=>['in','out'].includes(k)))throw Error('مقابض المنحنى غير صالحة.');
  for(const side of ['in','out']){
    const handle=handles[side];
    if(!Array.isArray(handle)||handle.length!==2||!handle.every(v=>typeof v==='number'&&Number.isFinite(v)))throw Error('قيمة مقبض غير صالحة.');
    if(handle[0]<0||handle[0]>1)throw Error('زمن المقبض يجب أن يقع بين 0 و 1.');
    if(handle[1]<-1||handle[1]>2)throw Error('قيمة المقبض خارج الحدود.');
  }
  if(handles.in[0]===1&&handles.out[0]===0)throw Error('المنحنى غير رتيب؛ قرّب المقابض.');
}
/** Solve cubic-bezier(t; p1,p2) for progress→x then map x→y (CSS-style parametric ease). Deterministic Newton with bisection fallback. */
export function bezierProgress(fraction,{in:[x1,y1],out:[x2,y2]}){
  if(fraction<=0)return 0;if(fraction>=1)return 1;
  const coefficients=[3*x1*(1-y1*0)-0,0];// placeholder to keep shape obvious
  void coefficients;
  const cx=3*x1,bx=3*(x2-x1)-cx,ax=1-cx-bx;
  const cy=3*y1,by=3*(y2-y1)-cy,ay=1-cy-by;
  const sampleX=t=>((ax*t+bx)*t+cx)*t;
  const sampleY=t=>((ay*t+by)*t+cy)*t;
  const sampleDX=t=>(3*ax*t+2*bx)*t+cx;
  let t=fraction;
  for(let i=0;i<12;i++){const x=sampleX(t)-fraction;if(Math.abs(x)<1e-6)break;const derivative=sampleDX(t);if(Math.abs(derivative)<1e-7)break;t-=x/derivative;}
  if(t<0||t>1){let low=0,high=1;t=fraction;for(let i=0;i<40;i++){const x=sampleX(t);if(Math.abs(x-fraction)<1e-6)break;if(x<fraction)low=t;else high=t;t=(low+high)/2;}}
  return sampleY(t);
}
/** Interpolated animated value with bézier support; mirrors validateKeyframes' contract. */
export function easedValue(clip,field,timelineTime){const keys=clip.keyframes?.[field];if(!keys?.length)return clip[field];const time=timelineTime-clip.start+(clip.animationOffset||0);if(time<=keys[0].time)return keys[0].value;for(let i=1;i<keys.length;i++){const a=keys[i-1],b=keys[i];if(time<=b.time){if(time===b.time)return b.value;let weight=(time-a.time)/(b.time-a.time);if(a.ease==='hold')weight=0;else if(a.ease==='smooth')weight=weight*weight*(3-2*weight);else if(a.ease==='bezier')weight=bezierProgress(weight,a.handles??{in:[.35,0],out:[.65,1]});return a.value+(b.value-a.value)*weight;}}return keys.at(-1).value;}
export function setEaseHandles(key,ease,handles){
  key.ease=ease;
  if(ease==='bezier'){key.handles={in:handles?.in??[.35,0],out:handles?.out??[.65,1]};}
  else delete key.handles;
}

/** Effects catalog: canvas-filter chain entries plus pixel (chroma) and mask stages. */
export const effectCatalog={
  blur:{label:'تمويه',params:{radius:{label:'نصف القطر',min:0,max:24,step:.5,default:4}},filter:p=>`blur(${p.radius}px)`},
  brightness:{label:'سطوع',params:{amount:{label:'المقدار',min:0,max:3,step:.05,default:1.2}},filter:p=>`brightness(${p.amount})`},
  contrast:{label:'تباين',params:{amount:{label:'المقدار',min:0,max:3,step:.05,default:1.3}},filter:p=>`contrast(${p.amount})`},
  saturate:{label:'تشبع',params:{amount:{label:'المقدار',min:0,max:3,step:.05,default:1.5}},filter:p=>`saturate(${p.amount})`},
  grayscale:{label:'أبيض وأسود',params:{amount:{label:'المقدار',min:0,max:1,step:.05,default:1}},filter:p=>`grayscale(${p.amount})`},
  sepia:{label:'بُنّي قديم',params:{amount:{label:'المقدار',min:0,max:1,step:.05,default:1}},filter:p=>`sepia(${p.amount})`},
  'hue-rotate':{label:'تدوير اللون',params:{degrees:{label:'درجات',min:0,max:360,step:5,default:90}},filter:p=>`hue-rotate(${p.degrees}deg)`},
  chroma:{label:'إزالة الخلفية (Chroma)',params:{color:{label:'لون المفتاح',type:'color',default:'#00ff00'},similarity:{label:'التشابه',min:0,max:1,step:.02,default:.35},smoothness:{label:'نعومة الحافة',min:0,max:1,step:.05,default:.15}}},
  lut:{label:'LUT (جدول ألوان .cube)',params:{cube:{label:'بيانات الجدول',type:'lut',default:''},strength:{label:'القوة',min:0,max:1,step:.05,default:1}}},
  mask:{label:'قناع (مستطيل/بيضاوي)',params:{shape:{label:'الشكل',type:'select',options:[['rect','مستطيل'],['ellipse','بيضاوي']],default:'rect'},x:{label:'المركز الأفقي',min:-1,max:2,step:.02,default:.5},y:{label:'المركز الرأسي',min:-1,max:2,step:.02,default:.5},w:{label:'العرض',min:.02,max:2,step:.02,default:.6},h:{label:'الارتفاع',min:.02,max:2,step:.02,default:.6},feather:{label:'نعومة الحافة',min:0,max:100,step:2,default:12},invert:{label:'عكس القناع',type:'checkbox',default:false}}},
};
export function defaultParams(type){const params={};for(const [key,spec]of Object.entries(effectCatalog[type].params))params[key]=spec.default;return params;}
export function validateEffects(clip){
  if(clip.effects===undefined)return;
  if(!Array.isArray(clip.effects)||clip.effects.length>12)throw Error('مكدس المؤثرات غير صالح (حد 12).');
  for(const effect of clip.effects){
    if(!effect||typeof effect!=='object'||Array.isArray(effect))throw Error('مؤثر غير صالح.');
    const type=effect.type;
    if(!Object.hasOwn(effectCatalog,type))throw Error('نوع مؤثر غير معروف.');
    const allowed=['id','type','enabled','params'];const paramKeys=Object.keys(effectCatalog[type].params);if(!Object.keys(effect).every(key=>allowed.includes(key))||!effect.params||typeof effect.params!=='object'||Array.isArray(effect.params)||!Object.keys(effect.params).every(key=>paramKeys.includes(key)))throw Error('حقل مؤثر غير معروف.');
    if(!Object.keys(effect).every(key=>allowed.includes(key)))throw Error('حقل مؤثر غير معروف.');
    if(typeof effect.id!=='string'||!/^[a-z\d_-]+$/i.test(effect.id)||effect.id.length>100)throw Error('معرّف مؤثر غير صالح.');
    if(effect.enabled!==undefined&&typeof effect.enabled!=='boolean')throw Error('حالة تمكين غير صالحة.');
    for(const [key,spec]of Object.entries(effectCatalog[type].params)){
      const value=effect.params?.[key];
      if(spec.type==='color'){if(typeof value!=='string'||!/^#[a-f\d]{6}$/i.test(value))throw Error('لون مؤثر غير صالح.');}
      else if(spec.type==='select'){if(!spec.options.some(([option])=>option===value))throw Error('قيمة اختيار غير صالحة.');}
      else if(spec.type==='checkbox'){if(typeof value!=='boolean')throw Error('قيمة مفتاح غير صالحة.');}
      else if(spec.type==='lut'){if(typeof value!=='string'||value.length>400000)throw Error('جدول LUT غير صالح (حتى 400KB).');}else if(typeof value!=='number'||!Number.isFinite(value)||value<spec.min||value>spec.max)throw Error('معامل مؤثر خارج الحدود.');
    }
  }
  const ids=new Set(clip.effects.map(effect=>effect.id));if(ids.size!==clip.effects.length)throw Error('معرّفات مؤثرات مكررة.');
}
/** Filter string for the CSS-like chain; chroma/mask are handled separately in the engine. */
export function effectsFilter(clip){
  const parts=[];
  if(clip.effects)for(const effect of clip.effects){if(effect.enabled===false)continue;const entry=effectCatalog[effect.type];if(entry.filter)parts.push(entry.filter(effect.params));}
  return parts.length?parts.join(' '):null;
}
const lutCache=new Map();
/** Parse .cube text into {size,table:Float32Array} with r,g,b in 0..1; cache by source hash. */
export function parseCube(text){
  if(typeof text!=='string'||!text.trim())throw Error('ملف LUT فارغ.');
  const cached=lutCache.get(text);if(cached)return cached;
  const lines=text.split(/\r?\n/);const entries=[];let size=0;
  for(const line of lines){
    const trimmed=line.trim();
    if(!trimmed||trimmed.startsWith('#'))continue;
    const lower=trimmed.toLowerCase();
    const match=/^LUT_3D_SIZE\s+(\d+)/i.exec(trimmed);
    if(match){size=Number(match[1]);continue;}
    if(lower.startsWith('LUT_1D_SIZE')||lower.startsWith('DOMAIN_'))continue;
    const values=trimmed.split(/\s+/).map(Number);
    if(values.length===3&&values.every(v=>Number.isFinite(v)))entries.push(values);
  }
  if(!size||entries.length<size**3)throw Error('جدول LUT غير مكتمل ('+entries.length+'/'+(size*size*size)+').');
  const table=new Float32Array(size*size*size*3);
  entries.slice(0,size**3).forEach((values,index)=>{table[index*3]=values[0];table[index*3+1]=values[1];table[index*3+2]=values[2];});
  const parsed={size,table};lutCache.set(text,parsed);return parsed;
}
/** Trilinear LUT sample in 0..1 RGB space. */
export function sampleLut(lut,r,g,b){
  const size=lut.size,scale=(size-1);const x=Math.min(1,Math.max(0,r))*scale,y=Math.min(1,Math.max(0,g))*scale,z=Math.min(1,Math.max(0,b))*scale;
  const x0=Math.floor(x),y0=Math.floor(y),z0=Math.floor(z);const x1=Math.min(size-1,x0+1),y1=Math.min(size-1,y0+1),z1=Math.min(size-1,z0+1);
  const fx=x-x0,fy=y-y0,fz=z-z0;
  const at=(rx,ry,rz)=>{const index=((rz*size+ry)*size+rx)*3;return [lut.table[index],lut.table[index+1],lut.table[index+2]];};
  const c000=at(x0,y0,z0),c100=at(x1,y0,z0),c010=at(x0,y1,z0),c110=at(x1,y1,z0),c001=at(x0,y0,z1),c101=at(x1,y0,z1),c011=at(x0,y1,z1),c111=at(x1,y1,z1);
  const mix=(a,b,t)=>a+(b-a)*t;
  return [0,1,2].map(channel=>mix(mix(mix(c000[channel],c100[channel],fx),mix(c010[channel],c110[channel],fx),fy),mix(mix(c001[channel],c101[channel],fx),mix(c011[channel],c111[channel],fx),fy),fz));
}
/** Color-match: derive colorAdjust so the source clip approaches the target's measured channel means. */
export function matchColorAdjust(sourceStats,targetStats){
  const brightness=Math.min(2,Math.max(.1,(targetStats.luma+1e-6)/(sourceStats.luma+1e-6)));
  const channelGain=channel=>Math.min(1.8,Math.max(.4,(targetStats[channel]+.02)/(sourceStats[channel]+.02)));
  const gains=[channelGain('r'),channelGain('g'),channelGain('b')];
  const saturation=Math.min(2.5,Math.max(.4,((targetStats.spread+1e-6)/(sourceStats.spread+1e-6))*1));
  // approximate channel balance via hue rotation only when one channel clearly dominates
  let hue=0;
  const warmSource=sourceStats.r-sourceStats.b,warmTarget=targetStats.r-targetStats.b;
  if(Math.abs(warmTarget-warmSource)>.08)hue=Math.max(-30,Math.min(30,(warmTarget-warmSource)*80));
  return {brightness:Number(brightness.toFixed(3)),saturation:Number(saturation.toFixed(3)),hue:Number(hue.toFixed(1))};
}
export function findEffect(clip,id){return clip.effects?.find(effect=>effect.id===id);}
export function addEffect(clip,type){if(!Object.hasOwn(effectCatalog,type))throw Error('نوع مؤثر غير معروف.');clip.effects??=[];if(clip.effects.length>=12)throw Error('الحد الأقصى 12 مؤثرًا.');clip.effects.push({id:'fx'+Math.random().toString(36).slice(2,10),type,enabled:true,params:defaultParams(type)});return clip.effects.at(-1);}
export function moveEffect(clip,from,to){const effects=clip.effects;if(!effects||from<0||from>=effects.length||to<0||to>=effects.length||from===to)throw Error('ترتيب غير صالح.');const [item]=effects.splice(from,1);effects.splice(to,0,item);}
