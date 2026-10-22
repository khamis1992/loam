import {validateCollections} from './mobile-data.js';
export function createDataEditor({context,apply}){
 const $=id=>document.getElementById(id),dialog=$('data-dialog');let collections=[],selected='',newIds=new Set(),existingFields=new Set();
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 const id=p=>p+crypto.randomUUID().replaceAll('-','');
 function input(label,value,oninput){const wrap=el('label',label),field=el('input');field.value=value??'';field.oninput=()=>oninput(field.value);wrap.append(field);return wrap;}
 function select(label,options,value,change){const wrap=el('label',label),field=el('select');field.setAttribute('aria-label',label);for(const [v,text]of options)field.append(new Option(text,v));field.value=value;field.onchange=()=>change(field.value);wrap.append(field);return wrap;}
 function renderRules(c,body){
  const section=el('section');section.append(el('h3','قواعد حفظ السجلات'),el('p','تُفحص قبل الحفظ والاستعادة. السجلات المحذوفة لا تحجز القيم الفريدة.'));
  for(const rule of c.rules||[]){const row=el('fieldset');row.append(el('legend',rule.type==='compare'?'مقارنة حقلين':'منع التكرار'));
   if(rule.type==='compare'){
    const fields=c.fields.filter(f=>['number','date'].includes(f.type));row.append(select('الحقل الذي نتحقق منه',fields.map(f=>[f.id,f.label]),rule.field,v=>{rule.field=v;render();}),select('شرط المقارنة',[['gte','أكبر من أو يساوي'],['gt','أكبر من']],rule.operator,v=>rule.operator=v),select('بالمقارنة مع',fields.filter(f=>f.id!==rule.field&&f.type===c.fields.find(x=>x.id===rule.field)?.type).map(f=>[f.id,f.label]),rule.otherField,v=>rule.otherField=v));
   }else{
    row.append(el('p','لا يمكن تكرار هذه الحقول مجتمعة:'));for(const f of c.fields){const label=el('label',f.label),check=el('input');check.type='checkbox';check.checked=rule.fields.includes(f.id);check.onchange=()=>rule.fields=check.checked?[...rule.fields,f.id]:rule.fields.filter(x=>x!==f.id);label.append(check);row.append(label);}
    const eligible=c.fields.filter(f=>['boolean','select'].includes(f.type));row.append(select('تطبيق منع التكرار',[['','على جميع السجلات'],...eligible.map(f=>[f.id,'عندما: '+f.label])],rule.when?.field||'',v=>{if(!v)delete rule.when;else{const f=c.fields.find(f=>f.id===v);rule.when={field:v,equals:f.type==='boolean'?false:f.options[0]};}render();}));
    if(rule.when){const f=c.fields.find(f=>f.id===rule.when.field);const choices=f?.type==='boolean'?[[JSON.stringify(false),'لا'],[JSON.stringify(true),'نعم']]:(f?.options||[]).map(v=>[JSON.stringify(v),v]);row.append(select('القيمة التي تفعّل القاعدة',choices,JSON.stringify(rule.when.equals),v=>rule.when.equals=JSON.parse(v)));}
   }
   row.append(input('رسالة توضيح الخطأ',rule.message,v=>rule.message=v));const remove=el('button','إزالة القاعدة');remove.type='button';remove.onclick=()=>{c.rules=c.rules.filter(r=>r.id!==rule.id);render();};row.append(remove);section.append(row);
  }
  const pair=c.fields.flatMap(f=>['date','number'].includes(f.type)?c.fields.filter(other=>other.type===f.type&&other.id!==f.id).map(other=>[f,other]):[])[0];
  for(const [title,type]of [['إضافة مقارنة','compare'],['إضافة منع تكرار','unique']]){const add=el('button',title);add.type='button';add.disabled=(c.rules?.length||0)>=16||(type==='compare'&&!pair);add.onclick=()=>{c.rules||=[];c.rules.push(type==='compare'?{id:id('rule_'),type,field:pair[1].id,otherField:pair[0].id,operator:'gte',message:'القيمة يجب ألا تسبق '+pair[0].label}:{id:id('rule_'),type,fields:[c.titleField],message:'يوجد سجل آخر بالقيمة نفسها'});render();};section.append(add);}
  body.append(section);
 }
 function render(){
  $('data-collections').replaceChildren();for(const c of collections)$('data-collections').append(new Option(c.title,c.id));$('data-collections').value=selected;
  const c=collections.find(c=>c.id===selected),body=$('data-fields');body.replaceChildren();$('data-add-field').disabled=!c;if(!c){body.append(el('p','أضف مجموعة مثل المهام أو الكتب لتبدأ.'));return;}
  body.append(input('اسم المجموعة',c.title,v=>c.title=v),input('اسم السجل المفرد',c.singular,v=>c.singular=v));
  const titleLabel=el('label','الحقل الذي يظهر عنوانًا للسجل'),title=el('select');title.setAttribute('aria-label','الحقل الذي يظهر عنوانًا للسجل');for(const f of c.fields.filter(f=>f.type==='text'))title.append(new Option(f.label,f.id));title.value=c.titleField;title.onchange=()=>{c.titleField=title.value;c.fields.find(f=>f.id===title.value).required=true;render();};titleLabel.append(title);body.append(titleLabel);
  for(const f of c.fields){const row=el('fieldset'),legend=el('legend',f.label||'حقل جديد');row.append(legend,input('اسم الحقل',f.label,v=>f.label=v));const typeLabel=el('label','نوع البيانات'),type=el('select');type.setAttribute('aria-label','نوع البيانات');for(const [value,label]of [['text','نص'],['number','رقم'],['date','تاريخ'],['boolean','اختيار نعم/لا'],['select','قائمة خيارات'],['relation','ارتباط بسجل']])type.append(new Option(label,value));type.value=f.type;type.disabled=f.id===c.titleField||existingFields.has(c.id+':'+f.id);type.onchange=()=>{f.type=type.value;delete f.options;delete f.collectionId;delete f.min;delete f.max;delete f.integer;if(f.type==='select')f.options=['جديد','مكتمل'];if(f.type==='relation')f.collectionId=collections.find(x=>x.id!==c.id)?.id||c.id;render();};typeLabel.append(type);row.append(typeLabel);
   const required=el('label','مطلوب'),check=el('input');check.type='checkbox';check.checked=!!f.required;check.disabled=f.id===c.titleField;check.onchange=()=>f.required=check.checked;required.append(check);row.append(required);
   if(f.type==='number'){for(const [key,label]of [['min','أقل قيمة'],['max','أكبر قيمة']]){const bound=input(label,f[key],v=>{if(v==='')delete f[key];else f[key]=Number(v);});bound.querySelector('input').type='number';bound.querySelector('input').step='any';row.append(bound);}const label=el('label','أعداد صحيحة فقط'),integer=el('input');integer.type='checkbox';integer.checked=!!f.integer;integer.onchange=()=>f.integer=integer.checked;label.append(integer);row.append(label);}
   if(f.type==='select')row.append(input('الخيارات، مفصولة بفاصلة',f.options.join('، '),v=>f.options=v.split(/[,،]/).map(x=>x.trim()).filter(Boolean)));
   if(f.type==='relation'){const relation=el('label','مجموعة السجل المرتبط'),select=el('select');select.setAttribute('aria-label','مجموعة السجل المرتبط');for(const other of collections)select.append(new Option(other.title,other.id));select.value=f.collectionId;select.disabled=existingFields.has(c.id+':'+f.id);select.onchange=()=>f.collectionId=select.value;relation.append(select);row.append(relation);}
   if(f.id!==c.titleField){const remove=el('button','إزالة الحقل من النموذج');remove.type='button';remove.onclick=()=>{c.fields=c.fields.filter(x=>x.id!==f.id);render();};row.append(remove);}body.append(row);
  }
  renderRules(c,body);
 }
 $('data-open').onclick=()=>{collections=structuredClone(context().collections||[]);selected=collections[0]?.id||'';existingFields=new Set(collections.flatMap(c=>c.fields.map(f=>c.id+':'+f.id)));newIds=new Set();$('data-error').textContent='';render();dialog.showModal();};
 $('data-close').onclick=()=>dialog.close();$('data-collections').onchange=e=>{selected=e.target.value;render();};
 $('data-add').onclick=()=>{if(collections.length>=16)return;const field=id('field_');selected=id('data_');collections.push({id:selected,title:'سجلاتي',singular:'سجل',titleField:field,fields:[{id:field,label:'الاسم',type:'text',required:true}]});newIds.add(selected);render();};
 $('data-add-field').onclick=()=>{const c=collections.find(c=>c.id===selected);if(c.fields.length<16){c.fields.push({id:id('field_'),label:'حقل جديد',type:'text'});render();}};
 $('data-apply').onclick=()=>{try{const clean=validateCollections(collections);apply(clean,newIds);dialog.close();}catch(e){$('data-error').textContent=e.message;}};
}
