import {effectCatalog,addEffect,moveEffect,findEffect,easeLabels} from './creative-fx.js';
import {animatedValue as _animatedValue} from './creative-keyframes.js';
void _animatedValue;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/** Inspector section: searchable effects stack with enable/remove/reorder/params, and the Bézier ease editor for keys. */
export function effectsPanel(clip){
  if(!['image','video'].includes(clip.kind))return '';
  const effects=clip.effects||[];
  return `<section data-fx-panel><h3>المؤثرات</h3>
    <label>بحث وإضافة مؤثر<input type="search" data-fx-search placeholder="ابحث…"></label>
    <div data-fx-catalog class="tl-fx-catalog">${Object.entries(effectCatalog).filter(([type])=>!effects.some(effect=>effect.type===type)).map(([type,entry])=>`<button data-fx-add="${type}">${esc(entry.label)}</button>`).join('')||'<span class="creative-help">كل المؤثرات مضافة.</span>'}</div>
    <div data-fx-list>${effects.map((effect,index)=>{const entry=effectCatalog[effect.type];return `<div class="tl-fx-row" data-fx-row="${effect.id}"><label><input type="checkbox" data-fx-enabled="${effect.id}" ${effect.enabled!==false?'checked':''}>${esc(entry.label)}</label>${Object.entries(entry.params).map(([key,spec])=>{
      if(spec.type==='lut')return `<label>${spec.label}<button data-fx-lut-load="${effect.id}">استيراد ملف .cube</button> <span data-fx-lut-name>${effect.params.cube?'جدول محمّل ('+effect.params.cube.length+' حرفًا)':'لا جدول بعد'}</span></label>`;
      if(spec.type==='color')return `<label>${spec.label}<input type="color" data-fx-param="${effect.id}.${key}" value="${effect.params[key]}"></label>`;
      if(spec.type==='select')return `<label>${spec.label}<select data-fx-param="${effect.id}.${key}">${spec.options.map(([value,label])=>`<option value="${value}" ${effect.params[key]===value?'selected':''}>${label}</option>`).join('')}</select></label>`;
      if(spec.type==='checkbox')return `<label>${spec.label}<input type="checkbox" data-fx-check="${effect.id}.${key}" ${effect.params[key]?'checked':''}></label>`;
      return `<label>${spec.label}<input type="range" data-fx-param="${effect.id}.${key}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${effect.params[key]}"><output>${Number(effect.params[key]).toFixed(2)}</output></label>`;
    }).join('')}<div class="tl-fx-actions"><button data-fx-up="${effect.id}" ${index===0?'disabled':''}>↑</button><button data-fx-down="${effect.id}" ${index===effects.length-1?'disabled':''}>↓</button><button data-fx-remove="${effect.id}">حذف</button></div></div>`;}).join('')||'<p class="creative-help">لا مؤثرات بعد؛ أضف من الكتالوج أعلاه.</p>'}</div></section>`;
}
/** Bézier ease editor for one key: handle sliders + a small live curve preview. */
export function easeEditor(clip,field,index){
  const keys=clip.keyframes?.[field];if(!keys)return '';
  const key=keys[index];if(!key)return '';
  const handles=key.handles??{in:[.35,0],out:[.65,1]};
  const samples=[];for(let i=0;i<=20;i++)samples.push(i/20);
  return `<div class="tl-ease-editor" data-ease-editor="${field}.${index}"><h4>منحنى الانتقال من هذا المفتاح</h4>
    <label>النمط<select data-ease-mode>${Object.entries(easeLabels).map(([value,label])=>`<option value="${value}" ${key.ease===value?'selected':''}>${label}</option>`).join('')}</select></label>
    <div data-ease-bezier ${key.ease==='bezier'?'':'hidden'}>
      <label>مقبض الدخول (زمن)<input type="range" data-ease-handle="in.0" min="0" max="1" step="0.05" value="${handles.in[0]}"><output>${handles.in[0]}</output></label>
      <label>مقبض الدخول (قيمة)<input type="range" data-ease-handle="in.1" min="-1" max="2" step="0.05" value="${handles.in[1]}"><output>${handles.in[1]}</output></label>
      <label>مقبض الخروج (زمن)<input type="range" data-ease-handle="out.0" min="0" max="1" step="0.05" value="${handles.out[0]}"><output>${handles.out[0]}</output></label>
      <label>مقبض الخروج (قيمة)<input type="range" data-ease-handle="out.1" min="-1" max="2" step="0.05" value="${handles.out[1]}"><output>${handles.out[1]}</output></label>
      <canvas width="120" height="80" data-ease-curve></canvas>
    </div></div>`;
}
export function drawEaseCurve(canvas,handles){
  const ctx=canvas.getContext('2d');ctx.clearRect(0,0,120,80);
  ctx.strokeStyle='#3c526b';ctx.strokeRect(.5,.5,119,79);
  const curve=[];for(let i=0;i<=40;i++){const t=i/40;const x=t;const y=bezierY(t,handles);curve.push([x,y]);}
  ctx.strokeStyle='#58e6d3';ctx.beginPath();
  curve.forEach(([x,y],i)=>{const px=10+x*100,py=70-y*60;i?ctx.lineTo(px,py):ctx.moveTo(px,py);});
  ctx.stroke();
  ctx.fillStyle='#e0a06a';
  ctx.fillRect(10+handles.in[0]*100-2,70-handles.in[1]*60-2,4,4);
  ctx.fillRect(10+handles.out[0]*100-2,70-handles.out[1]*60-2,4,4);
}
function bezierY(t,{in:[x1,y1],out:[x2,y2]}){
  const cx=3*x1,bx=3*(x2-x1)-cx,ax=1-cx-bx;
  const cy=3*y1,by=3*(y2-y1)-cy,ay=1-cy-by;
  return ((ay*t+by)*t+cy)*t;
}
export {addEffect,moveEffect,findEffect};
