import {matchApiGrant,type ApiGrant} from './api-grants.js';
export interface AnonymousApiCase {id:string;origin:string;path:string;query:Record<string,string>;collectionPath:string;publicKeyRef?:string;expected:'public'|'private';controlId?:string}
const ref=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v);
export function anonymousApiUrl(c:AnonymousApiCase){const u=new URL(c.path,c.origin);for(const [k,v] of Object.entries(c.query))u.searchParams.set(k,v);return u.href;}
export function normalizeAnonymousApi(value:unknown,grants:ApiGrant[]):AnonymousApiCase[]{
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>15)throw Error('At most 15 anonymous API cases');
  const cases=value.map((c):AnonymousApiCase=>{
    if(!c||!ref(c.id)||!['public','private'].includes(c.expected)||!grants.some(g=>g.origin===c.origin)||typeof c.path!=='string'||!c.path.startsWith('/')||c.path.startsWith('//')||/[?#%\\]/.test(c.path)||new URL(c.path,c.origin).pathname!==c.path)throw Error('Anonymous API case requires id, granted origin and exact path');
    const query=c.query??{};
    if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).length>10||Object.entries(query).some(([k,v])=>!k||k.length>80||/token|password|secret|authorization|cookie|api.?key/i.test(k)||typeof v!=='string'||v.length>300))throw Error('Anonymous API query requires bounded non-secret literal values');
    if(c.publicKeyRef!==undefined&&(!ref(c.publicKeyRef)||!grants.find(g=>g.origin===c.origin)!.credentialHeaders.includes('apikey')))throw Error('Public key requires an explicitly granted apikey header and temporary reference');
    if(typeof c.collectionPath!=='string'||c.collectionPath.length>300||(c.collectionPath!==''&&!c.collectionPath.startsWith('/'))||/~(?:[^01]|$)/.test(c.collectionPath))throw Error('Anonymous API collectionPath must be a JSON Pointer');
    const result={id:c.id,origin:c.origin,path:c.path,query,collectionPath:c.collectionPath,expected:c.expected,...(c.publicKeyRef?{publicKeyRef:c.publicKeyRef}:{}),...(c.controlId?{controlId:c.controlId}:{})};
    if(!matchApiGrant(grants,anonymousApiUrl(result),'GET','fetch'))throw Error('Anonymous API GET outside explicit grants');
    return result;
  });
  if(new Set(cases.map(c=>c.id)).size!==cases.length)throw Error('Anonymous API ids must be unique');
  for(const c of cases)if(c.expected==='private'){
    const control=cases.find(v=>v.id===c.controlId);
    if(!control||control.expected!=='public'||control.origin!==c.origin||control.publicKeyRef!==c.publicKeyRef)throw Error('Private anonymous case requires a public control with the same origin and public key reference');
  }else if(c.controlId!==undefined)throw Error('Public control cannot reference another control');
  return cases;
}
export function anonymousCollection(body:string,pointer:string):{jsonValid:boolean;rows:number|null}{
  let value:unknown;try{value=JSON.parse(body);}catch{return {jsonValid:false,rows:null};}
  for(const key of pointer===''?[]:pointer.slice(1).split('/').map(v=>v.replace(/~1/g,'/').replace(/~0/g,'~'))){
    if(!value||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,key))return {jsonValid:true,rows:null};
    value=(value as Record<string,unknown>)[key];
  }
  return {jsonValid:true,rows:Array.isArray(value)?value.length:null};
}
export function validatePublicKey(value:unknown):string{
  if(typeof value!=='string'||!value||value.length>8192||/[\x00-\x20\x7f]/.test(value)||value.startsWith('sb_secret_'))throw Error('Supply a public application key, not a user or service credential');
  if(value.split('.').length===3){let claims:any;try{claims=JSON.parse(Buffer.from(value.split('.')[1]!,'base64url').toString());}catch{throw Error('Invalid public-key JWT');}if(claims.role!=='anon')throw Error('Only anon-role JWT application keys are supported');}
  return value;
}
