import fs from "node:fs";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import { taskPath } from "../server/taskWorkspace.js";
import { inScope, type CampaignScope, type RequestEvidence } from "./scope.js";
import { inspectPage } from "./discovery.js";
import type { PentestFinding } from "../tools/pentest.js";
import { coverageKey } from "./findings.js";
import {normalizeApiGrants,matchApiGrant,apiRequestHeaders,type ApiGrant} from './api-grants.js';
import {newXssCanary,xssTargetUrl,type XssReflectedCase} from './xss-reflected.js';
import {normalizeCsrfCases,csrfHarnessHtml,type CsrfCase} from './csrf.js';
import {normalizeStoredXssCases,injectCanaryField,type StoredXssCase} from './xss-stored.js';
import {BrowserFrontier,type BrowserDiscovery} from './browser-frontier.js';
import {normalizeAnonymousApi,anonymousApiUrl,anonymousCollection,validatePublicKey,type AnonymousApiCase} from './anonymous-api.js';
import {corsResponseAllowed,corsUnsafeHeaders,corsPreflightAllowed} from './cors.js';

class BrowserResponseLimitError extends Error {
  constructor(public limitKind:'response'|'campaign'){super('Browser response size limit reached');}
}

export type BrowserStep = {action:"navigate";path:string}|{action:"click"|"assertVisible";selector:string}|{action:"fill";selector:string;secretRef:string};
export interface TestAccount {id:string;login:BrowserStep[];witness:{path:string;selector:string;textRef:string};bearerRef?:string;apiCredentials?:Array<{origin:string;headers:Record<string,string>;identityRef:string}>}
export interface AuthorizationCase {markerPath?:string;method?:'GET'|'POST';bodyRef?:string;id:string;path:string;kind:'ui'|'api';selector:string;deniedSelector:string;markerRef:string;allowed:string[];denied:string[];api?:{origin:string;identityPath:string;identityField:string}}
export interface BrowserOptions {
  enabled: boolean; domCanary: boolean; framing: boolean; screenshots: boolean;
  maxPages: number; settleMs: number; readySelector: string;
  readyRoutes?: Array<{path:string;selector:string}>;
  responseLimitBytes:number;totalLimitBytes:number;readinessTimeoutMs:number;networkIdleTimeoutMs:number;
  accessAssertions: Array<{ path: string; selector: string; deniedSelector: string }>;
  postPaths: string[]; followRedirects: boolean;
  login: BrowserStep[]; flows: Array<{name:string;steps:BrowserStep[]}>;
  accounts:TestAccount[]; authorization:AuthorizationCase[];
  apiGrants:ApiGrant[];
  xssReflected?:XssReflectedCase[];
  csrf?:CsrfCase[];
  csrfCookieSameSite?:"Lax"|"Strict"|"None";
  xssStored?:StoredXssCase[];
  anonymousApi?:AnonymousApiCase[];
}
export interface BrowserProof {
  id: string; at: string; kind: "render" | "dom_canary" | "framing" | "access" | "login" | "flow" | 'session' | 'authorization' | 'anonymous_api' | 'xss_reflected' | 'csrf' | 'xss_stored';
  target: string; outcome: "observed" | "not_observed" | "inconclusive";
  summary: string; requestIds: string[]; observations: Record<string,string|number|boolean>;
  artifact?: { path: string; sha256: string; masked: boolean };
}
export interface BrowserResult {
  engine: string; version: string; pages: Array<{url:string;finalUrl?:string;routeChanged?:boolean;links:number;forms:number;complete:boolean}>;
  proofs: BrowserProof[]; blocked: Array<{url:string;reason:string}>; incomplete: boolean;
  resources?:{receivedBytes:number;responseLimitBytes:number;totalLimitBytes:number};
  discovery?:BrowserDiscovery;
}
export const blankBrowserOptions = ():BrowserOptions => ({enabled:false,domCanary:false,framing:false,screenshots:true,maxPages:5,settleMs:750,readySelector:"",responseLimitBytes:2_000_000,totalLimitBytes:20_000_000,readinessTimeoutMs:10000,networkIdleTimeoutMs:5000,accessAssertions:[],postPaths:[],followRedirects:false,login:[],flows:[],accounts:[],authorization:[],apiGrants:[],xssReflected:[],csrf:[],csrfCookieSameSite:"Lax",xssStored:[]});
export function normalizeBrowserOptions(input:unknown,scope:CampaignScope):BrowserOptions {
  if(input===undefined)return blankBrowserOptions();
  if(!input||typeof input!=="object"||Array.isArray(input))throw Error("Browser options must be an object");
  const raw=input as Record<string,unknown>,base=blankBrowserOptions();
  base.apiGrants=normalizeApiGrants(raw.apiGrants,scope.seeds[0]?new URL(scope.seeds[0]).origin:'');
  if(raw.anonymousApi!==undefined)base.anonymousApi=normalizeAnonymousApi(raw.anonymousApi,base.apiGrants);
  if(base.apiGrants.length&&new Set(scope.seeds.map(s=>new URL(s).origin)).size!==1)throw Error('API grants require a single frontend origin');
  for(const field of ["enabled","domCanary","framing","screenshots","followRedirects"] as const){if(raw[field]!==undefined){if(typeof raw[field]!=="boolean")throw Error("Invalid browser option: "+field);base[field]=raw[field];}}
  for(const [field,min,max] of [["maxPages",1,10],["settleMs",250,5000],['responseLimitBytes',100_000,10_000_000],['totalLimitBytes',1_000_000,200_000_000],['readinessTimeoutMs',1000,60000],['networkIdleTimeoutMs',1000,30000]] as const){if(raw[field]!==undefined){const value=raw[field];if(typeof value!=="number"||!Number.isInteger(value)||value<min||value>max)throw Error("Invalid browser limit: "+field);base[field]=value;}}
  if(base.responseLimitBytes>base.totalLimitBytes)throw Error('Response limit cannot exceed campaign resource limit');
  if(raw.readySelector!==undefined){if(typeof raw.readySelector!=="string"||raw.readySelector.length>300)throw Error("Invalid browser readiness selector");base.readySelector=raw.readySelector;}
  const assertions=raw.accessAssertions??[];
  if(!Array.isArray(assertions)||assertions.length>10)throw Error("At most 10 browser access assertions");
  base.accessAssertions=assertions.map(item=>{
    if(!item||typeof item!=="object"||typeof item.path!=="string"||!item.path.startsWith("/")||item.path.startsWith("//")||typeof item.selector!=="string"||!item.selector.trim()||item.selector.length>300||typeof (item.deniedSelector??"")!=="string"||(item.deniedSelector??"").length>300)throw Error("Access assertions need a scoped path and a CSS selector");
    if(!scope.seeds[0]||!browserInScope(scope,new URL(item.path,scope.seeds[0]).href))throw Error("Browser assertion outside scope");
    return {path:item.path,selector:item.selector,deniedSelector:item.deniedSelector??""};
  });
  const scopedPath=(value:unknown):value is string=>typeof value==="string"&&value.length<=2000&&value.startsWith("/")&&!value.startsWith("//")&&!!scope.seeds[0]&&browserInScope(scope,new URL(value,scope.seeds[0]).href);
  if(raw.readyRoutes!==undefined){
    if(!Array.isArray(raw.readyRoutes)||raw.readyRoutes.length>100)throw Error('At most 100 route readiness rules');
    if(raw.readyRoutes.length&&new Set(scope.seeds.map(s=>new URL(s).origin)).size!==1)throw Error('Route readiness rules require one frontend origin');
    base.readyRoutes=raw.readyRoutes.map(r=>{
      if(!r||!scopedPath(r.path)||/[?#]/.test(r.path)||new URL(r.path,scope.seeds[0]).pathname!==r.path||typeof r.selector!=='string'||!r.selector.trim()||r.selector.length>300)throw Error('Route readiness requires an exact scoped path and nonempty selector');
      return {path:r.path,selector:r.selector.trim()};
    });
    if(new Set(base.readyRoutes.map(r=>r.path)).size!==base.readyRoutes.length)throw Error('Duplicate route readiness path');
  }
  if(raw.postPaths!==undefined){if(!Array.isArray(raw.postPaths)||raw.postPaths.length>20||raw.postPaths.some(p=>!scopedPath(p)||/[?#]/.test(p)))throw Error("POST allowlist requires at most 20 exact scoped paths without query or fragment");base.postPaths=[...new Set(raw.postPaths as string[])];}
  const steps=(value:unknown):BrowserStep[]=>{
    if(!Array.isArray(value)||value.length>30)throw Error("A browser flow supports at most 30 steps");
    return value.map(s=>{
      if(!s||typeof s!=="object")throw Error("Invalid browser step");
      if(s.action==="navigate"&&scopedPath(s.path))return {action:s.action,path:s.path};
      if(typeof s.selector!=="string"||!s.selector.trim()||s.selector.length>300)throw Error("Browser step requires a CSS selector");
      if(s.action==="click"||s.action==="assertVisible")return {action:s.action,selector:s.selector};
      if(s.action==="fill"&&typeof s.secretRef==="string"&&/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(s.secretRef))return {action:s.action,selector:s.selector,secretRef:s.secretRef};
      throw Error("Allowed browser steps: navigate, click, fill with secretRef, assertVisible");
    });
  };
  base.login=steps(raw.login??[]);
  if(base.login.length&&base.login.at(-1)?.action!=="assertVisible")throw Error("Login must end with an authenticated visible-element assertion");
  if(!Array.isArray(raw.flows??[])||((raw.flows??[]) as unknown[]).length>5)throw Error("At most 5 browser flows");
  base.flows=((raw.flows??[]) as any[]).map(f=>{if(!f||typeof f.name!=="string"||!f.name.trim()||f.name.length>80)throw Error("Flow needs a name (maximum 80 characters)");const flow=steps(f.steps);if(!flow.length||flow.at(-1)?.action!=="assertVisible")throw Error("Flow must end with a visible-element assertion");return {name:f.name,steps:flow};});
  if(new Set(base.flows.map(f=>f.name)).size!==base.flows.length)throw Error('Flow names must be unique');
  const ref=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(v);
  const selector=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=300;
  if(raw.xssReflected!==undefined){
    if(!Array.isArray(raw.xssReflected)||raw.xssReflected.length>10)throw Error("At most 10 reflected XSS cases");
    base.xssReflected=raw.xssReflected.map((c:XssReflectedCase)=>{
      if(!c||typeof c!=='object'||!ref(c.id))throw Error("Reflected XSS case requires id");
      if(typeof c.path!=='string'||!scopedPath(c.path)||/[?#]/.test(c.path)||new URL(c.path,scope.seeds[0]).pathname!==c.path)throw Error("Reflected XSS case requires an exact scoped path without query or fragment");
      if(typeof c.param!=='string'||!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(c.param)||/^(?:action|cmd|command|delete|logout|method)$/i.test(c.param))throw Error("Reflected XSS case requires a safe parameter name");
      return {id:c.id,path:c.path,param:c.param};
    });
    if(new Set(base.xssReflected.map(c=>c.id)).size!==base.xssReflected.length)throw Error("Reflected XSS case ids must be unique");
    if(base.xssReflected.length&&!base.enabled)throw Error("Reflected XSS checks require the browser engine");
  }
  if(raw.csrf!==undefined){
    base.csrf=normalizeCsrfCases(raw.csrf,scope,base);
    if(base.csrf.length&&!base.enabled)throw Error("CSRF checks require the browser engine");
  }
  if(raw.xssStored!==undefined){
    base.xssStored=normalizeStoredXssCases(raw.xssStored,scope,base);
    if(base.xssStored.length&&!base.enabled)throw Error("Stored XSS checks require the browser engine");
  }
  if(raw.csrfCookieSameSite!==undefined){
    if(!["Lax","Strict","None"].includes(String(raw.csrfCookieSameSite)))throw Error("CSRF cookie SameSite must be Lax, Strict or None");
    base.csrfCookieSameSite=raw.csrfCookieSameSite as BrowserOptions["csrfCookieSameSite"];
  }
  if(!Array.isArray(raw.accounts??[])||((raw.accounts??[]) as unknown[]).length>5)throw Error('At most 5 test accounts');
  base.accounts=((raw.accounts??[]) as any[]).map(a=>{
    if(!a||!ref(a.id)||!a.witness||!scopedPath(a.witness.path)||!selector(a.witness.selector)||!ref(a.witness.textRef)||(a.bearerRef!==undefined&&!ref(a.bearerRef)))throw Error('Account requires id and scoped identity witness with textRef');
    const login=steps(a.login);if(!login.length||login.at(-1)?.action!=='assertVisible')throw Error('Account login must end with assertVisible');
    if(!Array.isArray(a.apiCredentials??[])||(a.apiCredentials??[]).length>5)throw Error('At most five account API credentials');
    const apiCredentials=(a.apiCredentials??[]).map((v:any)=>{
      const grant=base.apiGrants.find(g=>g.origin===v?.origin);
      if(!grant||!ref(v.identityRef)||!v.headers||typeof v.headers!=='object'||Array.isArray(v.headers)||Object.entries(v.headers).some(([h,r])=>!['authorization','apikey','x-api-key'].includes(h)||!grant.credentialHeaders.includes(h)||!ref(r)))throw Error('Account API credentials require granted headers, secret references and identityRef');
      return {origin:v.origin,headers:v.headers as Record<string,string>,identityRef:v.identityRef};
    });
    if(new Set(apiCredentials.map((v:any)=>v.origin)).size!==apiCredentials.length)throw Error('Duplicate account API origin');
    return {id:a.id,login,witness:{path:a.witness.path,selector:a.witness.selector,textRef:a.witness.textRef},...(a.bearerRef?{bearerRef:a.bearerRef}:{}),...(apiCredentials.length?{apiCredentials}:{})};
  });
  const ids=new Set(base.accounts.map(a=>a.id));if(ids.size!==base.accounts.length)throw Error('Account ids must be unique');
  if(!Array.isArray(raw.authorization??[])||((raw.authorization??[]) as unknown[]).length>10)throw Error('At most 10 authorization cases');
  base.authorization=((raw.authorization??[]) as any[]).map(c=>{
    if(!c||!ref(c.id)||!['ui','api'].includes(c.kind))throw Error('Authorization case requires id, kind and scoped path');
    const method=c.method??'GET';
    if(!['GET','POST'].includes(method)||(c.kind!=='api'&&(c.method!==undefined||c.bodyRef!==undefined)))throw Error('Authorization method must be GET or POST for API cases');
    if(method==='POST'&&!ref(c.bodyRef))throw Error('POST authorization requires JSON bodyRef');
    if(method==='GET'&&c.bodyRef!==undefined)throw Error('GET authorization cannot include a body');
    if(c.api!==undefined){
      const exact=(p:unknown,verb:string)=>typeof p==='string'&&p.startsWith('/')&&!p.startsWith('//')&&!/[?#%\\]/.test(p)&&new URL(p,c.api.origin).pathname===p&&!!matchApiGrant(base.apiGrants,new URL(p,c.api.origin).href,verb,'fetch');
      if(c.kind!=='api'||!c.api||!base.apiGrants.some(g=>g.origin===c.api.origin)||!exact(c.path,method)||!exact(c.api.identityPath,'GET')||typeof c.api.identityField!=='string'||!ref(c.api.identityField))throw Error('Cross-origin case requires a granted request method/path and GET identity path');
    }else if(!scopedPath(c.path))throw Error('Authorization path outside scope');
    if(method==='POST'&&(!c.path||/[?#]/.test(c.path)||(!c.api&&!base.postPaths.includes(c.path))))throw Error('POST authorization requires an exact allowed path');
    if(c.kind==='ui'&&(!selector(c.selector)||!selector(c.deniedSelector)))throw Error('UI case requires protected and denial selectors');
    if(c.markerPath!==undefined&&(c.kind!=='api'||typeof c.markerPath!=='string'||c.markerPath.length>300||(c.markerPath!==''&&!c.markerPath.startsWith('/'))||/~(?:[^01]|$)/.test(c.markerPath)))throw Error('API markerPath must be a JSON Pointer');
    if(c.kind==='api'&&!ref(c.markerRef))throw Error('API case requires a known protected data markerRef');
    for(const group of [c.allowed,c.denied])if(!Array.isArray(group)||!group.length||group.some((id:unknown)=>typeof id!=='string'||!ids.has(id))||new Set(group).size!==group.length)throw Error('Case requires explicit known allowed and denied accounts');
    if(c.allowed.some((id:string)=>c.denied.includes(id)))throw Error('Allowed and denied accounts overlap');
    if(c.api&&[...c.allowed,...c.denied].some(id=>!base.accounts.find(a=>a.id===id)?.apiCredentials?.some(v=>v.origin===c.api.origin)))throw Error('Every account requires API credentials and expected API identity');
    return {...(c.markerPath!==undefined?{markerPath:c.markerPath}:{}),...(method==='POST'?{method:'POST' as const,bodyRef:c.bodyRef}:{}),id:c.id,path:c.path,kind:c.kind,selector:c.kind==='ui'?c.selector:'',deniedSelector:c.kind==='ui'?c.deniedSelector:'',markerRef:c.kind==='api'?c.markerRef:'',allowed:c.allowed,denied:c.denied,...(c.api?{api:{origin:c.api.origin,identityPath:c.api.identityPath,identityField:c.api.identityField}}:{})};
  });
  if(new Set(base.authorization.map(c=>c.id)).size!==base.authorization.length||base.authorization.reduce((n,c)=>n+c.allowed.length+c.denied.length,0)>40)throw Error('Authorization ids must be unique; maximum 40 account/case pairs');
  if(base.accounts.length&&(!base.enabled||new Set(scope.seeds.map(s=>new URL(s).origin)).size!==1))throw Error('Multi-account testing requires an enabled browser and one approved origin');
  if((base.login.length||base.postPaths.length||base.flows.length)&&new Set(scope.seeds.map(s=>new URL(s).origin)).size!==1)throw Error("Login, POST and SPA flows require exactly one approved origin");
  if(base.enabled&&!scope.seeds.length)throw Error("Browser assessment requires a target");
  if(base.anonymousApi?.length&&!base.enabled)throw Error('Anonymous API checks require the browser engine');
  return base;
}
export function browserInScope(scope:CampaignScope,input:string):boolean {
  try {
    const u=new URL(input);if(!["http:","https:"].includes(u.protocol))return false;
    // Query-bearing resources stay under the same approved path. Values are never persisted.
    if([...u.searchParams].some(([key])=>/^(?:action|cmd|command|delete|logout|method)$/i.test(key)))return false;
    u.search="";u.hash="";return inScope(scope,u.href);
  }catch{return false;}
}
function publicUrl(input:string):string {try{const u=new URL(input);u.search="";u.hash="";u.username="";u.password="";return u.href;}catch{return "[unsupported URL]";}}
const harness="http://loam-browser-audit.invalid/";
const hash=(data:string|Buffer)=>createHash("sha256").update(data).digest("hex");
export function normalizeBrowserSecrets(value:unknown,options:BrowserOptions):Record<string,string>{
  if(value!==undefined&&(!value||typeof value!=="object"||Array.isArray(value)))throw Error("Browser secrets must be a map");
  const values=value as Record<string,unknown>|undefined, result:Record<string,string>={};
  for(const c of options.anonymousApi??[])if(c.publicKeyRef)result[c.publicKeyRef]=validatePublicKey(values?.[c.publicKeyRef]);
  for(const step of [...options.login,...options.flows.flatMap(f=>f.steps),...options.accounts.flatMap(a=>a.login)])if(step.action==="fill"){
    const v=values?.[step.secretRef];if(typeof v!=="string"||!v||v.length>8192)throw Error("Supply fresh browser input: "+step.secretRef);result[step.secretRef]=v;
  }
  for(const key of [...options.accounts.flatMap(a=>[a.witness.textRef,...(a.bearerRef?[a.bearerRef]:[])]),...options.authorization.filter(c=>c.kind==='api').map(c=>c.markerRef)]){const v=values?.[key];if(typeof v!=='string'||!v.trim()||v.length>8192)throw Error('Supply fresh browser input: '+key);result[key]=v;}
  const identities=options.accounts.map(a=>result[a.witness.textRef]);if(new Set(identities).size!==identities.length)throw Error('Each account must have a distinct expected identity');
  for(const c of options.authorization)if(c.method==='POST'){
    const body=values?.[c.bodyRef!];if(typeof body!=='string'||Buffer.byteLength(body)>8192)throw Error('POST authorization body must be JSON up to 8192 bytes');
    let parsed:unknown;try{parsed=JSON.parse(body);}catch{throw Error('POST authorization body must be valid JSON');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('POST authorization body must be a JSON object');
    result[c.bodyRef!]=body;
  }
  for(const c of options.csrf??[]){
    const body=values?.[c.bodyRef];if(typeof body!=='string'||Buffer.byteLength(body)>8192)throw Error('CSRF probe body must be JSON up to 8192 bytes');
    let parsed:unknown;try{parsed=JSON.parse(body);}catch{throw Error('CSRF probe body must be valid JSON');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('CSRF probe body must be a JSON object');
    result[c.bodyRef]=body;
  }
  for(const c of options.xssStored??[]){
    const body=values?.[c.bodyRef];if(typeof body!=='string'||Buffer.byteLength(body)>8192)throw Error('Stored XSS body must be JSON up to 8192 bytes');
    let parsed:unknown;try{parsed=JSON.parse(body);}catch{throw Error('Stored XSS body must be valid JSON');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Stored XSS body must be a JSON object');
    result[c.bodyRef]=body;
  }
  for(const a of options.accounts)for(const credential of a.apiCredentials??[])for(const key of [credential.identityRef,...Object.values(credential.headers)]){const v=values?.[key];if(typeof v!=='string'||!v.trim()||v.length>8192||/[\r\n]/.test(v))throw Error('Supply fresh API credential or identity: '+key);result[key]=v;}
  for(const origin of options.apiGrants.map(g=>g.origin)){const identities=options.accounts.flatMap(a=>(a.apiCredentials??[]).filter(c=>c.origin===origin).map(c=>result[c.identityRef]));if(new Set(identities).size!==identities.length)throw Error('API account identities must be distinct');}
  return result;
}
type Input={root:string;runId:string;scope:CampaignScope;options:BrowserOptions;auth:Record<string,string>;secrets?:Record<string,string>;signal:AbortSignal;evidence:RequestEvidence[];result:BrowserResult;reserve:()=>Promise<{id:string;at:number}>;redact:(s:string)=>string;publish:(proof:BrowserProof,findings:PentestFinding[],covered:string[])=>void};

export async function runBrowserAssessment(input:Input):Promise<void> {
  const {scope,options,auth,signal,evidence,result,reserve}=input;
  const privateValues=new Set(Object.values(input.secrets??{}));
  for(const c of options.authorization)if(c.bodyRef){
    const pending:unknown[]=[JSON.parse(input.secrets![c.bodyRef]!)];
    while(pending.length){const value=pending.pop();if(typeof value==='string'&&value)privateValues.add(value);else if(value&&typeof value==='object')pending.push(...Object.values(value));}
  }
  const redact=(value:string)=>[...privateValues].reduce((s,v)=>v?s.split(v).join('[REDACTED]'):s,input.redact(value));
  let browser:Browser|undefined,totalBytes=0;
  const frontier=new BrowserFrontier(scope);let traversalFinished=false;
  result.resources={receivedBytes:0,responseLimitBytes:options.responseLimitBytes,totalLimitBytes:options.totalLimitBytes};
  let sessionState:Awaited<ReturnType<import("playwright").BrowserContext["storageState"]>>|undefined;
  let sessionStorage:Record<string,string>={};
  let csrfHarnessContent="";
  type Identity={id:string;storage?:typeof sessionState;sessionStorage?:Record<string,string>;bearer?:string};
  const accountSessions=new Map<string,Identity>();
  // Browser traffic that bypasses routing (preconnect/background requests) hits a deny-only proxy.
  const denyProxy=http.createServer((_req,res)=>{res.writeHead(403).end();});
  denyProxy.on("connection",socket=>socket.on("error",()=>{socket.destroy();}));
  denyProxy.on("connect",(_req,socket)=>{socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");});
  // Every target HTTP request is fetched manually, with no redirects, through the shared budget.
  // The browser receives only fulfilled responses; no target request uses route.continue().
  const startContext=async(authenticated:boolean,frameTarget="",identity?:Identity,probeHarness=false,credentialedApiProbe=false)=>{
    signal.throwIfAborted();
    const context=await browser!.newContext({serviceWorkers:"block",acceptDownloads:false,ignoreHTTPSErrors:false,viewport:{width:1280,height:800},storageState:identity?identity.storage:authenticated?sessionState:undefined});
    if(authenticated&&auth.Cookie&&!identity){
      const base=new URL(scope.seeds[0]!);
      // The injected victim cookie must mirror the real application cookie's
      // SameSite policy for CSRF probing; None additionally requires Secure.
      const injectedSameSite=(options.csrfCookieSameSite??"Lax") as "Lax"|"Strict"|"None";
      const cookies=auth.Cookie.split(";").flatMap(part=>{const index=part.indexOf("=");return index>0?[{name:part.slice(0,index).trim(),value:part.slice(index+1).trim(),domain:base.hostname,path:"/",httpOnly:true,secure:base.protocol==="https:"||injectedSameSite==="None",sameSite:injectedSameSite}]:[];});
      await context.addCookies(cookies);
    }
    const local=new AbortController(),requestSignal=AbortSignal.any([signal,local.signal]);
    const state={blocked:0,failed:0,runtimeErrors:0,frameDenied:false,framePolicyResponse:false,stage:"initial",readySelector:"",status:0,headers:{} as Record<string,string>};
    const pending=new Set<Promise<void>>();
    const blocked=(url:string,reason:string)=>{state.blocked++;if(result.blocked.length<200)result.blocked.push({url:redact(publicUrl(url)),reason});};
    await context.routeWebSocket("**/*",ws=>{blocked(ws.url(),"WebSocket blocked");ws.close();});
    const setup=`(() => {
      for (const key of ['RTCPeerConnection','webkitRTCPeerConnection','WebTransport']) { try { Object.defineProperty(window,key,{value:undefined,configurable:false}); } catch {} }
      document.addEventListener('submit',e=>{const f=e.target;try{const u=new URL(f.action,location.href);if(f.method.toUpperCase()!=='POST'||u.origin!==${JSON.stringify(new URL(scope.seeds[0]!).origin)}||!${JSON.stringify(options.postPaths)}.includes(u.pathname))e.preventDefault();}catch{e.preventDefault();}},true);
      window.open=()=>null;
    })();`;
    await context.addInitScript({content:setup});
    if(authenticated)await context.addInitScript({content:`if(location.origin===${JSON.stringify(new URL(scope.seeds[0]!).origin)})for(const [k,v] of Object.entries(${JSON.stringify(identity?.sessionStorage??(identity?{}:sessionStorage))}))sessionStorage.setItem(k,v);`});
    await context.route("**/*",route=>{
      const work=(async()=>{
        const req=route.request(),url=req.url(),method=req.method();
        if(probeHarness&&req.isNavigationRequest()&&url===scope.seeds[0]){await route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Anonymous API probe</title>'});return;}
        if(csrfHarnessContent&&req.isNavigationRequest()&&url===harness){await route.fulfill({status:200,contentType:'text/html',body:csrfHarnessContent});return;}
        if(frameTarget&&url===harness){await route.fulfill({status:200,contentType:"text/html",body:'<!doctype html><html><body><h1>Loam cross-origin frame verification</h1><iframe id="audit-frame" width="1100" height="650" src="'+frameTarget.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))+'"></iframe></body></html>'});return;}
        const requestHeaders=await req.allHeaders();
        const apiGrant=!req.isNavigationRequest()?matchApiGrant(options.apiGrants??[],url,method,req.resourceType(),requestHeaders['access-control-request-method']):undefined;
        const postAllowed=method==="POST"&&(!!apiGrant||(new URL(url).origin===new URL(scope.seeds[0]!).origin&&options.postPaths.includes(new URL(url).pathname)));
        if((!browserInScope(scope,url)&&!apiGrant)||(!["GET","HEAD","OPTIONS"].includes(method)&&!postAllowed)||(req.postDataBuffer()?.length??0)>65536){
          blocked(url,!browserInScope(scope,url)?"Outside scope":"State-changing method blocked");await route.abort("blockedbyclient");return;
        }
        let ticket:{id:string;at:number}|undefined;
        let recorded:RequestEvidence|undefined;
        try{
          const headers:Record<string,string>=apiGrant?apiRequestHeaders(requestHeaders,apiGrant):{};
          const enforceApiCors=!!apiGrant&&(probeHarness||credentialedApiProbe);
          if(enforceApiCors)headers.origin=new URL(scope.seeds[0]!).origin;
          const unsafeHeaders=enforceApiCors?corsUnsafeHeaders(headers):[];
          if(enforceApiCors&&method!=='OPTIONS'&&unsafeHeaders.length){
            const preflight=await reserve(),at=Date.now(),frontend=new URL(scope.seeds[0]!).origin;
            const entry:RequestEvidence={id:preflight.id,at:new Date(preflight.at).toISOString(),url:redact(publicUrl(url)),method:'OPTIONS',authenticated:credentialedApiProbe,status:0,durationMs:0,bodyHash:'',bytes:0,contentType:'',bodyOmitted:true,engine:'browser',apiOrigin:apiGrant!.origin,corsAllowed:false,corsCredentials:credentialedApiProbe?'include':'omit',corsRequestHeaders:unsafeHeaders,...(identity?{accountId:identity.id}:{})};
            evidence.push(entry);
            try{
              const response=await fetch(url,{method:'OPTIONS',headers:{origin:frontend,'access-control-request-method':method,'access-control-request-headers':unsafeHeaders.join(', ')},redirect:'manual',signal:AbortSignal.any([requestSignal,AbortSignal.timeout(10000)])});
              entry.status=response.status;
              entry.corsAllowed=response.ok&&corsPreflightAllowed(response.headers,frontend,credentialedApiProbe,method,unsafeHeaders);
              await response.body?.cancel();if(!entry.corsAllowed)throw Error('Preflight denied');
            }catch{entry.error='API CORS preflight did not permit the requested credentials, method or headers';blocked(url,entry.error);throw Error(entry.error);}
            finally{entry.durationMs=Date.now()-at;}
          }
          ticket=await reserve();requestSignal.throwIfAborted();
          if(totalBytes>=options.totalLimitBytes)throw new BrowserResponseLimitError('campaign');
          if(apiGrant)for(const name of apiGrant.credentialHeaders)if(requestHeaders[name])privateValues.add(requestHeaders[name]!);
          if(requestHeaders.authorization)privateValues.add(requestHeaders.authorization.replace(/^Bearer /i,''));
          if(!apiGrant)for(const name of ["accept","accept-language","origin","content-type","cookie","authorization","x-csrf-token","x-xsrf-token","x-requested-with","sec-fetch-site","sec-fetch-mode","sec-fetch-dest"])if(requestHeaders[name])headers[name]=requestHeaders[name]!;
          // User-supplied credentials never leave the approved single origin.
          if(!apiGrant&&identity?.bearer)headers.authorization='Bearer '+identity.bearer;
          else if(!apiGrant&&authenticated&&!identity){if(auth.Authorization)headers.authorization=auth.Authorization;if(auth.Cookie&&!headers.cookie)headers.cookie=auth.Cookie;}
          const response=await fetch(url,{method,headers,body:postAllowed?new Uint8Array(req.postDataBuffer()??[]).buffer:undefined,redirect:"manual",signal:AbortSignal.any([requestSignal,AbortSignal.timeout(10000)])});
          const outHeaders:Record<string,string>={};response.headers.forEach((v,k)=>{outHeaders[k]=v;});
          // Preserve separate cookies: combining Set-Cookie with commas corrupts session attributes.
          const setCookies=response.headers.getSetCookie();
          if(setCookies.length){delete outHeaders['set-cookie'];for(const cookie of setCookies){const first=cookie.split(';')[0]!,i=first.indexOf('=');if(i>0)privateValues.add(first.slice(i+1));}}
          // fetch decompresses bodies. Drop framing headers that describe the encoded wire body.
          delete outHeaders["content-encoding"];delete outHeaders["content-length"];delete outHeaders["transfer-encoding"];
          const chunks:Uint8Array[]=[];let size=0;const reader=response.body?.getReader();
          if(reader)try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;totalBytes+=part.value.length;result.resources!.receivedBytes=totalBytes;if(size>options.responseLimitBytes)throw new BrowserResponseLimitError('response');if(totalBytes>options.totalLimitBytes)throw new BrowserResponseLimitError('campaign');chunks.push(part.value);}}finally{await reader.cancel();}
          const body=Buffer.concat(chunks);
          const record:RequestEvidence={id:ticket.id,at:new Date(ticket.at).toISOString(),url:redact(publicUrl(url)),method,authenticated,status:response.status,durationMs:Date.now()-ticket.at,bodyHash:hash(body),bytes:body.length,contentType:redact(response.headers.get("content-type")?.split(";")[0]??""),engine:"browser"};
          evidence.push(record);
          if(apiGrant)record.apiOrigin=apiGrant.origin;
          if(enforceApiCors){record.corsAllowed=corsResponseAllowed(response.headers,new URL(scope.seeds[0]!).origin,credentialedApiProbe);record.corsCredentials=credentialedApiProbe?'include':'omit';}
          if(identity)record.accountId=identity.id;
          if(postAllowed){record.requestBytes=req.postDataBuffer()?.length??0;record.postPolicy=new URL(url).pathname;}
          recorded=record;
          if(frameTarget&&url===frameTarget&&req.isNavigationRequest()&&req.frame().parentFrame()===req.frame().page().mainFrame()&&response.ok){
            const csp=response.headers.get('content-security-policy')??'';
            const ancestors=csp.split(',').flatMap(policy=>{const first=policy.split(';').map(d=>d.trim()).find(d=>/^frame-ancestors(?:\s|$)/i.test(d));return first?[first]:[];});
            // Only recognize narrow policies that exclude this cross-origin harness.
            // CSP frame-ancestors overrides XFO; report-only policies do not enforce it.
            state.framePolicyResponse=ancestors.length>0?ancestors.some(d=>/^frame-ancestors\s+'(?:none|self)'\s*$/i.test(d)):/^(?:DENY|SAMEORIGIN)$/i.test((response.headers.get('x-frame-options')??'').trim());
          }
          if(enforceApiCors&&!record.corsAllowed){record.error='API response does not permit the frontend origin and credentials mode';blocked(url,record.error);await route.abort('blockedbyclient');return;}
          if(req.isNavigationRequest()&&req.frame()===req.frame().page().mainFrame()){state.status=response.status;state.headers=outHeaders;}
          if(response.status>=300&&response.status<400){
            const location=response.headers.get('location'),destination=location?new URL(location,url).href:'';
            // Chromium bypasses route handlers for redirect continuations. A document-only
            // navigation bridge creates a new intercepted GET; never replay POST implicitly.
            const safeGetRedirect=method==='GET'||method==='HEAD'||[301,302,303].includes(response.status);
            if(!options.followRedirects||!destination||!browserInScope(scope,destination)||!req.isNavigationRequest()||!safeGetRedirect){blocked(url,'Redirect not followed');record.error='Redirect blocked';await route.fulfill({status:409,contentType:'text/plain',body:'Redirect blocked by assessment scope policy'});return;}
            const escaped=destination.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
            await route.fulfill({status:200,headers:{'content-type':'text/html',...(setCookies.length?{'set-cookie':setCookies.join('\n')}:{})},body:'<!doctype html><meta http-equiv="refresh" content="0;url='+escaped+'">'});return;
          }
          if(response.status>=400)state.failed++;
          await route.fulfill({status:response.status,headers:{...outHeaders,...(setCookies.length?{'set-cookie':setCookies.join('\n')}:{})},body});
        }catch(error){
          state.failed++;
          const failure=error instanceof BrowserResponseLimitError?(error.limitKind==='response'?'Browser response exceeded '+options.responseLimitBytes+' bytes':'Browser campaign response budget exceeded '+options.totalLimitBytes+' bytes'):"Browser request did not complete";
          if(recorded)recorded.error=failure;
          else if(ticket)evidence.push({id:ticket.id,at:new Date(ticket.at).toISOString(),url:redact(publicUrl(url)),method,authenticated,status:0,durationMs:Date.now()-ticket.at,bodyHash:"",bytes:0,contentType:"",error:failure,engine:"browser"});
          else blocked(url,"Request budget or cancellation");
          await route.abort("failed").catch(()=>{});
        }
      })();pending.add(work);void work.finally(()=>pending.delete(work)).catch(()=>{});return work;
    });
    const page=await context.newPage();
    page.on("pageerror",()=>{state.runtimeErrors++;});
    page.on("console",msg=>{if(/Refused to (?:frame|display)|frame-ancestors|X-Frame-Options/i.test(msg.text()))state.frameDenied=true;});
    page.on("dialog",dialog=>{void dialog.dismiss().catch(()=>{});});
    context.on("page",p=>{if(p!==page)void p.close().catch(()=>{});});
    page.setDefaultTimeout(options.readinessTimeoutMs);page.setDefaultNavigationTimeout(options.readinessTimeoutMs);
    const close=async()=>{local.abort();await context.close().catch(()=>{});await Promise.allSettled([...pending]);};
    return {context,page,state,close};
  };
  type Session=Awaited<ReturnType<typeof startContext>>;
  const load=async(session:Session,url:string,useReady=true)=>{
    signal.throwIfAborted();
    session.state.readySelector=useReady?(options.readyRoutes?.find(r=>new URL(url).origin===new URL(scope.seeds[0]!).origin&&r.path===new URL(url).pathname)?.selector??options.readySelector):'';
    session.state.stage='navigation';await session.page.goto(url,{waitUntil:"domcontentloaded"});
    session.state.stage='readiness';if(session.state.readySelector)await session.page.locator(session.state.readySelector).waitFor({state:'visible',timeout:options.readinessTimeoutMs});
    await session.page.waitForTimeout(options.settleMs);
    session.state.stage="networkidle";await session.page.waitForLoadState("networkidle",{timeout:options.networkIdleTimeoutMs});
    session.state.stage="document-complete";await session.page.waitForFunction("document.readyState === 'complete'",undefined,{timeout:options.readinessTimeoutMs});session.state.stage="complete";
    signal.throwIfAborted();
  };
  const clean=(s:Session)=>s.state.blocked===0&&s.state.failed===0&&s.state.runtimeErrors===0;
  const snapshot=async(proof:BrowserProof,page:Page)=>{
    if(!options.screenshots)return;
    const secrets=[...privateValues,...Object.values(auth).flatMap(v=>[v,v.replace(/^Bearer /,"")])];
    if(auth.Cookie)secrets.push(...auth.Cookie.split(";").map(c=>c.slice(c.indexOf("=")+1).trim()).filter(Boolean));
    // Input values and text containing supplied session secrets are masked before capture.
    for(const frame of page.frames())await frame.evaluate("(values => { for(const e of document.querySelectorAll('*')) { if([...e.childNodes].some(n=>n.nodeType===3&&values.some(v=>v&&n.textContent.includes(v)))) e.setAttribute('data-loam-private',''); } })("+JSON.stringify(secrets)+")");
    const buffer=await page.screenshot({type:"png",animations:"disabled",timeout:5000,mask:page.frames().map(frame=>frame.locator('input,textarea,[contenteditable],[data-loam-private]'))});
    const relative=`.loam/security-artifacts/${input.runId}/${proof.id}.png`,file=taskPath(input.root,relative);
    fs.mkdirSync(taskPath(input.root,`.loam/security-artifacts/${input.runId}`),{recursive:true});
    fs.writeFileSync(file,buffer);proof.artifact={path:relative,sha256:hash(buffer),masked:true};
  };
  const publish=async(proof:BrowserProof,findings:PentestFinding[],covered:string[],page?:Page)=>{
    if(page){try{const values=await page.evaluate('[...Object.values(localStorage),...Object.values(sessionStorage)]') as string[];for(const v of values)if(v)privateValues.add(v);}catch{}}
    if(page)try{await snapshot(proof,page);}catch{proof.observations.screenshotUnavailable=true;}
    result.proofs.push(proof);if(proof.outcome==="inconclusive")result.incomplete=true;
    input.publish(proof,findings.map(f=>({...f,title:redact(f.title),detail:redact(f.detail)})),covered);
  };
  const proof=(kind:BrowserProof["kind"],target:string,offset:number):BrowserProof=>({id:randomUUID(),at:new Date().toISOString(),kind,target,outcome:"inconclusive",summary:"Browser test did not complete",requestIds:evidence.slice(offset).map(e=>e.id),observations:{}});
  const finding=(check:string,target:string,title:string,detail:string,severity:PentestFinding["severity"]="medium"):PentestFinding=>({id:check,check,target,title,detail,severity,verdict:"finding"});
  const executeSteps=async(session:Session,steps:BrowserStep[],kind:"login"|"flow",name:string)=>{
    const offset=evidence.length;let completed=0,published=false;
    try{
      for(const step of steps){
        signal.throwIfAborted();
        if(step.action==='navigate')await session.page.goto(new URL(step.path,scope.seeds[0]).href,{waitUntil:'domcontentloaded'});
        else if(step.action==='fill')await session.page.locator(step.selector).fill(input.secrets![step.secretRef]!);
        else if(step.action==='click')await session.page.locator(step.selector).click();
        else await session.page.locator(step.selector).waitFor({state:'visible'});
        if(!browserInScope(scope,session.page.url()))throw Error('Flow left scope');
        completed++;
      }
      await session.page.waitForTimeout(options.settleMs);
      await session.page.waitForLoadState('networkidle',{timeout:options.networkIdleTimeoutMs});
      // Recheck the last assertion after async rendering has settled.
      const last=steps.at(-1)!;if(last.action==='assertVisible')await session.page.locator(last.selector).waitFor({state:'visible'});
      const p=proof(kind,publicUrl(session.page.url()),offset);p.outcome=clean(session)?'observed':'inconclusive';p.summary='Browser '+kind+' completed: '+redact(name);p.observations={completed,total:steps.length,blocked:session.state.blocked,failed:session.state.failed,steps:JSON.stringify(steps),name:redact(name)};
      if(kind==='flow'){
        const html=await session.page.content(),target=publicUrl(session.page.url());
        const findings=inspectPage(target,{ok:true,status:session.state.status,headers:session.state.headers,setCookie:[],body:redact(html.slice(0,524288))}).map(f=>({...f,check:'flow_'+hash(name).slice(0,12)+'_'+f.check}));
        const checks=['weak_csp','error_disclosure','mixed_content','credential_form','csrf_review'];
        await publish(p,findings,clean(session)&&session.state.status>=200&&session.state.status<300&&html.length<=524288?checks.map(c=>coverageKey(target,'flow_'+hash(name).slice(0,12)+'_'+c)):[],session.page);
      }else await publish(p,[],[],session.page);
      published=true;
      if(!clean(session))throw Error('Incomplete browser flow');
    }catch(error){if(!published){const p=proof(kind,publicUrl(session.page.url()),offset);p.summary='Browser '+kind+' failed at step '+Math.min(completed+1,steps.length);p.observations={completed,total:steps.length,name:redact(name),steps:JSON.stringify(steps)};await publish(p,[],[],session.page);}throw error;}
  };
  const identityWitness=async(s:Session,a:TestAccount)=>{
    const before={...s.state};
    const expectedUrl=new URL(a.witness.path,scope.seeds[0]).href;
    await load(s,expectedUrl,false);
    const element=s.page.locator(a.witness.selector);
    const valid=await element.isVisible()&&(await element.innerText()).trim()===input.secrets![a.witness.textRef]!.trim();
    return s.page.url()===expectedUrl&&valid&&s.state.status>=200&&s.state.status<300&&s.state.blocked===before.blocked&&s.state.failed===before.failed&&s.state.runtimeErrors===before.runtimeErrors;
  };
  const runAuthorization=async()=>{
    for(const a of options.accounts){
      signal.throwIfAborted();const offset=evidence.length,s=await startContext(true,'',{id:a.id,bearer:a.bearerRef?input.secrets![a.bearerRef]:undefined});
      const p=proof('session',new URL(a.witness.path,scope.seeds[0]).href,offset);
      try{
        await executeSteps(s,a.login,'login',a.id);
        const valid=await identityWitness(s,a);p.observations={account:a.id,identityMatched:valid,identityTargetReached:s.page.url()===new URL(a.witness.path,scope.seeds[0]).href,identityFinalUrl:redact(publicUrl(s.page.url()))};
        if(valid){const storage=await s.context.storageState(),sessionStorage=await s.page.evaluate('Object.fromEntries(Object.entries(sessionStorage))') as Record<string,string>;
          for(const c of storage.cookies)privateValues.add(c.value);
          accountSessions.set(a.id,{id:a.id,storage,sessionStorage,bearer:a.bearerRef?input.secrets![a.bearerRef]:undefined});p.outcome='observed';}
        p.summary=valid?'Account identity verified':'Account identity could not be verified';
      }catch{signal.throwIfAborted();p.summary='Account login or identity verification failed';p.observations={account:a.id,identityMatched:false};}
      p.requestIds=evidence.slice(offset).map(e=>e.id);await publish(p,[],[],s.page);await s.close();
    }
    for(const c of options.authorization){
      let controlsValid=true;const controlRequests:string[]=[],controlProofs:string[]=[];
      for(const id of [...c.allowed,...c.denied]){
        signal.throwIfAborted();const expectedAllowed=c.allowed.includes(id),a=options.accounts.find(a=>a.id===id)!,saved=accountSessions.get(id),offset=evidence.length;
        const url=new URL(c.path,c.api?.origin??scope.seeds[0]).href,p=proof('authorization',url,offset);
        p.observations={caseId:c.id,account:id,expected:expectedAllowed?'allow':'deny',kind:c.kind};
        let observed=false,denied=false,valid=false,status=0;
        if(saved){const s=await startContext(true,'',saved,false,!!c.api);
          try{
            const beforeValid=await identityWitness(s,a),testOffset=evidence.length;
            p.observations.identityBeforeFinalUrl=redact(publicUrl(s.page.url()));
            p.observations.identityBeforeTargetReached=s.page.url()===new URL(a.witness.path,scope.seeds[0]).href;
            if(!beforeValid)throw Error('Session identity expired');
            const credential=c.api?a.apiCredentials!.find(v=>v.origin===c.api!.origin):undefined;
            const headers=Object.fromEntries(Object.entries(credential?.headers??{}).map(([name,ref])=>[name,input.secrets![ref]!]));
            const apiIdentity=async()=>{
              if(!c.api||!credential)return true;
              const payload=JSON.stringify({url:new URL(c.api.identityPath,c.api.origin).href,field:c.api.identityField,expected:input.secrets![credential.identityRef],headers});
              return await s.page.evaluate(`(async ({url,field,expected,headers})=>{const r=await fetch(url,{headers,credentials:'include',redirect:'error'});if(!r.ok)return false;const data=await r.json();return Object.prototype.hasOwnProperty.call(data,field)&&typeof data[field]==='string'&&data[field]===expected;})(${payload})`) as boolean;
            };
            const apiBefore=await apiIdentity();p.observations.apiSessionBefore=apiBefore;
            if(!apiBefore)throw Error('API session identity expired or mismatched');
            if(c.kind==='ui'){
              await load(s,url,true);status=s.state.status;
              p.observations.targetReached=s.page.url()===url;p.observations.finalUrl=redact(publicUrl(s.page.url()));
              observed=await s.page.locator(c.selector).isVisible();denied=await s.page.locator(c.deniedSelector).isVisible()||[401,403].includes(status);
            }else{
              const method=c.method??'GET',body=c.bodyRef?input.secrets![c.bodyRef]:undefined;
              if(method==='POST')headers['content-type']='application/json';
              p.observations.method=method;
              const pointer=c.markerPath===undefined?undefined:c.markerPath===''?[]:c.markerPath.slice(1).split('/').map(v=>v.replace(/~1/g,'/').replace(/~0/g,'~'));
              p.observations.witnessMode=pointer===undefined?'text_contains':'json_pointer_exact';
              if(c.markerPath!==undefined)p.observations.markerPath=c.markerPath;
              const payload=JSON.stringify({url,marker:input.secrets![c.markerRef],headers,method,body,pointer});
              const response=await s.page.evaluate(`(async ({url,marker,headers,method,body,pointer})=>{const r=await fetch(url,{headers,method,body,credentials:'include',redirect:'error'});const text=await r.text();if(pointer===undefined)return {status:r.status,matched:text.includes(marker)};let value;try{value=JSON.parse(text);}catch{return {status:r.status,matched:false}}for(const key of pointer){if(value===null||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,key))return {status:r.status,matched:false};value=value[key];}return {status:r.status,matched:typeof value==='string'&&value===marker};})(${payload})`) as {status:number;matched:boolean};
              status=response.status;observed=response.matched;
              // A text-only marker in an error body may be a leak or an echo;
              // neither interpretation is sufficient to certify a repair.
              denied=[401,403].includes(status)&&!(response.matched&&c.markerPath===undefined);
            }
            const apiAfter=await apiIdentity();p.observations.apiSessionAfter=apiAfter;
            const testEvidence=evidence.slice(testOffset),transportValid=testEvidence.length>0&&testEvidence.every(e=>!e.error&&((e.status>=200&&e.status<300)||[401,403].includes(e.status)))&&s.state.blocked===0&&s.state.runtimeErrors===0;
            // An explicit JSON witness can expose protected data even in a denial
            // response. Never certify that case as fixed from the status alone.
            observed=observed&&((status>=200&&status<300)||(c.kind==='api'&&c.markerPath!==undefined&&[401,403].includes(status)));
            if(c.kind==='ui')try{await snapshot(p,s.page);}catch{p.observations.screenshotUnavailable=true;}
            const afterValid=await identityWitness(s,a);
            p.observations.identityAfterFinalUrl=redact(publicUrl(s.page.url()));
            p.observations.identityAfterTargetReached=s.page.url()===new URL(a.witness.path,scope.seeds[0]).href;
            valid=beforeValid&&afterValid&&apiBefore&&apiAfter&&transportValid&&(c.kind!=='ui'||p.observations.targetReached===true);
            p.observations={...p.observations,sessionBefore:beforeValid,sessionAfter:afterValid,protectedWitness:observed,denialWitness:denied,status,transportValid};
          }catch{signal.throwIfAborted();p.summary='Session, application readiness or authorization observation failed';}
          finally{await s.close();}
        }else p.summary='Account has no verified session';
        p.requestIds=evidence.slice(offset).map(e=>e.id);
        const check='authorization_'+hash(c.id+'\n'+id).slice(0,16);
        let findings:PentestFinding[]=[],covered:string[]=[];
        if(expectedAllowed){
          const passed=valid&&observed&&status>=200&&status<300;controlsValid=controlsValid&&passed;
          p.outcome=passed?'observed':'inconclusive';p.summary=passed?'Allowed account reproduced the protected witness':'Allowed-account positive control failed';
          controlRequests.push(...p.requestIds);controlProofs.push(p.id);
        }else{
          p.observations.positiveControlsValid=controlsValid;p.observations.controlProofs=controlProofs.join(', ');
          p.requestIds=[...controlRequests,...p.requestIds];
          if(valid&&controlsValid&&observed){p.outcome='observed';p.summary='Account expected to be denied reproduced the protected witness';findings=[finding(check,url,'Declared authorization boundary failed: '+c.id+' / '+id,'Allowed-account controls and identity checks succeeded before/after the test. The denied account reproduced the explicitly declared protected witness. Review the case policy and attached evidence.','high')];}
          else if(valid&&controlsValid&&!observed&&denied){p.outcome='not_observed';p.summary='Verified account received an explicit denial; allowed-account controls succeeded';}
          else p.summary='Authorization test inconclusive; a valid session, positive control or explicit denial is missing';
          if(p.outcome!=='inconclusive')covered=[coverageKey(url,check)];
        }
        await publish(p,findings,covered);
      }
    }
  };
  const abort=()=>{void browser?.close().catch(()=>{});};signal.addEventListener("abort",abort,{once:true});
  try{
    await new Promise<void>((resolve,reject)=>{denyProxy.once("error",reject);denyProxy.listen(0,"127.0.0.1",()=>resolve());});
    const proxyAddress=denyProxy.address() as import("node:net").AddressInfo;
    let launched=false;
    for(const channel of [undefined,"chrome","msedge"]){
      signal.throwIfAborted();
      try{browser=await chromium.launch({headless:true,channel,timeout:15000,proxy:{server:`http://127.0.0.1:${proxyAddress.port}`},args:["--proxy-bypass-list=<-loopback>","--dns-prefetch-disable","--disable-quic","--force-webrtc-ip-handling-policy=disable_non_proxied_udp"]});result.engine=channel??"chromium";launched=true;break;}catch{if(signal.aborted)signal.throwIfAborted();}
    }
    if(!launched)throw Error("No supported Chromium browser available; install Playwright Chromium, Chrome or Edge");
    result.version=browser!.version();
    for(const c of options.anonymousApi??[]){
      signal.throwIfAborted();const offset=evidence.length,url=anonymousApiUrl(c),p=proof('anonymous_api',publicUrl(url),offset);
      p.observations={caseId:c.id,expected:c.expected,collectionPath:c.collectionPath,publicKeySupplied:!!c.publicKeyRef,userSession:false,cookiesSent:false,queryHash:hash(JSON.stringify(c.query))};
      const s=await startContext(false,'',undefined,true);
      let findings:PentestFinding[]=[],covered:string[]=[];
      try{
        // A local synthetic document supplies the approved frontend origin for
        // CORS. No application script, login storage or user session is loaded.
        await s.page.goto(scope.seeds[0]!,{waitUntil:'domcontentloaded'});
        const request=async(item:AnonymousApiCase)=>{
          const start=evidence.length,headers=item.publicKeyRef?{apikey:input.secrets![item.publicKeyRef]}:{};
          const payload=JSON.stringify({url:anonymousApiUrl(item),headers});
          const r=await s.page.evaluate(`(async ({url,headers})=>{const r=await fetch(url,{method:'GET',headers,credentials:'omit',redirect:'error',cache:'no-store'});return {status:r.status,body:await r.text()};})(${payload})`) as {status:number;body:string};
          const records=evidence.slice(start).filter(e=>e.apiOrigin===item.origin&&e.method==='GET');
          return {status:r.status,...anonymousCollection(r.body,item.collectionPath),transportValid:records.length===1&&records.every(e=>!e.error)};
        };
        const control=(options.anonymousApi??[]).find(v=>v.id===c.controlId);
        const positive=(r:Awaited<ReturnType<typeof request>>)=>r.transportValid&&r.status>=200&&r.status<300&&r.rows!==null&&r.rows>0;
        const before=control?positive(await request(control)):true;
        const response=await request(c);
        const after=control?positive(await request(control)):true;
        const valid=response.transportValid&&before&&after;
        p.observations={caseId:c.id,expected:c.expected,collectionPath:c.collectionPath,publicKeySupplied:!!c.publicKeyRef,userSession:false,cookiesSent:false,status:response.status,rows:response.rows??-1,jsonValid:response.jsonValid,publicControlBefore:before,publicControlAfter:after,transportValid:response.transportValid,queryHash:hash(JSON.stringify(c.query))};
        const check='anonymous_api_'+hash(c.id).slice(0,16);
        if(c.expected==='public'){
          p.outcome=positive(response)?'observed':'inconclusive';p.summary=positive(response)?'Public collection positive control returned rows without a user session':'Public positive control did not establish usable anonymous API access';
        }else if(valid&&response.rows!==null&&response.rows>0&&((response.status>=200&&response.status<300)||[401,403].includes(response.status))){
          p.outcome='observed';p.summary='A collection declared private returned rows without a user session; review data classification';
          const f=finding(check,publicUrl(url),'Declared private collection returned rows anonymously: '+c.id,p.summary+'. Both public controls succeeded. Collection contents are not retained; row count alone does not establish sensitivity.','high');
          f.remediation='Review the declared collection policy, grants and row-level authorization. Reproduce with a known synthetic protected record and repeat after repair.';findings=[f];covered=[coverageKey(publicUrl(url),check)];
        }else if(valid&&response.jsonValid&&[401,403].includes(response.status)&&!(response.rows!==null&&response.rows>0)){
          p.outcome='not_observed';p.summary='Explicit anonymous denial with successful public controls before and after';covered=[coverageKey(publicUrl(url),check)];
        }else p.summary=response.rows===0?'Empty collection; existing protected records and authorization repair remain unverified':'Anonymous API result lacks a valid public control, expected collection or explicit denial';
      }catch{signal.throwIfAborted();p.summary='Anonymous API request, CORS or public control did not complete';}
      finally{await s.close();}
      p.requestIds=evidence.slice(offset).map(e=>e.id);
      if(p.outcome==='inconclusive')findings.push({id:'anonymous-api-incomplete',check:'anonymous_api_coverage',target:publicUrl(url),verdict:'error',severity:'info',title:'Anonymous API case is inconclusive: '+c.id,detail:p.summary});
      await publish(p,findings,covered);
    }
    await runAuthorization();
    if(options.login.length){
      const login=await startContext(true);
      try{await executeSteps(login,options.login,'login','Session establishment');sessionState=await login.context.storageState();sessionStorage=await login.page.evaluate('Object.fromEntries(Object.entries(sessionStorage))');for(const cookie of sessionState.cookies)privateValues.add(cookie.value);for(const origin of sessionState.origins)for(const item of origin.localStorage)privateValues.add(item.value);for(const v of Object.values(sessionStorage))privateValues.add(v);}
      finally{await login.close();}
    }
    for(const flow of options.flows){const session=await startContext(!!Object.keys(auth).length||!!sessionState);try{await executeSteps(session,flow.steps,'flow',flow.name);}catch{signal.throwIfAborted();result.incomplete=true;}finally{await session.close();}}
    while(result.pages.length<Math.min(options.maxPages,scope.maxPages)){
      signal.throwIfAborted();const next=frontier.next();if(!next)break;const {url,depth}=next;
      const offset=evidence.length,s=await startContext(!!Object.keys(auth).length||!!sessionState);
      let rendered=false;
      try{
        await load(s,url);const p=proof("render",url,offset);
        const data=await s.page.evaluate("(() => {const anchors=document.querySelectorAll('a[href]');return {html:document.documentElement.outerHTML.slice(0,524288),links:Array.from(anchors).slice(0,500).map(a=>a.href),linkLimited:anchors.length>500,forms:document.forms.length};})()") as {html:string;links:string[];linkLimited:boolean;forms:number};
        frontier.add(data.links,depth,data.linkLimited);
        const finalUrl=redact(publicUrl(s.page.url())),routeChanged=publicUrl(s.page.url())!==publicUrl(url);
        rendered=s.state.status>=200&&s.state.status<300&&!routeChanged;
        const complete=rendered&&clean(s);
        result.pages.push({url,finalUrl,routeChanged,links:data.links.length,forms:data.forms,complete});
        p.outcome=complete?"observed":"inconclusive";p.summary=routeChanged?"Application navigated to a different route; requested page coverage is unverified":complete?"JavaScript executed and rendered DOM inspected":"Rendered page has blocked/failed resources or runtime errors";
        p.observations={finalUrl,routeChanged,status:s.state.status,forms:data.forms,links:data.links.length,blocked:s.state.blocked,failed:s.state.failed,runtimeErrors:s.state.runtimeErrors,settleMs:options.settleMs,documentComplete:true,networkSettled:true,readySelector:redact(s.state.readySelector),readiness:s.state.readySelector?'visible app selector verified':'transport only; no app readiness selector configured'};
        const findings=rendered?inspectPage(url,{ok:true,status:s.state.status,headers:s.state.headers,setCookie:[],body:data.html}).map(f=>({...f,check:"browser_"+f.check})):[];
        const covered=complete?["weak_csp","error_disclosure","mixed_content","credential_form","csrf_review"].map(c=>coverageKey(url,"browser_"+c)):[];
        await publish(p,findings,covered,s.page);
      }catch{const p=proof("render",url,offset);p.summary="Navigation, readiness or rendering did not complete";p.observations={finalUrl:redact(publicUrl(s.page.url())),routeChanged:publicUrl(s.page.url())!==publicUrl(url),readySelector:redact(s.state.readySelector),stage:s.state.stage,blocked:s.state.blocked,failed:s.state.failed,runtimeErrors:s.state.runtimeErrors,receivedBytes:totalBytes,responseLimitBytes:options.responseLimitBytes,totalLimitBytes:options.totalLimitBytes,readinessTimeoutMs:options.readinessTimeoutMs,networkIdleTimeoutMs:options.networkIdleTimeoutMs};await publish(p,[],[],s.page);if(!result.pages.some(p=>p.url===url))result.pages.push({url,links:0,forms:0,complete:false});}
      finally{await s.close();}
      if(rendered&&options.domCanary){
        const key="data-loam-"+randomUUID().replace(/-/g,""),marker=`<img src="data:image/png,invalid" onerror="document.documentElement.setAttribute('${key}','true')">`;
        const offset=evidence.length,test=await startContext(!!Object.keys(auth).length||!!sessionState);
        try{
          // The fragment is never sent to the target server; the payload sets one local DOM attribute only.
          await load(test,url+"#"+encodeURIComponent(marker));
          const executed=await test.page.evaluate("document.documentElement.getAttribute("+JSON.stringify(key)+") === 'true'") as boolean;
          const finalUrl=redact(publicUrl(test.page.url())),routeChanged=publicUrl(test.page.url())!==publicUrl(url);
          const queryChanged=new URL(test.page.url()).search!==new URL(url).search;
          const targetReached=!routeChanged&&!queryChanged&&test.state.status>=200&&test.state.status<300;
          const p=proof("dom_canary",url,offset);p.outcome=targetReached?(executed?"observed":clean(test)?"not_observed":"inconclusive"):"inconclusive";
          p.summary=!targetReached?"Canary navigation did not retain the requested successful document; original target coverage is unverified":executed?"Fragment canary executed in the document's JavaScript context":"Fragment canary did not execute within the observation window";
          p.observations={executed,finalUrl,routeChanged,queryChanged,status:test.state.status,targetReached,source:"location.hash",marker:"Image error handler sets a fresh per-test DOM attribute; no data access or outbound payload",settleMs:options.settleMs};
          const f=finding("browser_dom_canary",url,"DOM fragment input executed a harmless script canary",p.summary,"high");f.remediation="Treat fragment input as untrusted; render it as text or sanitize with a maintained HTML sanitizer, and enforce an effective CSP.";
          await publish(p,executed&&targetReached?[f]:[],p.outcome!=="inconclusive"?[coverageKey(url,f.check)]:[],test.page);
        }catch{const p=proof("dom_canary",url,offset);p.summary="DOM canary could not be evaluated";await publish(p,[],[],test.page);}finally{await test.close();}
      }
      if(rendered&&options.framing){
        const offset=evidence.length,test=await startContext(false,url);
        try{
          await load(test,harness,false);
          const frame=test.page.frames().find(f=>f.parentFrame()===test.page.mainFrame()&&publicUrl(f.url())===url&&new URL(f.url()).search===new URL(url).search);
          const targetSuccess=evidence.slice(offset).some(e=>e.url===url&&e.status>=200&&e.status<300);
          const visible=targetSuccess&&frame?await frame.locator("body").count()>0:false;
          const policyDenied=!visible&&test.state.frameDenied&&test.state.framePolicyResponse;
          const p=proof("framing",url,offset);p.outcome=visible?"observed":policyDenied?"not_observed":"inconclusive";
          p.summary=visible?"An anonymous target document rendered inside a controlled cross-origin iframe":policyDenied?"Browser denial corroborated by an enforcing policy on the requested successful document":"Frame did not render; target-specific policy denial remains unverified";
          p.observations={rendered:visible,policyDenied,policyResponse:test.state.framePolicyResponse,consoleDenialSignal:test.state.frameDenied,authenticated:false,harnessOrigin:harness};
          const f=finding("browser_framing",url,"Page permits cross-origin framing",p.summary+". Review whether embedding is intentional; this does not prove a clickjacking impact.");f.remediation="For pages that must not be framed, set CSP frame-ancestors to an explicit trusted policy.";
          await publish(p,visible?[f]:[],p.outcome!=="inconclusive"?[coverageKey(url,f.check)]:[],test.page);
        }catch{const p=proof("framing",url,offset);p.summary="Frame verification did not complete";await publish(p,[],[],test.page);}finally{await test.close();}
      }
    }
    traversalFinished=true;
    result.discovery=frontier.snapshot(false,redact);if(result.discovery.incomplete)result.incomplete=true;
    for(const c of options.xssReflected??[]){
      signal.throwIfAborted();
      const offset=evidence.length,base=new URL(c.path,scope.seeds[0]!).href;
      const {marker,payload}=newXssCanary(),target=xssTargetUrl(base,c.param,payload);
      const s=await startContext(!!Object.keys(auth).length||!!sessionState);
      const p=proof('xss_reflected',base,offset);
      p.observations={param:c.param,marker};
      let findings:PentestFinding[]=[],covered:string[]=[];
      try{
        // Baseline control: the page must render successfully and carry no
        // trace of the fresh marker before the parameter is introduced.
        await load(s,base,true);
        const baselineHtml=await s.page.content();
        const baselineOk=s.state.status>=200&&s.state.status<300&&publicUrl(s.page.url())===publicUrl(base)&&!baselineHtml.includes(marker);
        p.observations.baselineStatus=s.state.status;p.observations.baselineClean=baselineOk;
        if(baselineOk){
          const before={blocked:s.state.blocked,failed:s.state.failed,runtime:s.state.runtimeErrors};
          await load(s,target,true);
          const executed=await s.page.evaluate("document.documentElement.getAttribute("+JSON.stringify(marker)+") === "+JSON.stringify(marker)) as boolean;
          const html=await s.page.content(),reflected=html.includes(marker);
          p.observations={...p.observations,status:s.state.status,reflected,executed,blocked:s.state.blocked-before.blocked,failed:s.state.failed-before.failed,runtimeErrors:s.state.runtimeErrors-before.runtime};
          const check='xss_reflected_'+hash(c.id).slice(0,16);
          if(executed){
            p.outcome='observed';
            p.summary='A reflected parameter canary executed in the page JavaScript context';
            const f=finding(check,base,'Reflected cross-site scripting: '+c.id,'The baseline request rendered this page successfully without the marker. A harmless canary submitted through the declared parameter "'+c.param+'" was reflected into the response and its image-error handler executed, setting a per-run DOM attribute. The canary performs no data access and makes no network request; impact depends on the parameter context and application data.','high');
            f.remediation='Encode output by context (HTML body, attribute, JavaScript string), validate the parameter input, and enforce an effective Content-Security-Policy; re-run this case after repair.';
            findings=[f];covered=[coverageKey(base,check)];
          }else{
            p.outcome='not_observed';
            p.summary=reflected?'The parameter was reflected without executing within the observation window (encoded, sanitized or policy-blocked)':'The parameter value was not reflected in the response';
            covered=[coverageKey(base,check)];
          }
        }else p.summary='Baseline control failed: the page did not render as a successful document at the declared path or already carried the marker';
        p.requestIds=evidence.slice(offset).map(e=>e.id);
        await publish(p,findings,covered,s.page);
      }catch{signal.throwIfAborted();p.summary='Reflected XSS probe did not complete';p.requestIds=evidence.slice(offset).map(e=>e.id);await publish(p,[],[],s.page);}
      finally{await s.close();}
    }
    for(const c of options.csrf??[]){
      signal.throwIfAborted();
      const offset=evidence.length,target=new URL(c.path,scope.seeds[0]!).href;
      const p=proof('csrf',target,offset);
      p.observations={statePath:c.statePath,statePointer:c.statePointer,stateDelta:c.stateDelta};
      const s=await startContext(!!Object.keys(auth).length||!!sessionState);
      let findings:PentestFinding[]=[],covered:string[]=[];
      try{
        if(!auth.Cookie&&!sessionState){p.summary='No victim session is available for this campaign (cookie authentication or a browser login is required)';}
        else{
          const body=input.secrets![c.bodyRef]!;
          const witnessUrl=new URL(c.statePath,scope.seeds[0]!).href;
          const witness=async():Promise<{ok:true;value:number}|{ok:false;reason:string}>=>{
            const payload=JSON.stringify({url:witnessUrl,pointer:c.statePointer});
            const r=await s.page.evaluate(`(async ({url,pointer})=>{const r=await fetch(url,{credentials:'include',redirect:'error'});const text=await r.text();let value;try{value=JSON.parse(text);}catch{return {status:r.status,value:null};}for(const key of pointer===''?[]:pointer.slice(1).split('/').map(v=>v.replace(/~1/g,'/').replace(/~0/g,'~'))){if(value===null||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,key))return {status:r.status,value:null};value=value[key];}return {status:r.status,value:typeof value==='number'&&Number.isFinite(value)?value:null};})(${payload})`) as {status:number;value:number|null};
            return r.value===null?{ok:false,reason:'State witness did not resolve to a finite number (HTTP '+r.status+')'}:{ok:true,value:r.value};
          };
          await load(s,new URL('/',scope.seeds[0]!).href,false);
          const before=await witness();
          if(!before.ok)p.summary='State witness unavailable before the control: '+before.reason;
          else{
            // Same-origin positive control under the victim session.
            const controlPayload=JSON.stringify({url:target,body});
            const control=await s.page.evaluate(`(async ({url,body})=>{const r=await fetch(url,{method:'POST',credentials:'include',redirect:'error',headers:{'content-type':'application/json'},body});return {status:r.status};})(${controlPayload})`) as {status:number};
            p.observations.controlStatus=control.status;
            if(!(control.status>=200&&control.status<300))p.summary='Same-origin control submission was not accepted (HTTP '+control.status+'); review the case body and session';
            else{
              const mid=await witness();
              if(!mid.ok)p.summary='State witness unavailable after the control: '+mid.reason;
              else if(mid.value!==before.value+c.stateDelta)p.summary='Positive control failed: the operation did not apply the declared delta ('+before.value+' → '+mid.value+')';
              else{
                const cookieInfo=await s.context.cookies(new URL(scope.seeds[0]!).origin);
                const sessionCookie=auth.Cookie?auth.Cookie.split(';')[0]!.split('=')[0]!.trim():'';
                const observed=cookieInfo.find(k=>!sessionCookie||k.name===sessionCookie)??cookieInfo[0];
                p.observations.sessionCookieSameSite=observed?.sameSite??'none';p.observations.sessionCookieSecure=observed?.secure??false;
                // Cross-origin probe: one simple request from a synthetic
                // foreign-origin page, exactly as a foreign site could send.
                const probeOffset=evidence.length;
                csrfHarnessContent=csrfHarnessHtml(target,body);
                await load(s,harness,false);
                const probeSent=await s.page.evaluate("document.documentElement.getAttribute('data-loam-csrf')") as string|null;
                csrfHarnessContent='';
                const probePosts=evidence.slice(probeOffset).filter(e=>e.method==='POST'&&e.url===target);
                const probeStatus=probePosts.length?probePosts[probePosts.length-1]!.status:0;
                p.observations.probeSent=probeSent==='sent';p.observations.probeStatus=probeStatus;
                await load(s,new URL('/',scope.seeds[0]!).href,false);
                const after=await witness();
                if(!after.ok)p.summary='State witness unavailable after the cross-origin probe: '+after.reason;
                else{
                  const applied=after.value===mid.value+c.stateDelta;
                  p.observations.stateBefore=before.value;p.observations.stateAfterControl=mid.value;p.observations.stateAfterProbe=after.value;p.observations.appliedCrossOrigin=applied;
                  const check='csrf_'+hash(c.id).slice(0,16);
                  if(applied){
                    p.outcome='observed';
                    p.summary='A cross-origin submission from a foreign page applied the declared operation under the victim session';
                    const f=finding(check,target,'Cross-site request forgery: '+c.id,'The same-origin control applied the declared delta under the victim session. A simple cross-origin request issued from a synthetic foreign-origin page (plain text body, no custom headers) then applied the same operation again (probe HTTP '+probeStatus+', session cookie SameSite='+String(p.observations.sessionCookieSameSite)+'). The probe performs no other action; impact depends on the operation semantics.','high');
                    f.remediation='Require an anti-CSRF token or same-origin challenge (or Origin/Referer validation) for this operation, keep session cookies SameSite=Lax/Strict, and re-run this case after repair.';
                    findings=[f];covered=[coverageKey(target,check)];
                  }else{
                    p.outcome='not_observed';
                    p.summary=probeStatus>=400?'The cross-origin submission was rejected (HTTP '+probeStatus+'); the session or token defense held':'The cross-origin submission did not apply the declared effect (HTTP '+probeStatus+')';
                    covered=[coverageKey(target,check)];
                  }
                }
              }
            }
          }
        }
        p.requestIds=evidence.slice(offset).map(e=>e.id);
        await publish(p,findings,covered,s.page);
      }catch{signal.throwIfAborted();p.summary='CSRF probe did not complete';p.requestIds=evidence.slice(offset).map(e=>e.id);await publish(p,[],[],s.page);}
      finally{await s.close();}
    }
    for(const c of options.xssStored??[]){
      signal.throwIfAborted();
      const offset=evidence.length,viewUrl=new URL(c.viewPath,scope.seeds[0]!).href,target=new URL(c.postPath,scope.seeds[0]!).href;
      const {marker,payload}=newXssCanary();
      const p=proof('xss_stored',viewUrl,offset);
      p.observations={field:c.field,postPath:c.postPath};
      const viewer=await startContext(!!Object.keys(auth).length||!!sessionState);
      const author=await startContext(!!Object.keys(auth).length||!!sessionState);
      let findings:PentestFinding[]=[],covered:string[]=[];
      try{
        // Baseline control: an isolated viewer must render the declared view
        // successfully and carry no trace of the fresh marker.
        await load(viewer,viewUrl,true);
        const baselineHtml=await viewer.page.content();
        const baselineOk=viewer.state.status>=200&&viewer.state.status<300&&publicUrl(viewer.page.url())===publicUrl(viewUrl)&&!baselineHtml.includes(marker);
        p.observations.baselineStatus=viewer.state.status;p.observations.baselineClean=baselineOk;
        if(!baselineOk)p.summary='Baseline control failed: the view did not render as a successful document at the declared path or already carried the marker';
        else{
          // Authorized storage submission with the canary in the declared field.
          await load(author,new URL('/',scope.seeds[0]!).href,false);
          const bodyText=injectCanaryField(input.secrets![c.bodyRef]!,c.field,payload);
          const storedPayload=JSON.stringify({url:target,body:bodyText});
          const stored=await author.page.evaluate(`(async ({url,body})=>{const r=await fetch(url,{method:'POST',credentials:'include',redirect:'error',headers:{'content-type':'application/json'},body});return {status:r.status};})(${storedPayload})`) as {status:number};
          p.observations.storageStatus=stored.status;
          if(!(stored.status>=200&&stored.status<300))p.summary='Storage submission was not accepted (HTTP '+stored.status+'); review the case body, authentication and authorization';
          else{
            // A fresh isolated viewer profile loads the view afterwards.
            const freshViewer=await startContext(!!Object.keys(auth).length||!!sessionState);
            try{
              await load(freshViewer,viewUrl,true);
              const executed=await freshViewer.page.evaluate("document.documentElement.getAttribute("+JSON.stringify(marker)+") === "+JSON.stringify(marker)) as boolean;
              const html=await freshViewer.page.content(),reflected=html.includes(marker);
              p.observations.viewStatus=freshViewer.state.status;p.observations.reflected=reflected;p.observations.executed=executed;
              const check='xss_stored_'+hash(c.id).slice(0,16);
              if(executed){
                p.outcome='observed';
                p.summary='A canary stored through an authorized submission executed in a fresh viewer profile';
                const f=finding(check,viewUrl,'Stored cross-site scripting: '+c.id,'The baseline view rendered cleanly without the marker. A harmless canary stored through the declared POST field "'+c.field+'" later executed when a fresh isolated viewer profile loaded the declared view. The canary performs no data access and makes no network request; impact depends on who can reach this view.','high');
                f.remediation='Encode stored values by output context on render, validate input on storage, and enforce an effective Content-Security-Policy; re-run this case after repair.';
                findings=[f];covered=[coverageKey(viewUrl,check)];
              }else{
                p.outcome='not_observed';
                p.summary=reflected?'The stored value was rendered without executing within the observation window (encoded, sanitized or policy-blocked)':'The stored value was not rendered in the declared view';
                covered=[coverageKey(viewUrl,check)];
              }
            }finally{await freshViewer.close();}
          }
        }
        p.requestIds=evidence.slice(offset).map(e=>e.id);
        await publish(p,findings,covered,viewer.page);
      }catch{signal.throwIfAborted();p.summary='Stored XSS probe did not complete';p.requestIds=evidence.slice(offset).map(e=>e.id);await publish(p,[],[],viewer.page);}
      finally{await viewer.close();await author.close();}
    }
    for(const assertion of options.accessAssertions){
      signal.throwIfAborted();const url=new URL(assertion.path,scope.seeds[0]).href,offset=evidence.length;
      const authenticated=await startContext(true),anonymous=await startContext(false);
      const visible=async(page:Page,selector:string)=>selector?await page.evaluate("(s => {const e=document.querySelector(s);return !!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';})("+JSON.stringify(selector)+")") as boolean:false;
      try{
        await load(authenticated,url,false);const authVisible=await visible(authenticated.page,assertion.selector);
        const anonymousOffset=evidence.length;
        await load(anonymous,url,false);const anonVisible=await visible(anonymous.page,assertion.selector),denied=await visible(anonymous.page,assertion.deniedSelector);
        const authenticatedTargetReached=authenticated.page.url()===url,anonymousTargetReached=anonymous.page.url()===url;
        const positiveControl=authenticatedTargetReached&&authVisible&&authenticated.state.status>=200&&authenticated.state.status<300;
        const denialComplete=clean(authenticated)&&anonymous.state.blocked===0&&anonymous.state.runtimeErrors===0&&evidence.slice(anonymousOffset).every(e=>!e.error&&((e.status>=200&&e.status<300)||[401,403].includes(e.status)));
        const exposed=positiveControl&&anonymousTargetReached&&anonVisible&&anonymous.state.status>=200&&anonymous.state.status<300,restricted=positiveControl&&anonymousTargetReached&&denialComplete&&!anonVisible&&(denied||[401,403].includes(anonymous.state.status));
        const p=proof("access",url,offset);p.outcome=exposed?"observed":restricted?"not_observed":"inconclusive";
        p.summary=exposed?"The declared protected element is visible in authenticated and fresh anonymous browser contexts":restricted?"Authenticated element is present; anonymous context shows an explicit access denial":!authenticatedTargetReached||!anonymousTargetReached?"Access navigation changed the requested route; original-target authorization remains unverified":"Access assertion lacks an authenticated positive control or an anonymous denial witness";
        p.observations={selector:assertion.selector,deniedSelector:assertion.deniedSelector,authenticatedVisible:authVisible,anonymousVisible:anonVisible,denialVisible:denied,authenticatedStatus:authenticated.state.status,anonymousStatus:anonymous.state.status,authenticatedTargetReached,anonymousTargetReached,authenticatedFinalUrl:redact(publicUrl(authenticated.page.url())),anonymousFinalUrl:redact(publicUrl(anonymous.page.url()))};
        const f=finding("browser_access_"+hash(assertion.selector).slice(0,12),url,"Declared protected UI is visible without a session",p.summary,"high");f.remediation="Enforce authorization in server APIs and validate the sensitivity of the observed element; hiding UI alone is insufficient.";
        await publish(p,exposed?[f]:[],p.outcome!=="inconclusive"?[coverageKey(url,f.check)]:[],anonymous.page);
      }catch{const p=proof("access",url,offset);p.summary="Browser access assertion failed to complete";await publish(p,[],[],anonymous.page);}finally{await authenticated.close();await anonymous.close();}
    }
  }finally{result.discovery=frontier.snapshot(!traversalFinished,redact);if(result.discovery.incomplete)result.incomplete=true;signal.removeEventListener("abort",abort);await browser?.close().catch(()=>{});denyProxy.closeAllConnections();await new Promise<void>(resolve=>denyProxy.close(()=>resolve()));}
}

export function readBrowserArtifact(root:string,proof:BrowserProof):Buffer {
  if(!proof.artifact)throw Error("Screenshot not available");
  const data=fs.readFileSync(taskPath(root,proof.artifact.path));
  if(hash(data)!==proof.artifact.sha256)throw Error("Screenshot integrity check failed");
  return data;
}
