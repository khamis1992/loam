/** Real local-model acceptance run. Briefs describe products, not JSON IDs or rule syntax. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {buildMobile} from '../mobile/build.js';
import {readMobile,saveMobile} from '../mobile/store.js';
import {OllamaClient} from '../ollama.js';
import {verifyDomain} from './mobile-domain-acceptance.js';
import type {ChatOptions} from '../ollama.js';

const out='release/mobile-live/domains';fs.mkdirSync(out,{recursive:true});
const cases=[
 {id:'library',title:'مكتبة الحي',brief:'ابن تطبيق مكتبة الحي بالعربية لإدارة إعارة نسخ الكتب الفعلية. أريد قسمين رئيسيين فقط: الكتب والإعارات. كل سجل كتاب يمثل نسخة واحدة: عنوان الكتاب، رمز النسخة المطلوب الذي لا يتكرر، وعدد الصفحات المطلوب وهو عدد صحيح لا يقل عن 1. الإعارة سجل مستقل: عنوان الإعارة، نسخة الكتاب المرتبطة المطلوبة، اسم المستعير المطلوب، تاريخ الإعارة المطلوب، تاريخ الاستحقاق المطلوب الذي لا يسبق تاريخ الإعارة، واختيار هل أُعيد الكتاب. امنع وجود إعارتين غير مُعادتين للنسخة نفسها؛ بعد إعادة الكتاب يمكن إعارته مجددًا. أريد قوائم فعلية فيها إضافة وتعديل وبحث وحذف واستعادة، ورسائل توضح سبب رفض البيانات. هذه إدارة محلية لنسخ مفردة دون حسابات أو مخزون عددي أو خدمات سحابية. لا تضف بيانات تجريبية أو أقسامًا أخرى. اجعل النصوص موجزة ومناسبة للمكتبة.'},
 {id:'bookings',title:'موعدي',brief:'ابن تطبيق موعدي بالعربية لإدارة حجوزات خدمات محلية، بقسمين رئيسيين فقط: الخدمات والحجوزات. الخدمة تتضمن اسمًا مطلوبًا، سعرًا مطلوبًا لا يقل عن صفر، ومدة مطلوبة بالدقائق كعدد صحيح بين 15 و180. الحجز يتضمن عنوانًا مطلوبًا، خدمة مرتبطة مطلوبة، تاريخًا مطلوبًا، فترة مطلوبة من 09:00 و10:00 و11:00، وحالة مطلوبة من مؤكد وملغى. امنع حجزين مؤكدين لنفس الخدمة في نفس التاريخ والفترة. اسمح بإعادة حجز الفترة بعد إلغاء الحجز السابق. هذه فترات ثابتة؛ لا أطلب حساب تداخل مدد أو دفعًا أو مزامنة. قوائم الخدمات والحجوزات تدعم الإضافة والتعديل والبحث والحذف والاستعادة. لا تضف بيانات تجريبية أو أقسامًا أخرى. اكتب رسائل تحقق عربية واضحة وتصميمًا مناسبًا للحجوزات.'},
] as const;
const selected=process.argv[2];if(selected&&!cases.some(c=>c.id===selected))throw Error('Choose library or bookings');
const outcomes:any[]=selected&&fs.existsSync(path.join(out,'results.json'))?JSON.parse(fs.readFileSync(path.join(out,'results.json'),'utf8')).filter((r:any)=>r.domain!==selected):[];
for(const item of cases.filter(c=>!selected||c.id===selected)){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-domain-'+item.id+'-')),started=Date.now(),events:unknown[]=[],traces:unknown[]=[];const local=new OllamaClient('http://127.0.0.1:11434');
 const traced={chat:async(options:ChatOptions)=>{const result=await local.chat(options);traces.push({stage:options.messages[0]?.content.includes('DATA CONTRACT')?'data_review':'generation',content:result.content,usage:result.usage});fs.writeFileSync(path.join(out,item.id+'-responses.json'),JSON.stringify(traces,null,2));return result;}};
 const initial=saveMobile(root,{version:1,title:item.title,accent:'#267965',direction:'rtl',screens:[{id:'home',title:'الرئيسية',kind:'primary',blocks:[]}]},0);
 try{
  await buildMobile({root,model:'qwen2.5:14b',expectedRevision:initial.revision,brief:item.brief,signal:AbortSignal.timeout(540000),ollama:traced,emit:event=>{events.push(event);console.log(JSON.stringify({domain:item.id,type:event.type,phase:event.phase,attempt:event.attempt,reason:event.reason}));}});
  const project=readMobile(root)!;fs.writeFileSync(path.join(out,item.id+'.json'),JSON.stringify(project,null,2));
  const checks=await verifyDomain(item.id,project,out);
  outcomes.push({domain:item.id,ok:true,elapsedMs:Date.now()-started,root,checks});
 }catch(error){outcomes.push({domain:item.id,ok:false,elapsedMs:Date.now()-started,root,error:String(error)});console.error(item.id+': '+String(error));}
 fs.writeFileSync(path.join(out,item.id+'-generation.json'),JSON.stringify({model:'qwen2.5:14b',brief:item.brief,events},null,2));
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(outcomes,null,2));
}
console.log(JSON.stringify(outcomes,null,2));if(outcomes.some(x=>!x.ok))process.exitCode=1;
