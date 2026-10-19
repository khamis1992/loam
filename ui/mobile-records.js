import {parseRecordState,recordLabel,relationLabel} from './mobile-data.js';
import {commitRecordChange,subscribeRecords,readRecordCache} from './mobile-record-store.js';
export function mountRecords(root,project,collectionId,key){
 const schema=project.collections.find(c=>c.id===collectionId),schemas=project.collections;
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const button=(text,fn,cls='')=>{const b=el('button',text,cls);b.type='button';b.onclick=fn;return b;};
 let query='',trash=false,filter='',editing,values={},errors={},message='',failure='',pending=false,disposed=false;
 const instanceId=crypto.randomUUID();
 const read=()=>readRecordCache(key+'-records');
 const commit=async action=>{const next=await commitRecordChange(key+'-records',schemas,{...action,collectionId});errors=next.errors;return !Object.keys(errors).length;};
 const attempt=async fn=>{if(pending||disposed)return;pending=true;root.setAttribute('aria-busy','true');root.querySelector('output').textContent='جارٍ حفظ التغيير…';root.querySelectorAll('button,input,select').forEach(n=>n.disabled=true);try{failure='';await fn();}catch(e){failure=e.message||'تعذر حفظ البيانات';}finally{pending=false;root.removeAttribute('aria-busy');if(!disposed){render();root.querySelector('[aria-invalid="true"]')?.focus();}}};
 function relationOptions(input,field,state){
  const linked=schemas.find(c=>c.id===field.collectionId),rows=state.collections[field.collectionId]||[],current=String(values[field.id]||'');
  input.replaceChildren(new Option('اختر…',''));
  for(const row of rows)if(!row.deletedAt)input.append(new Option(relationLabel(linked,row,rows),row.id));
  if(current&&![...input.options].some(o=>o.value===current))input.append(new Option('قيمة سابقة غير متاحة',current));input.value=current;
 }
 function refresh(){
  if(disposed||pending)return;
  if(editing!==undefined){
   try{const state=read();for(const field of schema.fields.filter(f=>f.type==='relation')){const input=[...root.querySelectorAll('select')].find(n=>n.dataset.fieldId===field.id);if(input)relationOptions(input,field,state);}
    const current=editing&&(state.collections[collectionId]||[]).find(r=>r.id===editing.id),stale=editing&&(!current||current.deletedAt||current.updatedAt!==editing.updatedAt);
    const notice=root.querySelector('output');notice.textContent=stale?'تغيّر هذا السجل في نافذة أخرى. احتفظنا بمسودتك؛ ارجع للقائمة لفتح النسخة الأحدث.':failure||message;
   }catch(e){root.querySelector('output').textContent=e.message;}
   return;
  }
  const input=document.activeElement,focused=root.contains(input)&&input.type==='search',start=focused?input.selectionStart:null,end=focused?input.selectionEnd:null;
  render();if(focused){const search=root.querySelector('input[type="search"]');search?.focus();search?.setSelectionRange(start,end);}
 }
 const unsubscribe=subscribeRecords(key+'-records',refresh);
 function open(row){editing=row||null;values={...(row?.values||{})};errors={};failure='';message='';render();root.querySelector('input,select')?.focus();}
 function render(){
  root.replaceChildren();root.className='record-workspace';let state;
  try{state=read();}catch(e){root.append(el('p',e.message,'record-error'));return;}
  const notice=el('output',failure||message,failure?'record-error':'record-notice');notice.setAttribute('aria-live','polite');root.append(notice);
  if(editing!==undefined){
   const form=el('form'),title=el('h2',(editing?'تعديل ':'إضافة ')+schema.singular);form.noValidate=true;
   root.append(button('عودة إلى القائمة',()=>{editing=undefined;errors={};render();},'record-back'),title,form);
   for(const field of schema.fields){
    const label=el('label',undefined,'record-field'),caption=el('span',field.label+(field.required?' *':''));let input;
    if(field.type==='select'||field.type==='relation'){input=el('select');if(field.type==='relation')relationOptions(input,field,state);else{input.append(new Option('اختر…',''));for(const v of field.options)input.append(new Option(v,v));const current=String(values[field.id]||'');if(current&&![...input.options].some(o=>o.value===current))input.append(new Option('قيمة سابقة غير متاحة',current));input.value=current;}}
    else{input=el('input');input.type=field.type==='boolean'?'checkbox':field.type==='number'?'number':field.type==='date'?'date':'text';if(field.type==='boolean')input.checked=values[field.id]===true;else input.value=String(values[field.id]??'');if(field.type==='number')input.step='any';if(field.type==='text')input.maxLength=2000;}
    if(field.type==='number'){input.step=field.integer?'1':'any';if(field.min!==undefined)input.min=String(field.min);if(field.max!==undefined)input.max=String(field.max);}
    input.setAttribute('aria-label',field.label);input.dataset.fieldId=field.id;input.required=!!field.required&&field.type!=='boolean';input.oninput=()=>{values[field.id]=field.type==='boolean'?input.checked:input.value;};
    label.append(caption,input);if(errors[field.id]){input.setAttribute('aria-invalid','true');const error=el('small',errors[field.id],'record-error');error.id='record-error-'+instanceId+'-'+field.id;input.setAttribute('aria-describedby',error.id);label.append(error);}form.append(label);
   }
   const save=el('button','حفظ '+schema.singular,'record-primary');save.type='button';form.append(save);const submit=e=>{e.preventDefault();attempt(async()=>{if(await commit({type:'save',id:editing?.id,expectedUpdatedAt:editing?.updatedAt,values:{...values}})){editing=undefined;message='تم حفظ '+schema.singular;}});};save.onclick=submit;form.onsubmit=submit;form.onkeydown=e=>{if(e.key==='Enter'&&e.target.tagName==='INPUT'&&e.target.type!=='checkbox')submit(e);};return;
  }
  const all=state.collections[collectionId]||[],active=all.filter(r=>!r.deletedAt),head=el('div',undefined,'record-heading');head.append(el('h2',schema.title),el('span',String(active.length),'record-count'),button('إضافة '+schema.singular,()=>open(null),'record-primary'));root.append(head);
  const search=el('input');search.type='search';search.placeholder='ابحث في '+schema.title;search.setAttribute('aria-label',search.placeholder);search.value=query;
  const toolbar=el('div',undefined,'record-toolbar'),list=el('div',undefined,'record-list');toolbar.append(search);
  const filterField=schema.fields.find(f=>f.type==='select');if(filterField){const select=el('select');select.setAttribute('aria-label','تصفية حسب '+filterField.label);select.append(new Option('كل '+filterField.label,''));for(const v of filterField.options)select.append(new Option(v,v));select.value=filter;select.onchange=()=>{filter=select.value;draw();};toolbar.append(select);}
  toolbar.append(button(trash?'عرض السجلات':'المحذوفات ('+all.filter(r=>r.deletedAt).length+')',()=>{trash=!trash;render();},'record-secondary'));root.append(toolbar,list);
  const display=(field,value)=>{if(field.type==='boolean')return value?'نعم':'لا';if(field.type==='relation'){const linked=schemas.find(c=>c.id===field.collectionId),rows=state.collections[field.collectionId]||[],row=rows.find(r=>r.id===value);return row?relationLabel(linked,row,rows):'غير محدد';}return String(value??'');};
  function draw(){list.replaceChildren();const rows=all.filter(r=>!!r.deletedAt===trash).filter(r=>(!filter||r.values[filterField?.id]===filter)&&schema.fields.some(f=>display(f,r.values[f.id]).toLocaleLowerCase().includes(query.toLocaleLowerCase()))).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
   if(!rows.length){list.append(el('p',query||filter?'لا توجد نتائج مطابقة':trash?'المحذوفات فارغة':'ابدأ بإضافة '+schema.singular+'؛ ستظهر سجلاتك هنا.','record-empty'));return;}
   for(const row of rows){const card=el('article',undefined,'record-card');card.dataset.recordId=row.id;card.append(el('h3',recordLabel(schema,row)));const detail=schema.fields.filter(f=>f.id!==schema.titleField&&f.type!=='boolean').sort((a,b)=>(a.id===schema.subtitleField?-2:a.type==='relation'?-1:0)-(b.id===schema.subtitleField?-2:b.type==='relation'?-1:0)).slice(0,4);for(const f of detail)if(row.values[f.id]!==''&&row.values[f.id]!==undefined)card.append(el('p',f.label+' · '+display(f,row.values[f.id])));for(const f of schema.fields.filter(f=>f.type==='boolean'))card.append(el('span',f.label+' · '+display(f,row.values[f.id]),row.values[f.id]?'record-chip done':'record-chip'));
    const actions=el('div',undefined,'record-actions');if(trash)actions.append(button('استعادة '+schema.singular,()=>attempt(async()=>{if(await commit({type:'restore',id:row.id,expectedUpdatedAt:row.updatedAt}))message='تمت استعادة '+schema.singular;})));else actions.append(button('تعديل '+schema.singular,()=>open(row)),button('حذف '+schema.singular,()=>attempt(async()=>{if(await commit({type:'delete',id:row.id,expectedUpdatedAt:row.updatedAt}))message='نُقل السجل إلى المحذوفات؛ يمكنك استعادته.';}),'record-delete'));card.append(actions);list.append(card);
   }
  }
  search.oninput=()=>{query=search.value;draw();};draw();
 }
 render();
 return ()=>{disposed=true;unsubscribe();};
}
