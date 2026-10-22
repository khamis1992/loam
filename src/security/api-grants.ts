export interface ApiGrant {
  origin:string;
  paths:string[];
  methods:Array<'GET'|'HEAD'|'POST'>;
  credentialHeaders:string[];
}
const credentialNames=['authorization','apikey','cookie','x-api-key','x-csrf-token','x-xsrf-token'];
export function normalizeApiGrants(value:unknown,frontend:string):ApiGrant[]{
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>5)throw Error('At most five explicit API origins');
  const result=value.map((g):ApiGrant=>{
    if(!g||typeof g!=='object'||typeof g.origin!=='string')throw Error('API grant requires an exact origin');
    const u=new URL(g.origin);
    if(!['http:','https:'].includes(u.protocol)||u.origin!==g.origin||u.origin===frontend||u.username||u.password)throw Error('API origin must be exact and different from the frontend');
    if(!Array.isArray(g.paths)||!g.paths.length||g.paths.length>30||g.paths.some((p:unknown)=>typeof p!=='string'||!p.startsWith('/')||p.startsWith('//')||p.length>500||/[?#%\\]/.test(p)||new URL(p,u.origin).pathname!==p))throw Error('API paths must be exact absolute paths without query, encoding or traversal');
    if(!Array.isArray(g.methods)||!g.methods.length||g.methods.some((m:unknown)=>!['GET','HEAD','POST'].includes(String(m))))throw Error('API methods must explicitly list GET, HEAD or POST');
    if(!Array.isArray(g.credentialHeaders)||g.credentialHeaders.some((h:unknown)=>typeof h!=='string'||!credentialNames.includes(h)))throw Error('API credential headers must be explicitly selected');
    return {origin:u.origin,paths:[...new Set(g.paths as string[])],methods:[...new Set(g.methods as ApiGrant['methods'])],credentialHeaders:[...new Set(g.credentialHeaders as string[])]};
  });
  if(new Set(result.map(g=>g.origin)).size!==result.length)throw Error('API origins must be unique');
  return result;
}
export function matchApiGrant(grants:ApiGrant[],url:string,method:string,resourceType:string,preflightMethod?:string):ApiGrant|undefined{
  if(!['fetch','xhr','other'].includes(resourceType))return;
  try{
    const u=new URL(url);
    if(u.username||u.password||u.hash||/[\\%]/.test(u.pathname)||[...u.searchParams.keys()].some(k=>/^(action|cmd|command|delete|logout|method)$/i.test(k)))return;
    const effective=method==='OPTIONS'?preflightMethod:method;
    return grants.find(g=>g.origin===u.origin&&g.paths.includes(u.pathname)&&g.methods.some(m=>m===effective));
  }catch{return;}
}
export function apiRequestHeaders(request:Record<string,string>,grant:ApiGrant):Record<string,string>{
  const allowed=['accept','accept-language','origin','content-type','access-control-request-method','access-control-request-headers',...grant.credentialHeaders];
  return Object.fromEntries(allowed.filter(k=>request[k]!==undefined).map(k=>[k,request[k]!]));
}
