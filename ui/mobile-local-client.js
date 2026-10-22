const clients=new Map();
export function createLocalClient(taskId){
 if(clients.has(taskId))return clients.get(taskId);
 let token=localStorage.getItem('loam-mobile-session-'+taskId)||'',state,capability='',capTime=0,queue=Promise.resolve();
 const key='loam-mobile-'+taskId,records=key+'-records';
 async function request(route,body,admin=false,retried=false){
  token=localStorage.getItem('loam-mobile-session-'+taskId)||'';
  if(admin&&(!capability||Date.now()-capTime>3300000)){const response=await fetch('/api/mobile/local/admin?taskId='+encodeURIComponent(taskId),{headers:{'X-Loam-Mobile-Admin':'1'}}),data=await response.json();if(!response.ok)throw Error(data.error);capability=data.capability;capTime=Date.now();}
  const headers={};if(token)headers.Authorization='Bearer '+token;if(admin)headers['X-Loam-Mobile-Capability']=capability;if(body)headers['content-type']='application/json';
  const response=await fetch('/api/mobile/local/'+route+(body?'':(route.includes('?')?'&':'?')+'taskId='+encodeURIComponent(taskId)),body?{method:'POST',headers,body:JSON.stringify({...body,taskId})}:{headers});
  if(admin&&response.status===403&&!retried){capability='';return request(route,body,true,true);}
  const data=await response.json();if(!response.ok){const error=Error(data.error||'تعذّر الاتصال بالخدمة المحلية');error.status=response.status;throw error;}return data;
 }
 function publish(data){const changed=JSON.stringify(state)!==JSON.stringify(data);state=data;try{localStorage.setItem(key+'-cache-origin','sqlite');const raw=JSON.stringify(data.state),values=JSON.stringify(data.values);if(localStorage.getItem(records)!==raw)localStorage.setItem(records,raw);if(localStorage.getItem(key)!==values)localStorage.setItem(key,values);}catch{/* SQLite is authoritative; browser cache is optional. */}if(changed)window.dispatchEvent(new CustomEvent('loam-records-changed',{detail:{key:records,taskId}}));return data;}
 function legacy(){let values={},saved;try{if(localStorage.getItem(key+'-cache-origin')!=='sqlite'){values=JSON.parse(localStorage.getItem(key)||'{}');saved=JSON.parse(localStorage.getItem(records)||'null');}if(!Object.keys(values).length&&!Object.values(saved?.collections||{}).some(rows=>rows.length)){const backup=JSON.parse(localStorage.getItem(key+'-legacy-backup')||'null');if(backup)return backup;}}catch{}return{state:saved||{version:1,revision:0,collections:{}},values};}
 let pendingImport=false,legacySnapshot;
 async function read(){const data=await request('state');if(data.policy==='shared'&&data.state.revision===0&&!Object.keys(data.values).length){const prior=legacy();if(Object.keys(prior.values).length||Object.values(prior.state.collections||{}).some(rows=>rows.length)){pendingImport=true;legacySnapshot=prior;state=data;window.dispatchEvent(new CustomEvent('loam-local-import-needed',{detail:{taskId}}));return{...data,...prior,requiresImport:true};}}pendingImport=false;return publish(data);}
 const serial=fn=>{const run=queue.catch(()=>{}).then(fn);queue=run;return run;};
 async function mutate(body){if(pendingImport)throw Error('انقل بيانات هذا التطبيق من المتصفح أولًا عبر قاعدة البيانات ← الجداول.');const current=await request('state');return publish(await request('state',{...body,expectedRevision:current.state.revision}));}
 const client={request,read,legacy,hasLegacy:()=>pendingImport,getCached:()=>state,
  records:mutation=>serial(()=>mutate({action:'records',mutation})),
  values:values=>serial(async()=>{for(let i=0;i<3;i++){try{return await mutate({action:'values',values});}catch(e){if(e.status!==409||i===2)throw e;}}}),
  importLegacy:()=>serial(async()=>{const current=await request('state');if(current.policy!=='shared')throw Error('استيراد البيانات السابقة متاح إلى المساحة المشتركة فقط.');const prior=legacySnapshot||legacy(),data=await request('admin/state',{action:'import',state:prior.state,values:prior.values,expectedRevision:0},true);pendingImport=false;legacySnapshot=null;return publish(data);}),
  auth:async body=>{const data=await request('auth',body);if(body?.action==='logout')token='';else if(data.token)token=data.token;token?localStorage.setItem('loam-mobile-session-'+taskId,token):localStorage.removeItem('loam-mobile-session-'+taskId);if(body){if(pendingImport&&legacySnapshot)localStorage.setItem(key+'-legacy-backup',JSON.stringify(legacySnapshot));state=undefined;pendingImport=false;legacySnapshot=null;localStorage.removeItem(key);localStorage.removeItem(records);window.dispatchEvent(new CustomEvent('loam-local-session-changed',{detail:{taskId}}));}return data;},
  service:async(service,body)=>{if(service==='auth')return client.auth(body);if(service==='files'){
   if(body?.action==='download'){token=localStorage.getItem('loam-mobile-session-'+taskId)||'';const headers=token?{Authorization:'Bearer '+token}:{},response=await fetch('/api/mobile/local/files?taskId='+encodeURIComponent(taskId)+'&id='+encodeURIComponent(body.id),{headers});if(!response.ok)throw Error('تعذّر تنزيل الملف');const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download=decodeURIComponent((response.headers.get('content-disposition')||'').split("filename*=UTF-8''")[1]||'download');link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return{downloaded:true};}
   return request('files',body?.action==='upload'?{action:'upload',name:body.name,data:body.content,type:body.mime||'application/octet-stream'}:body);
  }if(service==='functions'){if(!body||typeof body.name!=='string')throw Error('اختر عملية خادم مسماة');const current=await request('state'),result=await request('functions',{...body.args,name:body.name,expectedRevision:current.state.revision});return result.state?publish(result):result;}throw Error('الخدمة غير متاحة');},
  flush:()=>queue,
 };
 clients.set(taskId,client);return client;
}
