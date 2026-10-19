import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium,type Page} from 'playwright';
declare const window:any,navigator:any,document:any;
const base=process.env.MOBILE_TEST_BASE||'http://127.0.0.1:3941';
const info=JSON.parse(fs.readFileSync('release/mobile-live/domains/rule-audit/bookings-live.json','utf8'));
const response=await fetch(base+'/api/mobile?taskId='+info.taskId);assert.ok(response.ok);
const {project}=await response.json() as any;
const expected=JSON.parse(fs.readFileSync('release/mobile-live/domains/rule-audit/bookings.json','utf8'));
assert.deepEqual(project.collections,expected.collections,'Exercise the real locally generated and audited booking schema');
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:420,height:900}});
const errors:string[]=[];const a=await context.newPage(),b=await context.newPage();for(const p of [a,b])p.on('pageerror',e=>errors.push(e.message));
const key='loam-mobile-'+info.taskId+'-records',url=base+'/api/mobile/preview?taskId='+info.taskId;
const dir='release/mobile-live/record-sync';fs.mkdirSync(dir,{recursive:true});
async function booking(p:Page,title:string,service:string){
 await p.getByRole('button',{name:'إضافة حجز',exact:true}).click();await p.getByLabel('عنوان الحجز',{exact:true}).fill(title);
 await p.getByLabel('الخدمة',{exact:true}).selectOption({label:service});await p.getByLabel('التاريخ',{exact:true}).fill('2026-11-01');
 await p.getByLabel('الفترة',{exact:true}).selectOption('09:00');await p.getByLabel('الحالة',{exact:true}).selectOption('مؤكد');
}
try{
 await Promise.all([a.goto(url),b.goto(url)]);
 for(const [price,duration]of [['120','60'],['180','90']]){
  await a.getByRole('button',{name:'إضافة خدمة',exact:true}).click();await a.getByLabel('اسم الخدمة',{exact:true}).fill('جلسة تخطيط');
  await a.getByLabel('السعر',{exact:true}).fill(price!);await a.getByLabel('المدة',{exact:true}).fill(duration!);
  await a.getByRole('button',{name:'حفظ خدمة',exact:true}).click();await a.getByRole('button',{name:'إضافة خدمة',exact:true}).waitFor();
 }
 await b.getByRole('heading',{name:'جلسة تخطيط',exact:true}).nth(1).waitFor();
 for(const p of [a,b])await p.locator('nav').getByRole('button',{name:'الحجوزات',exact:true}).click();
 const service='جلسة تخطيط — السعر: 120 · المدة: 60';
 await booking(a,'حجز النافذة الأولى',service);await booking(b,'حجز النافذة الثانية',service);
 await a.screenshot({path:dir+'/booking-form.png',fullPage:true});
 await a.evaluate(async k=>{let release!:()=>void;const gate=new Promise<void>(r=>release=r);window.releaseBookingLock=release;await new Promise<void>(ready=>{window.bookingLock=navigator.locks.request('loam-records:'+k,async()=>{ready();await gate;});});},key);
 await Promise.all([a.getByRole('button',{name:'حفظ حجز',exact:true}).click(),b.getByRole('button',{name:'حفظ حجز',exact:true}).click()]);
 for(const p of [a,b]){assert.equal(await p.locator('.record-workspace').getAttribute('aria-busy'),'true');await p.getByText('جارٍ حفظ التغيير…',{exact:true}).waitFor();}
 await a.evaluate(()=>window.releaseBookingLock());
 for(const p of [a,b])await p.waitForFunction(()=>!document.querySelector('[aria-busy="true"]'));
 const state=await a.evaluate(k=>JSON.parse(localStorage.getItem(k)!),key);assert.equal(state.collections.bookings.length,1);
 const winner=await a.getByRole('button',{name:'إضافة حجز',exact:true}).count()?a:b,loser=winner===a?b:a;
 await loser.getByText('هذا الحجز موجود بالفعل',{exact:true}).waitFor();assert.ok(await loser.getByLabel('عنوان الحجز',{exact:true}).inputValue());
 await winner.getByRole('button',{name:'تعديل حجز',exact:true}).click();await winner.getByLabel('الحالة',{exact:true}).selectOption('ملغى');
 await winner.getByRole('button',{name:'حفظ حجز',exact:true}).click();await winner.getByText('الحالة · ملغى',{exact:true}).waitFor();
 // Same retained draft now succeeds because the other tab released the slot.
 await loser.getByRole('button',{name:'حفظ حجز',exact:true}).click();await loser.getByRole('button',{name:'إضافة حجز',exact:true}).waitFor();
 await winner.locator('.record-card').nth(1).waitFor();
 await booking(winner,'حجز الخدمة الثانية','جلسة تخطيط — السعر: 180 · المدة: 90');
 await winner.getByRole('button',{name:'حفظ حجز',exact:true}).click();await winner.locator('.record-card').nth(2).waitFor();
 await loser.locator('.record-card').nth(2).waitFor();await loser.reload();await loser.locator('nav').getByRole('button',{name:'الحجوزات',exact:true}).click();await loser.locator('.record-card').nth(2).waitFor();
 await loser.screenshot({path:dir+'/booking-synced.png',fullPage:false});
 const final=await loser.evaluate(k=>JSON.parse(localStorage.getItem(k)!),key);
 assert.equal(final.collections.bookings.filter((r:any)=>r.values.status==='مؤكد').length,2);
 assert.equal(new Set(final.collections.bookings.filter((r:any)=>r.values.status==='مؤكد').map((r:any)=>r.values.service)).size,2);
 assert.deepEqual(errors,[]);
 fs.writeFileSync(dir+'/booking-proof.json',JSON.stringify({taskId:info.taskId,projectRevision:project.revision,modelSource:'existing qwen2.5:14b project after requirement audit',runtime:'live HTTP preview',sameSlotRace:'one winner; loser retained draft',cancelAndRetry:'passed',sameNameDifferentService:'distinct IDs saved at same time',reload:'3 rows retained, 2 confirmed with distinct services',userData:'isolated browser context; no live records modified',errors},null,2));
 console.log('PASS live model-generated booking app: real HTTP export, two same-name services, simultaneous same-slot saves, one rejected draft, cancellation/retry, distinct resource identities, cross-tab refresh and reload');
}finally{await browser.close();}
