import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium,type Page} from 'playwright';
import {mobileHtml} from '../mobile/export.js';
import {recordsFixture} from './mobile-records-fixture.js';
import {mutateRecords,parseRecordState,relationLabel} from '../../ui/mobile-data.js';
declare const commitRecordChange:(...args:any[])=>Promise<any>;
// Browser globals used only inside Playwright callbacks; this project targets Node.
declare const window:any,document:any,navigator:any;

const project=structuredClone(recordsFixture),schemas=project.collections!;
schemas[0]!.fields.push({id:'code',label:'الرمز',type:'text'});
schemas[0]!.subtitleField='code';
schemas[0]!.rules=[{id:'unique_code',type:'unique',fields:['code'],message:'الرمز مستخدم بالفعل'}];
project.screens[0]!.blocks=[
 {id:'first',type:'collection',text:'المشاريع الأولى',collectionId:'projects'},
 {id:'second',type:'collection',text:'المشاريع الثانية',collectionId:'projects'},
 {id:'tasks',type:'collection',text:'المهام المرتبطة',collectionId:'tasks'},
];
const dir='release/mobile-live/record-sync';fs.mkdirSync(dir,{recursive:true});
const key='loam-sync-test',storageKey=key+'-records',url='http://127.0.0.1:3941/record-sync-test';
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:640,height:960}});
const errors:string[]=[];
await context.addInitScript(()=>{
 const attached=new Map<string,Set<unknown>>();
 const add=window.addEventListener.bind(window),remove=window.removeEventListener.bind(window);
 window.addEventListener=((name:string,listener:unknown,options:unknown)=>{if(['storage','loam-records-changed'].includes(name)){if(!attached.has(name))attached.set(name,new Set());attached.get(name)!.add(listener);}add(name,listener,options);});
 window.removeEventListener=((name:string,listener:unknown,options:unknown)=>{attached.get(name)?.delete(listener);remove(name,listener,options);});
 (window as any).recordListenerCount=()=>[...attached.values()].reduce((n,set)=>n+set.size,0);
});
await context.route(url,r=>r.fulfill({contentType:'text/html',body:mobileHtml(project,key)}));
const a=await context.newPage(),b=await context.newPage();
for(const page of [a,b])page.on('pageerror',e=>errors.push(e.message));
const commit=(page:Page,action:unknown)=>page.evaluate(async({storageKey,schemas,action})=>{
 try{return await commitRecordChange(storageKey,schemas,action);}catch(e){return {failure:(e as Error).message};}
},{storageKey,schemas,action});
const saved=(page:Page)=>page.evaluate(k=>JSON.parse(localStorage.getItem(k)!),storageKey);
try{
 await Promise.all([a.goto(url),b.goto(url)]);
 const first=a.locator('[data-block-id="first"]'),second=a.locator('[data-block-id="second"]'),tasks=a.locator('[data-block-id="tasks"]');
 await first.getByRole('button',{name:'إضافة مشروع',exact:true}).click();
 await first.getByLabel('عنوان المشروع',{exact:true}).fill('مشروع مشترك');
 await first.getByLabel('الرمز',{exact:true}).fill('A-01');
 await first.getByRole('button',{name:'حفظ مشروع',exact:true}).click();
 await second.getByRole('heading',{name:'مشروع مشترك',exact:true}).waitFor();
 await b.locator('[data-block-id="first"]').getByRole('heading',{name:'مشروع مشترك',exact:true}).waitFor();
 const parent=(await saved(a)).collections.projects[0];

 await tasks.getByRole('button',{name:'إضافة مهمة',exact:true}).click();
 const draft=tasks.getByLabel('عنوان المهمة',{exact:true});await draft.fill('مسودة لا تضيع');
 await commit(b,{type:'save',collectionId:'projects',values:{name:'مشروع مشترك',code:'B-02'}});
 await a.waitForFunction(()=>document.querySelector('[data-block-id="tasks"] select[data-field-id="project"]')?.textContent?.includes('B-02'));
 assert.equal(await draft.inputValue(),'مسودة لا تضيع');assert.equal(await draft.evaluate(n=>n===document.activeElement),true);
 const choices=await tasks.locator('[data-field-id="project"] option').allTextContents();
 assert.ok(choices.includes('مشروع مشترك — الرمز: A-01'));assert.ok(choices.includes('مشروع مشترك — الرمز: B-02'));
 await tasks.locator('[data-field-id="project"]').selectOption(parent.id);
 await tasks.getByRole('button',{name:'حفظ مهمة',exact:true}).click();await tasks.getByRole('heading',{name:'مسودة لا تضيع',exact:true}).waitFor();

 // A related row changes in another tab: list text/search refreshes immediately.
 await commit(b,{type:'save',collectionId:'projects',id:parent.id,expectedUpdatedAt:parent.updatedAt,values:{name:'الاسم المحدث',code:'A-01'}});
 await tasks.getByText('المشروع · الاسم المحدث',{exact:true}).waitFor();
 await tasks.getByRole('searchbox').fill('الاسم المحدث');assert.equal(await tasks.locator('.record-card').count(),1);

 // Both editors opened the same version. Only one may win, and the losing draft survives.
 const updated=(await saved(a)).collections.projects.find((r:any)=>r.id===parent.id);
 await first.locator('[data-record-id="'+parent.id+'"]').getByRole('button',{name:'تعديل مشروع',exact:true}).click();
 await first.getByLabel('عنوان المشروع',{exact:true}).fill('مسودتي المحلية');
 await commit(b,{type:'save',collectionId:'projects',id:parent.id,expectedUpdatedAt:updated.updatedAt,values:{name:'التعديل الآخر',code:'A-01'}});
 await first.getByText(/احتفظنا بمسودتك/).waitFor();
 await first.getByRole('button',{name:'حفظ مشروع',exact:true}).click();await first.getByText('تغيّر السجل في جلسة أخرى؛ أعد فتحه قبل التعديل',{exact:true}).waitFor();
 assert.equal(await first.getByLabel('عنوان المشروع',{exact:true}).inputValue(),'مسودتي المحلية');
 assert.equal((await saved(a)).collections.projects.find((r:any)=>r.id===parent.id).values.name,'التعديل الآخر');
 const staleDelete=await commit(a,{type:'delete',collectionId:'projects',id:parent.id,expectedUpdatedAt:updated.updatedAt});assert.match(staleDelete.failure,/تغيّر السجل/);
 await a.screenshot({path:dir+'/conflict-draft.png',fullPage:true});
 await first.getByRole('button',{name:'عودة إلى القائمة',exact:true}).click();

 // Hold the real lock so all writes queue before reading the shared snapshot.
 await b.evaluate(async k=>{let release!:()=>void;const gate=new Promise<void>(r=>release=r);(window as any).releaseRecordLock=release;await new Promise<void>(ready=>{(window as any).heldRecordLock=navigator.locks.request('loam-records:'+k,async()=>{ready();await gate;});});},storageKey);
 const creates=Array.from({length:20},(_,i)=>commit(i%2?a:b,{type:'save',collectionId:'projects',values:{name:'متزامن '+i,code:'C-'+i}}));
 await b.evaluate(()=>(window as any).releaseRecordLock());
 for(const result of await Promise.all(creates))assert.deepEqual(result.errors,{});
 assert.equal((await saved(a)).collections.projects.length,22);
 const unique=await Promise.all([commit(a,{type:'save',collectionId:'projects',values:{name:'أ',code:'ONLY-ONE'}}),commit(b,{type:'save',collectionId:'projects',values:{name:'ب',code:'ONLY-ONE'}})]);
 assert.equal(unique.filter(r=>r.errors.code).length,1);assert.equal((await saved(a)).collections.projects.filter((r:any)=>r.values.code==='ONLY-ONE').length,1);

 // A failed storage write must not mutate persisted state or strand the queue.
 const before=await saved(a);await a.evaluate(()=>{(window as any).storageSet=Storage.prototype.setItem;Storage.prototype.setItem=()=>{throw new DOMException('quota','QuotaExceededError');};});
 assert.equal((await commit(a,{type:'save',collectionId:'projects',values:{name:'لن يحفظ',code:'QUOTA'}})).failure,'quota');
 await a.evaluate(()=>Storage.prototype.setItem=(window as any).storageSet);assert.deepEqual(await saved(a),before);
 assert.deepEqual((await commit(a,{type:'save',collectionId:'projects',values:{name:'عاد الحفظ',code:'RECOVER'}})).errors,{});

 // A stalled tab cannot leave a save waiting forever or commit it after timeout.
 await b.evaluate(async k=>{let release!:()=>void;const gate=new Promise<void>(r=>release=r);(window as any).releaseRecordLock=release;await new Promise<void>(ready=>{(window as any).heldRecordLock=navigator.locks.request('loam-records:'+k,async()=>{ready();await gate;});});},storageKey);
 const timedOut=await commit(a,{type:'save',collectionId:'projects',values:{name:'يجب ألا يحفظ لاحقًا',code:'TIMEOUT'}});
 assert.match(timedOut.failure,/الحفظ مشغول في نافذة أخرى/);
 await b.evaluate(()=>(window as any).releaseRecordLock());
 assert.ok((await commit(a,{type:'save',collectionId:'projects',values:{name:''}})).errors.name);
 assert.equal((await saved(a)).collections.projects.some((r:any)=>r.values.code==='TIMEOUT'),false);

 // Runtime remounts release old subscriptions (including studio selection/re-render).
 await a.evaluate(({project,key})=>{for(let i=0;i<20;i++)(window as any).mountMobile(document.getElementById('mobile-app'),project,key);},{project,key});
 assert.equal(await a.evaluate(()=>(window as any).recordListenerCount()),6);
 await a.reload();await a.waitForFunction(()=>document.querySelector('[data-block-id="first"] .record-count')?.textContent==='24');
 assert.equal((await saved(a)).revision,27);
 // Unsupported environments fail visibly, never take an unsafe last-writer-wins path.
 await a.evaluate(()=>Object.defineProperty(navigator,'locks',{value:undefined,configurable:true}));
 assert.match((await commit(a,{type:'save',collectionId:'projects',values:{name:'unsafe'}})).failure,/الحفظ الآمن غير متاح/);
 assert.equal((await saved(a)).revision,27);
 assert.deepEqual(errors,[]);
 fs.writeFileSync(dir+'/verification.json',JSON.stringify({sameScreenLists:'passed',crossTab:'passed',relationLabels:'passed',draftAndFocus:'preserved',staleSaveAndDelete:'rejected',concurrentCreates:20,concurrentUnique:'one winner',quotaRecovery:'passed',lockTimeout:'cancelled without delayed write',remounts:20,activeListeners:6,reload:'passed',unsafeEnvironment:'write refused',errors},null,2));
 console.log('PASS record synchronization: multiple views/tabs, relation labels, preserved draft/focus, stale edits/deletes, 20 queued writes, uniqueness race, quota recovery, lifecycle cleanup, reload, safe unsupported environment');
}finally{await browser.close();}

// Same title AND details still produce distinct labels; timestamps cannot repeat.
let state=mutateRecords(parseRecordState(null),schemas,{type:'save',collectionId:'projects',values:{name:'same'}}).state;
state=mutateRecords(state,schemas,{type:'save',collectionId:'projects',values:{name:'same'}}).state;
const rows=state.collections.projects!;assert.notEqual(relationLabel(schemas[0]!,rows[0]!,rows),relationLabel(schemas[0]!,rows[1]!,rows));
const row=rows[0]!;row.updatedAt='2099-01-01T00:00:00.000Z';
state=mutateRecords(state,schemas,{type:'save',collectionId:'projects',id:row.id,expectedUpdatedAt:row.updatedAt,values:{name:'changed'}}).state;
assert.ok(state.collections.projects![0]!.updatedAt>row.updatedAt);
console.log('PASS ambiguous labels and monotonic edit versions under clock rollback');
