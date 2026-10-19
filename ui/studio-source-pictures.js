const cropKeys=['cropLeft','cropTop','cropRight','cropBottom'];
export function sourcePictureTools(slide,esc){return (slide.sourcePictures||[]).map((picture,index)=>{
 const fields=items=>items.map(([key,label,min,max])=>`<label>${label}<input type="number" min="${min}" max="${max}" step="any" data-source-picture="${index}" data-picture-prop="${key}" value="${Number(Number(picture[key]).toFixed(4))}"></label>`).join('');
 const crop=cropKeys.every(k=>picture[k]!==undefined)?`<fieldset><legend>قص الصورة داخل الإطار</legend>${fields([['cropLeft','قص يسار %',-10000,10000],['cropTop','قص أعلى %',-10000,10000],['cropRight','قص يمين %',-10000,10000],['cropBottom','قص أسفل %',-10000,10000]])}</fieldset><p>الصفر يعرض الحافة كاملة. القيم الموجبة تقصّ الصورة، والسالبة توسّع المساحة حولها.</p>`:'<p>أعد استيراد الملف لإظهار أدوات القص الأصلية.</p>';
 return `<details class="office-object-inspector"><summary>الصورة الأصلية ${index+1} · الموضع والحجم والقص</summary><fieldset>${fields([['x','أفقي %',0,99],['y','رأسي %',0,99],['w','عرض %',1,100],['h','ارتفاع %',1,100]])}<label>وصف الصورة<input data-source-picture="${index}" data-picture-prop="text" maxlength="500" value="${esc(picture.text)}"></label></fieldset>${crop}<label>استبدال الصورة<input type="file" accept="image/png,image/jpeg" data-source-picture-file="${index}"></label><p>يحافظ الاستبدال على الإطار والقص والتدوير. تتجدد المعاينة بعد الحفظ.</p></details>`;
 }).join('');}
export function sourcePictureInput(field,slide){
 if(!field.matches('[data-source-picture]'))return false;const picture=slide.sourcePictures?.[Number(field.dataset.sourcePicture)],key=field.dataset.pictureProp;
 if(!picture||!['x','y','w','h','text',...cropKeys].includes(key))return false;
 if(key!=='text'&&!field.value.trim())throw Error('أدخل قيمة للصورة.');if(!field.checkValidity())throw Error('أدخل قيمة صالحة للصورة.');
 const value=key==='text'?field.value:Number(field.value),draft={...picture,[key]:value};
 if(cropKeys.includes(key)){if(!cropKeys.every(k=>Number.isFinite(draft[k]))||draft.cropLeft+draft.cropRight>=100||draft.cropTop+draft.cropBottom>=100)throw Error('اترك مساحة ظاهرة من الصورة؛ مجموع القص من جهتين متقابلتين يجب أن يكون أقل من 100%.');}
 else if(key!=='text'&&(!Number.isFinite(value)||draft.x+draft.w>100.001||draft.y+draft.h>100.001))throw Error('أبقِ الصورة داخل حدود الشريحة.');
 picture[key]=value;return true;
}

const geometry=p=>`left:${Number(p.x)}%;top:${Number(p.y)}%;width:${Number(p.w)}%;height:${Number(p.h)}%`;
export function sourcePictureTargets(slide){return (slide.sourcePictures||[]).map((p,i)=>`<div class="office-source-picture" data-source-picture-frame="${i}" style="${geometry(p)}"><button type="button" data-source-picture-drag="${i}" aria-label="تحريك الصورة الأصلية ${i+1}" title="اسحب أو استخدم الأسهم للتحريك، Escape للإلغاء">✥</button><button type="button" data-source-picture-resize="${i}" aria-label="تغيير حجم الصورة الأصلية ${i+1}" title="اسحب لتغيير الحجم مع حفظ النسبة، Escape للإلغاء">↘</button></div>`).join('');}
export function syncSourcePictures(root,slide){for(const [i,p]of (slide.sourcePictures||[]).entries()){const frame=root.querySelector(`[data-source-picture-frame="${i}"]`);if(frame)frame.style.cssText=geometry(p);for(const key of ['x','y','w','h',...cropKeys]){const input=root.querySelector(`[data-source-picture="${i}"][data-picture-prop="${key}"]`);if(input)input.value=Number(Number(p[key]).toFixed(4));}}}
export function bindSourcePictureGestures(root,current,commit){
 const bounded=(p,x,y)=>({x:Math.max(0,Math.min(100-p.w,x)),y:Math.max(0,Math.min(100-p.h,y))});
 root.addEventListener('keydown',e=>{const handle=e.target.closest('[data-source-picture-drag]'),delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(!handle||!delta||handle.dataset.dragging)return;const state=current(),p=state?.slide.sourcePictures?.[Number(handle.dataset.sourcePictureDrag)];if(!p||p.w<1||p.h<1||p.w>100||p.h>100)return;e.preventDefault();Object.assign(p,bounded(p,p.x+delta[0]*(e.shiftKey?5:.5),p.y+delta[1]*(e.shiftKey?5:.5)));syncSourcePictures(root,state.slide);commit();});
 root.addEventListener('pointerdown',e=>{
  const handle=e.target.closest('[data-source-picture-drag],[data-source-picture-resize]');if(!handle||e.button!==0)return;const resizing=handle.dataset.sourcePictureResize!==undefined,state=current(),index=Number(handle.dataset.sourcePictureResize??handle.dataset.sourcePictureDrag),p=state?.slide.sourcePictures?.[index];if(!p||p.w<1||p.h<1||p.w>100||p.h>100)return;
  e.preventDefault();handle.focus({preventScroll:true});const frame=handle.parentElement,canvas=frame.closest('.office-slide').getBoundingClientRect(),original={...p},start={x:e.clientX,y:e.clientY};let next={x:p.x,y:p.y,w:p.w,h:p.h};handle.dataset.dragging='true';frame.classList.add('dragging');handle.setPointerCapture(e.pointerId);
  const move=event=>{if(event.pointerId!==e.pointerId)return;if(resizing){const width=original.w*canvas.width/100,height=original.h*canvas.height/100,factor=1+((event.clientX-start.x)*width+(event.clientY-start.y)*height)/(width*width+height*height);const min=Math.max(1/original.w,1/original.h),max=Math.min((100-original.x)/original.w,(100-original.y)/original.h);if(max<min)return;const scale=Math.max(min,Math.min(max,factor));next={x:original.x,y:original.y,w:original.w*scale,h:original.h*scale};}else next={...original,...bounded(original,original.x+(event.clientX-start.x)/canvas.width*100,original.y+(event.clientY-start.y)/canvas.height*100)};frame.style.cssText=geometry({...original,...next});};
  const clean=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',up);handle.removeEventListener('pointercancel',cancel);handle.removeEventListener('lostpointercapture',cancel);document.removeEventListener('keydown',escape,true);delete handle.dataset.dragging;frame.classList.remove('dragging');if(handle.hasPointerCapture(e.pointerId))handle.releasePointerCapture(e.pointerId);};
  const cancel=()=>{clean();frame.style.cssText=geometry(original);};
  const escape=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancel();}};
  const up=event=>{if(event.pointerId!==e.pointerId)return;clean();const latest=current();if(latest?.owner!==state.owner||latest?.slide!==state.slide){frame.style.cssText=geometry(original);return;}if(next.x===original.x&&next.y===original.y&&next.w===original.w&&next.h===original.h)return;Object.assign(p,next);syncSourcePictures(root,state.slide);commit();};
  handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',up);handle.addEventListener('pointercancel',cancel);handle.addEventListener('lostpointercapture',cancel);document.addEventListener('keydown',escape,true);
 });
}



