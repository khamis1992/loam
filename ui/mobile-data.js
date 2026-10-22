// Platform-independent record rules. Stored user records never enter the model prompt.
export const FIELD_TYPES=['text','number','date','boolean','select','relation'];
export function validateCollections(input=[]){
 if(!Array.isArray(input)||input.length>16)throw Error('Use at most 16 collections');
 const safe=(v)=>typeof v==='string'&&/^[a-z][a-z\d_-]{0,79}$/i.test(v)&&!['constructor','prototype','__proto__'].includes(v);
 const label=(v)=>typeof v==='string'&&v.trim()&&v.length<=120;
 const ids=new Set();
 const clean=input.map(c=>{
  if(!c||!safe(c.id)||ids.has(c.id)||!label(c.title)||!label(c.singular))throw Error('Collection needs unique id, title and singular label');ids.add(c.id);
  if(!Array.isArray(c.fields)||!c.fields.length||c.fields.length>16)throw Error('Collection needs 1–16 fields');
  const fields=new Set();
  const result={id:c.id,title:c.title,singular:c.singular,titleField:c.titleField,...(c.subtitleField?{subtitleField:c.subtitleField}:{}),fields:c.fields.map(f=>{
   if(!f||!safe(f.id)||fields.has(f.id)||!label(f.label)||!FIELD_TYPES.includes(f.type))throw Error('Invalid collection field');fields.add(f.id);
   if(f.required!==undefined&&typeof f.required!=='boolean')throw Error('required must be boolean');
   if(f.type==='select'&&(!Array.isArray(f.options)||!f.options.length||f.options.length>12||f.options.some(o=>!label(o))||new Set(f.options).size!==f.options.length))throw Error('Select needs 1–12 unique options');
   if(f.type==='relation'&&!safe(f.collectionId))throw Error('Relation needs collectionId');
   const limits={};for(const key of ['min','max'])if(f[key]!==undefined){if(f.type!=='number'||typeof f[key]!=='number'||!Number.isFinite(f[key])||Math.abs(f[key])>1e12)throw Error(c.id+'.'+f.id+': '+key+' requires a number field with a finite numeric bound');limits[key]=f[key];}
   if(f.integer!==undefined){if(f.type!=='number'||typeof f.integer!=='boolean')throw Error(c.id+'.'+f.id+': integer applies only to number fields');limits.integer=f.integer;}
   if(f.min!==undefined&&f.max!==undefined&&f.min>f.max)throw Error('Minimum cannot exceed maximum');
   return {id:f.id,label:f.label,type:f.type,...(f.required?{required:true}:{}),...(f.type==='select'?{options:[...f.options]}:{}),...(f.type==='relation'?{collectionId:f.collectionId}:{}),...limits};
  })};
  if(!result.fields.some(f=>f.id===c.titleField&&f.type==='text'&&f.required))throw Error('titleField must reference a required text field');
  if(c.subtitleField&&!fields.has(c.subtitleField))throw Error('Invalid subtitleField');
  if(c.rules!==undefined){
   if(!Array.isArray(c.rules)||c.rules.length>16)throw Error('Use at most 16 collection rules');const ruleIds=new Set();
   result.rules=c.rules.map(rule=>{
    if(!rule||!safe(rule.id)||ruleIds.has(rule.id)||typeof rule.message!=='string'||!rule.message.trim()||rule.message.length>240)throw Error('Rule needs a unique id and a clear message');ruleIds.add(rule.id);
    if(rule.type==='compare'){const left=result.fields.find(f=>f.id===rule.field),right=result.fields.find(f=>f.id===rule.otherField);if(!left||!right||left.id===right.id||!['date','number'].includes(left.type)||left.type!==right.type||!['gt','gte'].includes(rule.operator))throw Error('Compare needs two different fields of the same numeric/date type');return {id:rule.id,type:rule.type,field:left.id,otherField:right.id,operator:rule.operator,message:rule.message};}
    if(rule.type==='unique'){
     if(!Array.isArray(rule.fields)||!rule.fields.length||rule.fields.length>8||new Set(rule.fields).size!==rule.fields.length||rule.fields.some(id=>!fields.has(id)))throw Error('Unique rule needs 1–8 existing fields');
     let when;if(rule.when!==undefined){const f=result.fields.find(f=>f.id===rule.when?.field),value=rule.when?.equals;if(!f||(f.type==='boolean'?typeof value!=='boolean':f.type!=='select'||!f.options.includes(value)))throw Error('Rule condition must match a boolean or select option');when={field:f.id,equals:value};}
     return {id:rule.id,type:rule.type,fields:[...rule.fields],...(when?{when}:{}),message:rule.message};
    }throw Error('Unknown collection rule');
   });
  }
  return result;
 });
 for(const c of clean)for(const f of c.fields)if(f.type==='relation'&&!ids.has(f.collectionId))throw Error('Relation collection does not exist');
 const visiting=new Set(),visited=new Set();function visit(c){if(visiting.has(c.id))throw Error('Required relation cycle: make one relation optional');if(visited.has(c.id))return;visiting.add(c.id);for(const f of c.fields)if(f.type==='relation'&&f.required)visit(clean.find(x=>x.id===f.collectionId));visiting.delete(c.id);visited.add(c.id);}clean.forEach(visit);
 return clean;
}
export function parseRecordState(raw){
 if(!raw)return {version:1,revision:0,collections:{}};
 const state=JSON.parse(raw);
 if(state?.version!==1||!Number.isSafeInteger(state.revision)||state.revision<0||!state.collections||Array.isArray(state.collections)||typeof state.collections!=='object')throw Error('تعذر قراءة البيانات المحفوظة؛ لم تُستبدل بياناتك.');
 for(const rows of Object.values(state.collections))if(!Array.isArray(rows)||rows.some(r=>!r||typeof r.id!=='string'||!r.values||Array.isArray(r.values)||typeof r.values!=='object'||typeof r.createdAt!=='string'||typeof r.updatedAt!=='string'||(r.deletedAt!==undefined&&typeof r.deletedAt!=='string')||Object.values(r.values).some(v=>!['string','number','boolean'].includes(typeof v)))||new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('تعذر قراءة السجلات المحفوظة؛ لم تُستبدل بياناتك.');
 return state;
}
export function validateRecord(collection,values,state,excludeId){
 const errors={},clean={};
 for(const field of collection.fields){
  const value=values[field.id];
  if(field.type==='boolean'){clean[field.id]=value===true;continue;}
  const empty=value===undefined||value===null||String(value).trim()==='';
  if(empty){if(field.required)errors[field.id]='هذا الحقل مطلوب';else clean[field.id]='';continue;}
  if(field.type==='number'){const n=Number(value);if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(value).trim())||!Number.isFinite(n)||Math.abs(n)>1e12)errors[field.id]='أدخل رقمًا صالحًا';else if(field.integer&&!Number.isInteger(n))errors[field.id]='أدخل عددًا صحيحًا';else if(field.min!==undefined&&n<field.min)errors[field.id]='أقل قيمة مسموحة: '+field.min;else if(field.max!==undefined&&n>field.max)errors[field.id]='أكبر قيمة مسموحة: '+field.max;else clean[field.id]=n;}
  else if(field.type==='date'){const s=String(value);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)errors[field.id]='أدخل تاريخًا صالحًا';else clean[field.id]=s;}
  else if(field.type==='select'){if(!field.options.includes(value))errors[field.id]='اختر قيمة من القائمة';else clean[field.id]=value;}
  else if(field.type==='relation'){if(!(state.collections[field.collectionId]||[]).some(r=>r.id===value&&!r.deletedAt))errors[field.id]='السجل المرتبط غير متاح؛ اختر سجلًا آخر';else clean[field.id]=value;}
  else {const s=String(value).trim();if(s.length>2000)errors[field.id]='الحد الأقصى 2000 حرف';else clean[field.id]=s;}
 }
 const empty=v=>v===undefined||v===null||v==='';
 const matches=(rule,v)=>!rule.when||v[rule.when.field]===rule.when.equals;
 for(const rule of collection.rules||[]){
  if(rule.type==='compare'){const a=clean[rule.field],b=clean[rule.otherField];if(!errors[rule.field]&&!errors[rule.otherField]&&!empty(a)&&!empty(b)&&!(rule.operator==='gt'?a>b:a>=b))errors[rule.field]=rule.message;}
  else if(matches(rule,clean)&&!rule.fields.some(id=>errors[id]||empty(clean[id]))){
   const equal=(id,a,b)=>collection.fields.find(f=>f.id===id).type==='number'?Number(a)===Number(b):typeof a==='string'&&typeof b==='string'?a.trim().toLowerCase()===b.trim().toLowerCase():a===b;
   if((state.collections[collection.id]||[]).some(row=>row.id!==excludeId&&!row.deletedAt&&matches(rule,row.values)&&rule.fields.every(id=>!empty(row.values[id])&&equal(id,clean[id],row.values[id]))))errors[rule.fields[0]]=rule.message;
  }
 }
 return {values:clean,errors};
}
export function mutateRecords(state,schemas,action){
 const collection=schemas.find(c=>c.id===action.collectionId);if(!collection)throw Error('مجموعة البيانات غير موجودة');
 const next=structuredClone(state),rows=next.collections[collection.id]||[],row=rows.find(r=>r.id===action.id);
 // Two edits in one millisecond (or a clock adjustment) must still have distinct versions.
 const now=new Date(Math.max(Date.now(),(Date.parse(row?.updatedAt)||0)+1)).toISOString();
 if(row&&action.expectedUpdatedAt!==undefined&&action.expectedUpdatedAt!==row.updatedAt)throw Error('تغيّر السجل في جلسة أخرى؛ أعد فتحه قبل التعديل');
 if(action.type==='save'){
  if(action.id&&(!row||row.deletedAt))throw Error('السجل لم يعد متاحًا؛ أعد فتح القائمة');
  if(row&&action.expectedUpdatedAt!==row.updatedAt)throw Error('تغيّر السجل في جلسة أخرى؛ أعد فتحه قبل التعديل');
  const checked=validateRecord(collection,action.values,next,row?.id);if(Object.keys(checked.errors).length)return {state,errors:checked.errors};
  if(row){row.values={...row.values,...checked.values};row.updatedAt=now;}else{if(rows.length>=1000)throw Error('وصلت هذه المجموعة إلى حد 1000 سجل');rows.push({id:crypto.randomUUID(),values:checked.values,createdAt:now,updatedAt:now});}
 }else if(action.type==='delete'){
  if(!row||row.deletedAt)throw Error('السجل غير موجود');
  for(const c of schemas)for(const f of c.fields)if(f.type==='relation'&&f.collectionId===collection.id&&(next.collections[c.id]||[]).some(r=>!r.deletedAt&&r.values[f.id]===row.id))throw Error('هذا السجل مرتبط ببيانات أخرى. غيّر الارتباط أولًا.');
  row.deletedAt=now;row.updatedAt=now;
 }else if(action.type==='restore'){if(!row?.deletedAt)throw Error('لا يوجد حذف يمكن التراجع عنه');const checked=validateRecord(collection,row.values,next,row.id);if(Object.keys(checked.errors).length)throw Error('تعذرت الاستعادة: '+Object.values(checked.errors)[0]);delete row.deletedAt;row.updatedAt=now;}
 else throw Error('Unknown data action');
 next.collections[collection.id]=rows;next.revision++;return {state:next,errors:{}};
}
export function recordLabel(schema,row){return String(row?.values?.[schema.titleField]||schema.singular);}
export function relationLabel(schema,row,rows){
 const title=recordLabel(schema,row),peers=rows.filter(r=>!r.deletedAt&&recordLabel(schema,r)===title);
 if(peers.length<2)return title;
 const fields=schema.fields.filter(f=>f.id!==schema.titleField&&f.type!=='relation'&&f.type!=='boolean').sort((a,b)=>Number(b.id===schema.subtitleField)-Number(a.id===schema.subtitleField));
 const detail=r=>fields.filter(f=>r.values[f.id]!==undefined&&r.values[f.id]!=='').slice(0,2).map(f=>f.label+': '+String(r.values[f.id]).slice(0,70)).join(' · ');
 const context=detail(row),label=title+(context?' — '+context:'');
 return peers.filter(r=>detail(r)===context).length>1?label+' · #'+row.id:label;
}
