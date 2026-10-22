// This bootstrap runs only inside the opaque-origin application iframe.
window.__loamReady=new Promise(resolve=>{
 let cache={},counter=0;const pending=new Map();
 const send=data=>parent.postMessage({channel:'loam-mobile-sandbox',...data},'*');
 window.__loamReport=error=>send({type:'error',message:String(error?.message||error).slice(0,2000)});
 Object.defineProperty(window,'localStorage',{value:{getItem:key=>cache[key]??null,setItem(key,value){let patch;try{const before=JSON.parse(cache[key]||'{}'),next=JSON.parse(String(value));patch=Object.fromEntries(Object.entries(next).filter(([name,v])=>before[name]!==v));}catch{}cache[key]=String(value);send({type:'storage',key,value:String(value),patch});},removeItem(key){delete cache[key];send({type:'storage',key,value:null});}}});
 const request=(type,data={})=>new Promise((accept,reject)=>{const id=++counter,timer=setTimeout(()=>{pending.delete(id);reject(Error('انتهت مهلة الحفظ؛ أعد المحاولة.'));},15000);pending.set(id,{accept,reject,timer});send({type,...data,id});});
 window.__loamCommitRecord=(key,action)=>request('record',{key,action});
 window.__loamFlush=()=>request('flush');
 window.loam=Object.freeze({
  auth:Object.freeze({register:(email,password)=>request('service',{service:'auth',body:{action:'register',email,password}}),login:(email,password)=>request('service',{service:'auth',body:{action:'login',email,password}}),logout:()=>request('service',{service:'auth',body:{action:'logout'}}),me:()=>request('service',{service:'auth'})}),
  files:Object.freeze({list:()=>request('service',{service:'files'}),upload:(name,content,mime)=>request('service',{service:'files',body:{action:'upload',name,content,mime}}),download:id=>request('service',{service:'files',body:{action:'download',id}})}),
  functions:Object.freeze({invoke:(name,args)=>request('service',{service:'functions',body:{name,args}})})
 });
 addEventListener('message',e=>{
  if(e.source!==parent||e.data?.channel!=='loam-mobile-host')return;const data=e.data;
  if(data.type==='init'){cache=data.values;window.__loamContext=data.context||{};resolve();window.__loamRender?.(window.__loamContext);}
  if(data.type==='render'){window.__loamContext={...data.context,services:window.__loamContext?.services};window.__loamRender?.(window.__loamContext);}
  if(data.type==='service-result'||data.type==='flush-result'){const item=pending.get(data.id);if(!item)return;clearTimeout(item.timer);pending.delete(data.id);if(data.error)item.reject(Error(data.error));else item.accept(data.result);}
  if(data.type==='record-result'){const item=pending.get(data.id);if(!item)return;clearTimeout(item.timer);pending.delete(data.id);if(data.error)item.reject(Error(data.error));else{cache[data.key]=JSON.stringify(data.result.state);item.accept(data.result);}}
  if(data.type==='refresh'){cache[data.key]=data.value;dispatchEvent(new CustomEvent('loam-records-changed',{detail:{key:data.key}}));}
  if(data.type==='error')window.__loamReport(data.message);
 });
 addEventListener('error',e=>window.__loamReport(e.message));addEventListener('unhandledrejection',e=>window.__loamReport(e.reason));
 send({type:'ready'});
 addEventListener('keydown',e=>{if(e.key==='Escape')send({type:'exit'});});
});
