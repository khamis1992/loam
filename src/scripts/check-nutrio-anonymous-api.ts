// Owner-authorized, read-only probe of the specific Nutrio backend.
// Only the application's published client key is used; no user session is read.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const expected='https://loepcagitrijlfksawfm.supabase.co';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
async function get(url:string,headers:Record<string,string>={}){
  const started=Date.now();const response=await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
  const reader=response.body!.getReader();let body='',bytes=0;
  try{const decoder=new TextDecoder();for(;;){const chunk=await reader.read();if(chunk.done){body+=decoder.decode();break;}bytes+=chunk.value.length;if(bytes>1_000_000)throw Error('Response exceeds bound');body+=decoder.decode(chunk.value,{stream:true});}}finally{await reader.cancel();}
  return {status:response.status,body,bytes,durationMs:Date.now()-started};
}
const module=await get('http://127.0.0.1:5173/src/integrations/supabase/client.ts');
if(module.status!==200)throw Error('Local Nutrio client module unavailable');
const assignment=/import\.meta\.env\s*=\s*(\{[^\n]*\});/.exec(module.body);
if(!assignment)throw Error('Published Vite environment was not found; no credential fallback');
const env=JSON.parse(assignment[1]!);const key=env.VITE_SUPABASE_PUBLISHABLE_KEY;
if(env.VITE_SUPABASE_URL!==expected||typeof key!=='string')throw Error('Published backend differs from authorized Nutrio project');
if(!key.startsWith('sb_publishable_')){
  const claims=JSON.parse(Buffer.from(key.split('.')[1]??'','base64url').toString());
  if(claims.role!=='anon'||claims.ref!=='loepcagitrijlfksawfm')throw Error('Refusing non-anonymous or mismatched key');
}
if(process.argv.includes('--platform')){
  const base='http://127.0.0.1:3939';
  const post=async(route:string,body:unknown)=>{const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('Platform request failed: '+r.status);return r.json() as Promise<any>;};
  const {task}=await post('/api/tasks/draft',{mode:'build',title:'Nutrio — API دون حساب'});
  const tables=['public_restaurant_catalog','public_meal_catalog','profiles','restaurants','meals'];
  const anonymousApi=tables.map((table,i)=>({id:table,origin:expected,path:'/rest/v1/'+table,query:{select:'id',limit:'1'},collectionPath:'',expected:i<2?'public':'private',publicKeyRef:'nutrioPublicKey',...(i<2?{}:{controlId:'public_restaurant_catalog'})}));
  const {run}=await post('/api/security/assessments?taskId='+task.id,{target:'http://127.0.0.1:5173/nutrio/welcome',authorized:true,checks:['server_banner'],scope:{seeds:['http://127.0.0.1:5173/'],maxPages:1,maxRequests:3000,maxDepth:0,delayMs:0,timeoutSeconds:180},browser:{enabled:true,maxPages:1,screenshots:false,followRedirects:true,readySelector:'[data-testid="onboarding-signin-btn"]',responseLimitBytes:10000000,totalLimitBytes:200000000,readinessTimeoutMs:30000,networkIdleTimeoutMs:10000,apiGrants:[{origin:expected,paths:tables.map(t=>'/rest/v1/'+t),methods:['GET'],credentialHeaders:['apikey']}],anonymousApi},browserSecrets:{nutrioPublicKey:key}});
  console.log('Started platform task '+task.id+' / run '+run.id);
  for(let n=0;n<200;n++){
    const response=await fetch(base+'/api/security/assessments/'+run.id+'?taskId='+task.id);if(!response.ok)throw Error('Platform observation unavailable; run may still be active: '+run.id);
    const current=await response.json() as any;if(current.run.status!=='running'){
      fs.mkdirSync('output/verification',{recursive:true});fs.writeFileSync('output/verification/nutrio-anonymous-platform.json',JSON.stringify({taskId:task.id,...current},null,2));
      console.log(JSON.stringify({taskId:task.id,runId:run.id,status:current.run.status,proofs:current.run.browser?.proofs.filter((p:any)=>p.kind==='anonymous_api').map((p:any)=>({summary:p.summary,outcome:p.outcome,observations:p.observations,requestIds:p.requestIds}))},null,2));process.exit(0);
    }await new Promise(r=>setTimeout(r,1000));
  }throw Error('Platform observation timeout; inspect existing run '+run.id+' before retrying');
}
const cases=[
  {path:'/auth/v1/user',expectation:'user session required'},
  {path:'/rest/v1/public_restaurant_catalog?select=id&limit=1',expectation:'public positive control'},
  {path:'/rest/v1/public_meal_catalog?select=id&limit=1',expectation:'public positive control'},
  {path:'/rest/v1/profiles?select=id&limit=1',expectation:'no anonymous private rows'},
  {path:'/rest/v1/restaurants?select=id&limit=1',expectation:'private base table denied'},
  {path:'/rest/v1/meals?select=id&limit=1',expectation:'private base table denied'},
];
const observations=[];
for(const c of cases){
  for(const mode of ['no-key','public-client-key'] as const){
    const r=await get(expected+c.path,mode==='public-client-key'?{apikey:key}:{});
    let value:unknown;try{value=JSON.parse(r.body);}catch{}
    const rows=Array.isArray(value)?value.length:undefined;
    const code=value&&typeof value==='object'&&!Array.isArray(value)?(value as Record<string,unknown>).code:undefined;
    observations.push({at:new Date().toISOString(),...c,mode,status:r.status,bytes:r.bytes,durationMs:r.durationMs,bodyHash:sha(r.body),rows,errorCode:typeof code==='string'?code:undefined,
      observation:rows!==undefined?(rows?'rows returned (IDs omitted)':'no rows returned; existence not established'):[401,403].includes(r.status)?'explicit denial':'unclassified response'});
  }
}
const report={createdAt:new Date().toISOString(),backend:expected,method:'GET',userSession:false,publicKeySource:'local published Vite client module',requestCount:observations.length,observations,limitations:['No user accounts or personal browser sessions used.','GET only; no write or login attempt, token forgery or password guessing.','One ID column and at most one row requested per table; values not retained.','Empty rows cannot establish protection of known existing private records.','This targeted transport probe is supplementary to platform browser evidence, not a built-in platform authorization-matrix run.']};
fs.mkdirSync('output/verification',{recursive:true});fs.writeFileSync('output/verification/nutrio-anonymous-api.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
