import {createLocalClient} from './mobile-local-client.js';
export function bridgeMobileCode(frame,{taskId,project,getContext=()=>({project}),onError=()=>{},onScreen=()=>{},onSelect=()=>{},onExit=()=>{}}){
 const key='loam-mobile-'+taskId,records=key+'-records',client=createLocalClient(taskId);
 const send=data=>frame.contentWindow?.postMessage({channel:'loam-mobile-host',...data},'*');
 let queue=Promise.resolve(),disposed=false,lastFailure=null,initEpoch=0;
 async function init(){
  const epoch=++initEpoch;let data,user=null,authRequired=false;
  try{data=await client.read();user=(await client.auth()).user;}catch(error){if(error.status!==401)throw error;authRequired=true;data={state:{version:1,revision:0,collections:{}},values:{},policy:'owner'};}
  const context={...getContext(),services:{policy:data.policy,user,authRequired,requiresImport:!!data.requiresImport}};
  if(!disposed&&epoch===initEpoch)send({type:'init',values:{[key]:JSON.stringify(data.values),[records]:JSON.stringify(data.state)},context});
 }
 const receive=e=>{
  if(e.source!==frame.contentWindow||e.data?.channel!=='loam-mobile-sandbox')return;
  const d=e.data;if(d.type==='ready'){void init().catch(error=>onError(error.message));return;}
  if(d.type==='screen'&&getContext().project.screens.some(s=>s.id===d.id)){onScreen(d.id);return;}
  if(d.type==='select'&&getContext().edit){onSelect(d.id);return;}
  if(d.type==='exit'){onExit();return;}
  if(d.type==='flush'){queue=queue.catch(()=>{}).then(async()=>{try{await client.flush();if(lastFailure)throw lastFailure;send({type:'flush-result',id:d.id,result:{saved:true}});}catch(error){send({type:'flush-result',id:d.id,error:error.message});}});return;}
  if(d.type==='error'){onError(String(d.message).slice(0,2000));return;}
  if(d.type==='storage'){
   if(d.key!==key)return;queue=queue.catch(()=>{}).then(async()=>{try{if(typeof d.value!=='string'||d.value.length>2_500_000)throw Error('قيمة الحفظ غير صالحة');const data=d.patch||JSON.parse(d.value);if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Invalid app values');if(Object.keys(data).length)await client.values(data);lastFailure=null;}catch(error){lastFailure=error;onError(error.message);send({type:'error',message:error.message});}});return;
  }
  if(d.type==='record'&&d.key===records){queue=queue.catch(()=>{}).then(async()=>{try{
   const result=await client.records(d.action);
   if(!disposed)send({type:'record-result',key:records,id:d.id,result});
  }catch(error){if(!disposed)send({type:'record-result',id:d.id,error:error.message});}});}
  if(d.type==='service'){queue=queue.catch(()=>{}).then(async()=>{try{const result=await client.service(d.service,d.body);if(disposed)return;const clean=d.service==='auth'?{user:result.user,ok:result.ok}:result;send({type:'service-result',id:d.id,result:clean});}catch(error){send({type:'service-result',id:d.id,error:error.message});}});}
 };
 const refresh=e=>{if(e.key==='loam-mobile-session-'+taskId){void init().catch(error=>onError(error.message));return;}if(e.key===records||e.detail?.key===records)void client.read().then(data=>{if(!disposed)send({type:'refresh',key:records,value:JSON.stringify(data.state)});}).catch(error=>onError(error.message));};
 const session=e=>{if(e.detail?.taskId===taskId)void init().catch(error=>onError(error.message));};
 addEventListener('message',receive);addEventListener('storage',refresh);addEventListener('loam-records-changed',refresh);addEventListener('loam-local-session-changed',session);addEventListener('loam-local-services-changed',session);
 return()=>{disposed=true;removeEventListener('message',receive);removeEventListener('storage',refresh);removeEventListener('loam-records-changed',refresh);removeEventListener('loam-local-session-changed',session);removeEventListener('loam-local-services-changed',session);};
}
