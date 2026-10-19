const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const richTypes=['stats','table','image'];
const names={stats:'بطاقات إحصاءات',table:'جدول',image:'صورة'};
export function richMarkup(b,i,reading){
  const field=(value,props,label)=>`<input dir="auto" value="${esc(value)}" ${props} aria-label="${esc(label)}">`;
  let body='';
  if(b.type==='stats')body=`<div class="document-stats">${b.items.map((s,j)=>`<div class="document-stat tone-${s.tone}">${reading?`<strong dir="auto">${esc(s.value)}</strong><span dir="auto">${esc(s.label)}</span>`:`${field(s.value,`data-stat="${j}" data-prop="value" maxlength="40"`,'القيمة '+(j+1))}${field(s.label,`data-stat="${j}" data-prop="label" maxlength="120"`,'وصف الإحصاء '+(j+1))}<select data-stat="${j}" data-prop="tone" aria-label="لون البطاقة ${j+1}">${['teal','blue','amber'].map(t=>`<option value="${t}" ${s.tone===t?'selected':''}>${{teal:'أخضر',blue:'أزرق',amber:'ذهبي'}[t]}</option>`).join('')}</select><button type="button" data-rich-action="remove-stat" data-index="${j}" ${b.items.length===1?'disabled':''}>حذف البطاقة</button>`}</div>`).join('')}</div>${!reading&&b.items.length<4?'<button type="button" data-rich-action="add-stat">إضافة بطاقة</button>':''}`;
  if(b.type==='table')body=`<div class="document-table-scroll"><table class="document-table" dir="auto"><thead><tr>${b.columns.map((v,c)=>`<th scope="col">${reading?esc(v):field(v,`data-table-column="${c}" maxlength="200"`,'عنوان العمود '+(c+1))}${!reading&&b.columns.length>1?`<button type="button" data-rich-action="remove-column" data-index="${c}" aria-label="حذف العمود ${c+1}">×</button>`:''}</th>`).join('')}${!reading?'<th aria-label="إجراءات الصف"></th>':''}</tr></thead><tbody>${b.rows.map((row,r)=>`<tr>${row.map((v,c)=>`<td>${reading?esc(v):`<textarea dir="auto" rows="2" data-table-cell="${r},${c}" maxlength="1000" aria-label="صف ${r+1} عمود ${c+1}">${esc(v)}</textarea>`}</td>`).join('')}${!reading?`<td><button type="button" data-rich-action="remove-row" data-index="${r}" aria-label="حذف الصف ${r+1}">×</button></td>`:''}</tr>`).join('')}</tbody></table></div>${!reading?`<div class="document-rich-actions"><button type="button" data-rich-action="add-row" ${b.rows.length>=200?'disabled':''}>إضافة صف</button><button type="button" data-rich-action="add-column" ${b.columns.length>=6?'disabled':''}>إضافة عمود</button></div>`:''}${!reading&&b.sourceNode!==undefined?`<div class="document-cell-images"><strong>صور داخل الخلايا</strong>${(b.cellImages||[]).map((im,j)=>`<span class="document-cell-image">صف ${im.row+1} · عمود ${im.column+1}<button type="button" data-rich-action="remove-cell-image" data-index="${j}" aria-label="إزالة صورة الخلية">×</button></span>`).join('')||'<span class="document-cell-hint">لا صور مضافة بعد</span>'}<label class="document-cell-picker">إضافة صورة إلى خلية<select data-cell-image-row aria-label="صف الصورة">${b.rows.map((_,r)=>`<option value="${r}">صف ${r+1}</option>`).join('')}</select><select data-cell-image-column aria-label="عمود الصورة">${b.columns.map((_,c)=>`<option value="${c}">عمود ${c+1}</option>`).join('')}</select><input type="file" data-cell-image-file accept="image/png,image/jpeg"></label></div>`:''}`;
  if(b.type==='image')body=`<figure class="document-image"><img src="${esc(b.src)}" alt="${esc(b.alt)}">${!reading?`<label>وصف الصورة ${field(b.alt,'data-image-alt maxlength="500"','وصف الصورة')}</label><label class="document-image-picker">استبدال الصورة<input type="file" data-replace-image accept="image/png,image/jpeg"></label>`:''}</figure>`;
  return `<section class="office-block document-rich" data-block="${i}" tabindex="-1" aria-label="${names[b.type]}">${!reading?`<div class="office-block-tools"><strong>${names[b.type]}</strong><button type="button" data-delete-block="${i}" aria-label="حذف ${names[b.type]}">×</button></div>`:''}${reading&&b.type==='table'&&b.text?`<p class="document-caption document-table-caption" dir="auto">${esc(b.text)}</p>`:''}${body}${reading?(b.text&&b.type!=='table'?`<p class="document-caption" dir="auto">${esc(b.text)}</p>`:''):`<input ${b.sourceNode!==undefined?'disabled title="عدّل التعليق في فقرته الأصلية"':''} class="document-caption" data-block-text="${i}" dir="auto" maxlength="500" placeholder="تعليق أو مصدر البيانات (اختياري)" aria-label="تعليق ${names[b.type]}" value="${esc(b.text)}">`}</section>`;
}
export function richInput(e,a){
  if(!e.closest('[data-block]'))return false;
  const b=a.content.blocks[Number(e.closest('[data-block]').dataset.block)];
  if(e.hasAttribute('data-stat')){b.items[Number(e.dataset.stat)][e.dataset.prop]=e.value;if(e.dataset.prop==='tone')e.closest('.document-stat').className='document-stat tone-'+e.value;}
  else if(e.hasAttribute('data-table-column'))b.columns[Number(e.dataset.tableColumn)]=e.value;
  else if(e.hasAttribute('data-table-cell')){const [r,c]=e.dataset.tableCell.split(',').map(Number);b.rows[r][c]=e.value;}
  else if(e.hasAttribute('data-image-alt')){b.alt=e.value;e.closest('[data-block]').querySelector('img').alt=e.value;}
  else return false;
  return true;
}
export function richAction(e,a){
  const action=e.dataset.richAction;if(!action)return false;
  const b=a.content.blocks[Number(e.closest('[data-block]').dataset.block)],index=Number(e.dataset.index);
  if(action==='add-stat'&&b.items.length<4)b.items.push({value:'0',label:'إحصاء جديد',tone:'teal'});
  if(action==='remove-stat'&&b.items.length>1)b.items.splice(index,1);
  if(action==='add-row'&&b.rows.length<200)b.rows.push(b.columns.map(()=>''));
  if(action==='remove-row')b.rows.splice(index,1);
  if(action==='add-column'&&b.columns.length<6){b.columns.push('عمود جديد');b.rows.forEach(r=>r.push(''));}
  if(action==='remove-column'&&b.columns.length>1){b.columns.splice(index,1);b.rows.forEach(r=>r.splice(index,1));}
  if(action==='remove-cell-image'&&Array.isArray(b.cellImages))b.cellImages.splice(index,1);
  return true;
}
export async function imageBlock(file){
  if(!['image/png','image/jpeg'].includes(file.type)||file.size>10_000_000)throw Error('اختر صورة PNG أو JPEG بحجم لا يتجاوز 10 ميغابايت.');
  const bitmap=await createImageBitmap(file);
  try{
    if(bitmap.width*bitmap.height>24_000_000)throw Error('أبعاد الصورة كبيرة جدًا. استخدم صورة لا تتجاوز 24 مليون بكسل.');
    const scale=Math.min(1,1400/bitmap.width,1400/bitmap.height),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
    const src=canvas.toDataURL('image/jpeg',.85);if(src.length>1_400_000)throw Error('الصورة كبيرة بعد الضغط. اختر صورة أصغر.');
    return {type:'image',text:'',src,alt:file.name.replace(/\.[^.]+$/,'')};
  }finally{bitmap.close();}
}
