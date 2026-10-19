import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
import {mobileHtml} from '../mobile/export.js';
import {validateProject,type MobileProject} from '../mobile/store.js';
import {mutateRecords,parseRecordState,type MobileCollection,type DataField} from '../../ui/mobile-data.js';

export async function verifyDomain(domain:'library'|'bookings',raw:MobileProject,out:string){
 const project={...validateProject(raw),revision:raw.revision};assert.equal(project.screens.filter(s=>s.kind==='primary').length,2,'exactly two requested primary sections');
 const schemas=project.collections!;assert.equal(schemas?.length,2,'two real data collections');
 const parent=schemas.find(c=>domain==='library'?/كتب|كتاب/.test(c.title):/خدم/.test(c.title))!;assert.ok(parent,'parent collection');const child=schemas.find(c=>c.id!==parent.id)!;
 const field=(c:MobileCollection,type:DataField['type'],pattern?:RegExp)=>{const f=c.fields.find(f=>f.type===type&&(!pattern||pattern.test(f.label)));assert.ok(f,c.title+' needs '+type+' '+pattern);return f;};
 const required=(...fields:DataField[])=>fields.forEach(f=>assert.ok(f.required,f.label+' must be required'));
 const relation=child.fields.find(f=>f.type==='relation'&&f.collectionId===parent.id)!;assert.ok(relation?.required,'required real relationship');
 const nativeCases:unknown[]=[];
 let state=parseRecordState(null);const save=(c:MobileCollection,values:Record<string,unknown>,id?:string)=>{const result=mutateRecords(state,schemas,{type:'save',collectionId:c.id,values,id,expectedUpdatedAt:state.collections[c.id]?.find(r=>r.id===id)?.updatedAt});assert.deepEqual(result.errors,{},c.title+' valid record');nativeCases.push(structuredClone({schema:c,values,state,excludeId:id,valid:true}));state=result.state;return state.collections[c.id]!.at(-1)!;};
 const reject=(c:MobileCollection,values:Record<string,unknown>)=>{const before=JSON.stringify(state),result=mutateRecords(state,schemas,{type:'save',collectionId:c.id,values});assert.ok(Object.keys(result.errors).length,c.title+' invalid record rejected');assert.equal(JSON.stringify(result.state),before,'rejection does not mutate state');nativeCases.push(structuredClone({schema:c,values,state,valid:false}));};
 const parentValues:Record<string,unknown>={[parent.titleField]:domain==='library'?'فن القراءة':'استشارة تصميم'};
 let childValues:Record<string,unknown>={[child.titleField]:domain==='library'?'إعارة سارة':'حجز سارة'};let releaseField:DataField,releaseValue:string|boolean;
 if(domain==='library'){
  const code=field(parent,'text',/رمز|كود/),pages=field(parent,'number',/صفح/);required(code,pages);parentValues[code.id]='COPY-001';parentValues[pages.id]=240;
  for(const bad of [0,-1,1.5])reject(parent,{...parentValues,[pages.id]:bad});save(parent,parentValues);reject(parent,{...parentValues,[parent.titleField]:'نسخة مكررة',[code.id]:' copy-001 '});
  const borrower=field(child,'text',/مستعير/),start=field(child,'date',/إعار|اعار|بدا/),due=field(child,'date',/استحقاق|إرجاع|ارجاع|نهاي/);required(borrower,start,due);assert.notEqual(start.id,due.id);releaseField=field(child,'boolean');releaseValue=true;
  childValues={...childValues,[borrower.id]:'سارة',[start.id]:'2026-11-01',[due.id]:'2026-11-10',[releaseField.id]:false,[relation.id]:state.collections[parent.id]![0]!.id};reject(child,{...childValues,[due.id]:'2026-10-31'});
 }else{
  const price=field(parent,'number',/سعر|تكلف|ثمن/),duration=field(parent,'number',/مد[ةّة]|دقائق|زمن/);required(price,duration);parentValues[price.id]=120;parentValues[duration.id]=60;
  reject(parent,{...parentValues,[price.id]:-1});for(const bad of [14,181,15.5])reject(parent,{...parentValues,[duration.id]:bad});save(parent,parentValues);
  const date=field(child,'date'),slot=child.fields.find(f=>f.type==='select'&&['09:00','10:00','11:00'].every(s=>f.options?.includes(s)))!;assert.ok(slot,'three fixed time slots');releaseField=child.fields.find(f=>f.type==='select'&&f.options?.includes('مؤكد')&&f.options.includes('ملغى'))!;assert.ok(releaseField,'booking status');required(date,slot,releaseField);releaseValue='ملغى';
  childValues={...childValues,[date.id]:'2026-11-01',[slot.id]:'09:00',[releaseField.id]:'مؤكد',[relation.id]:state.collections[parent.id]![0]!.id};
 }
 const first=save(child,childValues);reject(child,{...childValues,[child.titleField]:'تعارض جديد'});
 // Uniqueness must match the whole requested key, not just reject everything.
 // A different physical copy/service can be used concurrently.
 const otherParentValues={...parentValues}; // Duplicate labels are allowed; identity is the record ID.
 if(domain==='library')otherParentValues[field(parent,'text',/رمز|كود/).id]='COPY-002';
 const otherParent=save(parent,otherParentValues);
 save(child,{...childValues,[child.titleField]:'سجل مرتبط مستقل',[relation.id]:otherParent.id});
 if(domain==='bookings'){
  const date=field(child,'date'),slot=child.fields.find(f=>f.type==='select'&&f.options?.includes('10:00'))!;
  save(child,{...childValues,[child.titleField]:'تاريخ مختلف',[date.id]:'2026-11-02'});
  save(child,{...childValues,[child.titleField]:'فترة مختلفة',[slot.id]:'10:00'});
 }
 // An ordinary edit must not conflict with the record itself.
 save(child,{...childValues,[child.titleField]:'تعديل الموعد'},first.id);
 save(child,{...childValues,[releaseField.id]:releaseValue},first.id);const second=save(child,{...childValues,[child.titleField]:'موعد بديل'});
 save(child,{...childValues,[child.titleField]:'موعد بديل',[releaseField.id]:releaseValue},second.id);
 const third=save(child,{...childValues,[child.titleField]:'إعادة الاستخدام للمرة الثالثة'});
 state=mutateRecords(state,schemas,{type:'delete',collectionId:child.id,id:third.id}).state;save(child,{...childValues,[child.titleField]:'حجز الفترة بعد الحذف'});
 assert.throws(()=>mutateRecords(state,schemas,{type:'restore',collectionId:child.id,id:third.id}),/تعذرت الاستعادة/,'restore cannot resurrect a conflicting record');
 assert.throws(()=>mutateRecords(state,schemas,{type:'delete',collectionId:parent.id,id:state.collections[parent.id]![0]!.id}),/مرتبط/);
 assert.deepEqual(parseRecordState(JSON.stringify(state)),state);

 const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:420,height:880}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const visit=async(c:MobileCollection)=>{const screen=project.screens.find(s=>s.blocks.some(b=>b.collectionId===c.id))!;assert.ok(screen,'collection has a reachable page');const route=[screen];while(route[0]!.parentId)route.unshift(project.screens.find(s=>s.id===route[0]!.parentId)!);await page.locator('nav button').filter({hasText:route[0]!.title}).click();for(let i=1;i<route.length;i++){const button=route[i-1]!.blocks.find(b=>b.target===route[i]!.id)!;assert.ok(button,'parent route exists');await page.getByRole('button',{name:button.text,exact:true}).click();}};
 const form=async(c:MobileCollection,values:Record<string,unknown>,editing:boolean|string=false)=>{await visit(c);const scope=typeof editing==='string'?page.locator('.record-card').filter({has:page.getByRole('heading',{name:editing,exact:true})}):page;await scope.getByRole('button',{name:(editing?'تعديل ':'إضافة ')+c.singular,exact:true}).click();for(const f of c.fields){if(values[f.id]===undefined)continue;const node=page.locator('[data-field-id="'+f.id+'"]');if(f.type==='boolean')await node.setChecked(values[f.id]===true);else if(f.type==='relation')await node.selectOption({label:String(parentValues[parent.titleField])});else if(f.type==='select')await node.selectOption(String(values[f.id]));else await node.fill(String(values[f.id]));}await page.getByRole('button',{name:'حفظ '+c.singular,exact:true}).click();};
 try{
  await page.route('http://127.0.0.1:3941/domain-test',r=>r.fulfill({contentType:'text/html',body:mobileHtml(project,'domain-'+domain)}));await page.goto('http://127.0.0.1:3941/domain-test');
  await form(parent,parentValues);await page.getByRole('heading',{name:String(parentValues[parent.titleField]),exact:true}).waitFor();await form(child,childValues);await page.getByRole('heading',{name:String(childValues[child.titleField]),exact:true}).waitFor();
  await form(child,{...childValues,[child.titleField]:'تعارض ظاهر في النموذج'});await page.locator('[aria-invalid="true"]').waitFor();await page.getByRole('button',{name:'عودة إلى القائمة',exact:true}).click();assert.equal(await page.locator('.record-card').count(),1);
  await form(child,{...childValues,[releaseField.id]:releaseValue},true);await form(child,{...childValues,[child.titleField]:'موعد بديل'});await page.getByRole('heading',{name:'موعد بديل',exact:true}).waitFor();
  await form(child,{...childValues,[child.titleField]:'موعد بديل',[releaseField.id]:releaseValue},'موعد بديل');await form(child,{...childValues,[child.titleField]:'موعد ثالث'});await page.getByRole('heading',{name:'موعد ثالث',exact:true}).waitFor();
  await page.reload();await visit(child);assert.equal(await page.locator('.record-card').count(),3);assert.equal(await page.locator('html').evaluate(n=>n.scrollWidth>n.clientWidth+1),false);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,domain+'-rules-proof.json'),JSON.stringify({schemas,recordState:state,checks:['bounds','integer','required relation','conditional uniqueness','distinct resource allowed',...(domain==='bookings'?['distinct date allowed','distinct slot allowed']:[]),'duplicate resource labels allowed','self edit','repeated release and rebook','delete and rebook','restore conflict','protected deletion','browser conflict message','browser repeated cancellation and rebook','reload'],errors},null,2));await page.screenshot({path:path.join(out,domain+'.png'),fullPage:true});
 }finally{await browser.close();}
 fs.writeFileSync(path.join(out,domain+'-native-cases.json'),JSON.stringify(nativeCases,null,2));
 return {collections:schemas.length,fields:schemas.reduce((n,c)=>n+c.fields.length,0),rules:schemas.reduce((n,c)=>n+(c.rules?.length||0),0),web:true,persistence:true,nativeCases:nativeCases.length};
}

// Retest an existing local-model artifact without spending another model call.
if(process.argv[1]?.endsWith('mobile-domain-acceptance.ts')&&process.argv[2]){const domain=process.argv[2] as 'library'|'bookings';assert.ok(['library','bookings'].includes(domain));const out='release/mobile-live/domains';console.log(await verifyDomain(domain,JSON.parse(fs.readFileSync(path.join(out,domain+'.json'),'utf8')),out));}
