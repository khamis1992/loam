import assert from "node:assert/strict";
import fs from "node:fs";
import { parseAppContract } from "../agent/appVerification.js";
import { BackendSandbox } from "../agent/backendSandbox.js";
import { canonicalRows } from "../agent/sqliteChecks.js";
import { runInstalledCase } from "./installed-bot-case.js";
const previous = JSON.parse(fs.readFileSync("docs/evidence/bot-installed-bookings-live.json","utf8"));
assert.equal(previous.pass,true);
const original = previous.contract;
const contract = structuredClone(original);
const time = (h:string)=>"2026-11-01T"+h+":00:00Z";
const add = (room:string)=>[{action:"fill",selector:"#room",value:room},{action:"fill",selector:"#start",value:time("10")},{action:"fill",selector:"#end",value:time("11")},{action:"click",selector:"#save"}];
const count = (n:number)=>({action:"count",selector:".booking",count:n});
const rows = (rooms:string[])=>rooms.map(room=>[room,time("10"),time("11")]);
const check = (rooms:string[])=>[{database:"/tmp/bookings.sqlite",table:"bookings",columns:["room","start","end"],rows:rows(rooms)}];
contract.scenarios.push(
  {name:"Cancel persisted booking",steps:[...add("A"),count(1),{action:"click",selector:'.booking[data-room="A"] [data-cancel]'},count(0),{action:"reload"},count(0)],sqliteChecks:check([])},
  {name:"Cancel only selected room and reuse slot",steps:[...add("A"),count(1),...add("B"),count(2),{action:"click",selector:'.booking[data-room="A"] [data-cancel]'},count(1),...add("A"),count(2)],sqliteChecks:check(["A","B"])},
);
assert.deepEqual(contract.scenarios.slice(0,6),original.scenarios);
parseAppContract(JSON.stringify(contract));
const prompt=[
 "أكمل تطبيق الحجوزات الموجود في هذه المهمة نفسها؛ حافظ على التصميم والـAPI وقواعد تعارض المواعيد والتحقق من التاريخ والصلاحيات السابقة. أضف إلغاء الحجز فقط مع الاختبارات الجديدة. لا تعِد إنشاء مشروع آخر ولا تحذف الاختبارات القديمة الستة.",
 "أضف POST /api/bookings/cancel بجسم JSON {id}: إذا كان id عددًا صحيحًا موجبًا لحجز موجود فاحذفه من SQLite وأعد 200؛ إذا لم يوجد أو أُلغي سابقًا أعد 404 دون تغيير أي حجز آخر؛ المدخلات غير الصالحة 400. يجب أن تقبل عملية إلغاء واحدة فقط عندما يصل طلبا إلغاء متزامنان للحجز نفسه (200 و404)، ويمكن بعدها إعادة حجز الفترة الملغاة، مع استمرار رفض التعارض مع الحجوزات الأخرى. أبق GET /api/bookings يعيد الحجوزات الحالية فقط.",
 "أضف زر إلغاء عربي لكل صف .booking يحمل data-cancel؛ كل صف يحمل data-room بقيمة الغرفة كي يُختار الصف الصحيح. الإلغاء دون نافذة تأكيد، يعرض رسالة عربية عند النجاح أو الفشل ويحدّث الجدول من الخادم. لا تغيّر المعرفات القديمة. استخدم معاملات واستعلامات مرتبطة.",
 "هذا العقد الجديد يحل محل العقد السابق لهذه الجولة، ويضم اختباراته الستة كما هي واختبارين إضافيين:",
 "احفظ عقد الاختبار التالي دون تغيير: "+JSON.stringify(contract)+".",
 "استخدم أدوات الملفات فقط، ولا تشغّل الخادم على Windows. التشغيل والفحص داخل Docker. لا تدّع دوام البيانات بعد حذف الحاوية.",
].join("\n");
async function probe(workspace:string) {
  const sandbox=await BackendSandbox.start(workspace,"server.mjs");
  try {
    const post=(url:string,data:unknown)=>sandbox.request(url,"POST",{"content-type":"application/json"},Buffer.from(JSON.stringify(data)).toString("base64"));
    const create=(room:string,start=time("10"),end=time("11"))=>post("/api/bookings",{room,start,end});
    assert.equal((await create("A")).status,201); assert.equal((await create("B")).status,201);
    const items=JSON.parse(Buffer.from((await sandbox.request("/api/bookings")).body,"base64").toString()).items;
    const id=items.find((item:{room:string})=>item.room==="A").id;
    assert.ok(Number.isInteger(id)&&id>0);
    const cancel=(value:unknown)=>post("/api/bookings/cancel",{id:value});
    assert.deepEqual((await Promise.all([cancel(id),cancel(id)])).map(r=>r.status).sort(),[200,404]);
    const state=()=>sandbox.readSqlite({database:"/tmp/bookings.sqlite",table:"bookings",columns:["room","start","end"],rows:[]});
    assert.equal(canonicalRows(await state()),canonicalRows(rows(["B"])));
    assert.equal((await create("A")).status,201);
    assert.equal((await create("A",time("10"),time("12"))).status,409);
    for(const invalid of [-1,0,1.5,"1",null]) assert.equal((await cancel(invalid)).status,400);
    assert.equal((await cancel(999999)).status,404);
    assert.equal(canonicalRows(await state()),canonicalRows(rows(["A","B"])));
    return {pass:true,concurrentCancellation:true,rebook:true,otherRoomPreserved:true,invalidIdsRejected:true,rows:await state()};
  } finally {await sandbox.close();}
}
if(process.argv.includes("--dry-run")) {
  fs.writeFileSync("docs/evidence/bot-bookings-continuation-spec.json",JSON.stringify({prompt,contract,status:"prepared, not executed"},null,2));
  console.log("PASS continuation contract preserves all six prior cases and adds two; no task started");
} else {
  const caps=await(await fetch("http://127.0.0.1:3939/api/bot/capabilities")).json() as any;
  assert.ok(caps.applicationVerification.maxScenarios>=8&&caps.acceptanceIntegrity.explicitUserContractAtStart);
  await runInstalledCase({title:"اختبار BOT — إلغاء الحجوزات",taskId:previous.taskId,prompt,contract,output:"docs/evidence/bot-bookings-continuation-live.json",probe});
}
