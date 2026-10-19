import {parseRecordState,mutateRecords} from './mobile-data.js';
import {createLocalClient} from './mobile-local-client.js';

const localStores=new Map();
export async function configureMobileLocalStore(taskId){const client=createLocalClient(taskId);await client.read();localStores.set('loam-mobile-'+taskId+'-records',client);return client;}
export function readRecordCache(key){return localStores.get(key)?.getCached()?.state||parseRecordState(localStorage.getItem(key));}

// The lock covers validation AND the write across all tabs/frames on this origin.
export const commitRecordChange=async(key,schemas,action)=>{
 if(window.__loamCommitRecord)return window.__loamCommitRecord(key,action);
 if(localStores.has(key))return localStores.get(key).records(action);
 if(!navigator.locks?.request)throw Error('الحفظ الآمن غير متاح هنا؛ افتح التطبيق عبر Loam أو HTTPS في متصفح حديث.');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
 try{return await navigator.locks.request('loam-records:'+key,{signal:controller.signal},()=>{
  const result=mutateRecords(parseRecordState(localStorage.getItem(key)),schemas,action);
  if(!Object.keys(result.errors).length){
   localStorage.setItem(key,JSON.stringify(result.state));
   window.dispatchEvent(new CustomEvent('loam-records-changed',{detail:{key}}));
  }
  return result;
 });}catch(error){if(error.name==='AbortError')throw Error('الحفظ مشغول في نافذة أخرى؛ حاول مجددًا. مسودتك محفوظة هنا.');throw error;}
 finally{clearTimeout(timer);}
};

export function subscribeRecords(key,refresh){
 const local=event=>{if(event.detail.key===key)refresh();};
 const remote=event=>{if(event.storageArea===localStorage&&(event.key===key||event.key===null))refresh();};
 window.addEventListener('loam-records-changed',local);
 window.addEventListener('storage',remote);
 return ()=>{window.removeEventListener('loam-records-changed',local);window.removeEventListener('storage',remote);};
}
