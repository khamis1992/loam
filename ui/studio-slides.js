const box=(text,x,y,w,h,fontSize,color,bold=false,background)=>({id:crypto.randomUUID(),text,x,y,w,h,fontSize,color,bold,fontFamily:'Segoe UI',alignment:/[\u0590-\u08ff]/.test(text)?'right':'left',...(background?{background}:{})});
export function slideLayout(s,layout){
 const ink='#172D2A',muted='#46655E';s.background='#F5F8F5';s.accent='#187665';
 const parts=s.body.split('\n').filter(t=>t.trim());
 const heading=box(s.title,6,7,88,16,32,ink,true);
 if(layout==='cover')s.textBoxes=[box(s.title,7,24,86,30,42,ink,true),box(s.body,7,61,86,27,20,muted)];
 else if(layout==='table')s.textBoxes=[heading,box(s.body,6,24,88,9,16,muted)];
 else if(layout==='image')s.textBoxes=[heading,box(s.body,6,30,42,58,22,ink)];
 else if(layout==='cards')s.textBoxes=[heading,...[0,1,2].map(i=>({...box(parts[i]||'عنوان\nوصف البطاقة',6+i*30,35,28,38,26,ink,true,'#E2EEE8'),alignment:'center'})),...(parts.length>3?[box(parts.slice(3).join('\n'),6,89,88,8,12,muted)]:[])];
 else if(layout==='comparison'){
  const left=parts.slice(0,Math.ceil(parts.length/2)).join('\n');
  const right=parts.slice(Math.ceil(parts.length/2)).join('\n');
  s.textBoxes=[heading,box(left,4,24,44,60,20,ink,false,'#FFFFFF'),box(right,52,24,44,60,20,ink,false,'#FFFFFF')];
 }
 else if(layout==='timeline'){
  const items=parts.slice(0,5);
  s.textBoxes=[heading,...items.map((item,i)=>({...box(item,8+i*18,28,16,40,16,ink,false,'#FFFFFF'),alignment:'center'}))];
 }
 else if(layout==='stats'){
  const items=parts.slice(0,4);
  s.textBoxes=[heading,...items.map((item,i)=>({...box(item,6+i*23,30,21,45,28,ink,true,'#E2EEE8'),alignment:'center'}))];
 }
 else if(layout==='quote'){
  s.textBoxes=[heading,box(parts[0]||s.body,8,26,84,40,24,ink,false,'#FFFFFF'),box(parts[1]||'',8,70,84,12,16,muted,true)];
 }
 else s.textBoxes=[heading,box(parts.slice(0,Math.ceil(parts.length/2)).join('\n'),6,30,42,58,22,ink),box(parts.slice(Math.ceil(parts.length/2)).join('\n'),52,30,42,58,22,ink)];
}
export function slideObjectTools(s,imported,esc){return `${imported?'':`<div class="office-slide-tools"><button data-action="layout-cover">غلاف</button><button data-action="layout-columns">عمودان</button><button data-action="layout-cards">بطاقات</button><button data-action="layout-image">نص وصورة</button><button data-action="layout-table">عنوان وجدول</button><button data-action="layout-comparison">مقارنة</button><button data-action="layout-timeline">خط زمني</button><button data-action="layout-stats">إحصائيات</button><button data-action="layout-quote">اقتباس</button><button data-action="text-object">إضافة مربع نص</button><button data-action="slide-image">إدراج صورة</button><button data-action="slide-table">إدراج جدول</button><button data-action="slide-chart">إدراج مخطط</button><input hidden type="file" accept="image/png,image/jpeg" data-slide-image-file></div>`}${s.textBoxes?.length?`<details class="office-object-inspector"><summary>مواضع العناصر وتنسيقها</summary>${s.textBoxes.map((b,i)=>`<fieldset><legend>العنصر ${i+1}</legend>${[['x','أفقي %',0,99],['y','رأسي %',0,99],['w','عرض %',1,100],['h','ارتفاع %',1,100],['fontSize','حجم الخط',6,160]].map(([key,label,min,max])=>`<label>${label}<input type="number" data-object="${i}" data-object-prop="${key}" min="${min}" max="${max}" value="${Number(b[key])}"></label>`).join('')}<label>النص<input type="color" data-object="${i}" data-object-prop="color" value="${esc(b.color||'#172D2A')}"></label>${imported?'':`<button data-action="delete-object" data-object="${i}">حذف العنصر</button>`}</fieldset>`).join('')}</details>`:''}`;}
export function addTextObject(s){if(!s.textBoxes?.length)slideLayout(s,'columns');s.textBoxes.push(box('نص جديد',10,35,45,20,24,'#172D2A'));}
