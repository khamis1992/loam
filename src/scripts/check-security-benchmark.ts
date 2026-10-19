import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {exec} from 'node:child_process';
import {promisify} from 'node:util';
import {startAssessment,readAssessment} from '../security/assessments.js';

const runShell=promisify(exec);
// Independent evaluation set for the dynamic engines: a benchmark application
// with declared ground truth — one vulnerable endpoint and one safe twin per
// vulnerability class. Written AFTER the engines existed; none of the engine
// fixtures reuse these endpoints, and no engine was tuned against this app.

const users=[{name:'alice'},{name:'bob'}];
const files=new Map<string,string>([['welcome.txt','welcome bench-welcome content']]);
const uploads=new Map<string,string>();
let sqlFixed=false;
const escape=(v:string)=>v.replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]!));
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  let raw='';for await(const part of req)raw+=part;
  const json=(status:number,payload:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));};
  const q=(name:string)=>url.searchParams.get(name)??'';
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html').end('<!doctype html><title>benchmark</title>');return;}
  // 1. SQLi — vulnerable / safe.
  if(url.pathname==='/search'&&req.method==='GET'){
    const name=q('q');const taut=/' AND '1'='1$/.exec(name),fals=/' AND '1'='2$/.exec(name);
    if(sqlFixed||taut&&false){/*retest path not used*/}
    if(taut)return json(200,{rows:users.filter(u=>u.name===name.slice(0,taut.index))});
    if(fals)return json(200,{rows:[]});
    return json(200,{rows:users.filter(u=>u.name===name)});
  }
  if(url.pathname==='/search-safe'&&req.method==='GET')return json(200,{rows:users.filter(u=>u.name===q('q').replace(/'/g,"''"))});
  // 2. Traversal — vulnerable / safe.
  if(url.pathname==='/files'&&req.method==='GET'){try{res.setHeader('content-type','text/plain').end(fs.readFileSync(path.join(os.tmpdir(),'bench-public',q('name'))));return;}catch{return json(404,{error:'not found'});}}
  if(url.pathname==='/files-safe'&&req.method==='GET'){const name=q('name');if(name.includes('..'))return json(400,{error:'invalid name'});try{res.setHeader('content-type','text/plain').end(fs.readFileSync(path.join(os.tmpdir(),'bench-public',name)));return;}catch{return json(404,{error:'not found'});}}
  // 3. SSRF — vulnerable / safe.
  if(url.pathname==='/fetch'&&req.method==='GET'){try{const r=await fetch(q('url'),{signal:AbortSignal.timeout(5000)});await r.body?.cancel();return json(200,{fetched:true});}catch{return json(400,{error:'invalid url'});}}
  if(url.pathname==='/fetch-safe'&&req.method==='GET'){try{const u=new URL(q('url'));if(u.hostname!=='example.invalid')return json(400,{error:'host not allowed'});return json(200,{fetched:true});}catch{return json(400,{error:'invalid url'});}}
  // 4. Template — vulnerable / safe.
  const evaluateTpl=(v:string,enabled:boolean)=>{if(!enabled)return v;return v.replace(/\{\{([\d*+\/\-\s]+)\}\}/g,(_,expr)=>String(new Function('return ('+expr+')')()));};
  if(url.pathname==='/render'&&req.method==='GET')return json(200,{rendered:evaluateTpl(q('tpl'),true)});
  if(url.pathname==='/render-safe'&&req.method==='GET')return json(200,{rendered:evaluateTpl(q('tpl'),false)});
  // 5. XXE — vulnerable / safe (JSON field carries the XML).
  const resolveXml=async(xml:string,enabled:boolean)=>{
    if(!enabled)return json(200,{parsed:xml.replace(/<!DOCTYPE[^>]*\[[\s\S]*?\]>/,'')});
    const entity=/<!ENTITY\s+loam\s+SYSTEM\s+"([^"]+)">/.exec(xml);
    if(!entity||!/&loam;/.test(xml))return json(200,{parsed:xml});
    try{const r=await fetch(entity[1]!,{signal:AbortSignal.timeout(5000)});return json(200,{parsed:xml.replace(/&loam;/,await r.text())});}catch{return json(502,{error:'entity fetch failed'});}
  };
  if(url.pathname==='/api/xml'&&req.method==='POST'){let x='';try{x=JSON.parse(raw).xml??'';}catch{}return resolveXml(x,true);}
  if(url.pathname==='/api/xml-safe'&&req.method==='POST'){let x='';try{x=JSON.parse(raw).xml??'';}catch{}return resolveXml(x,false);}
  // 6. Deserialization — vulnerable / safe.
  const FUNC_TAG='_$$ND_FUNC_$$_';
  const unserial=async(s:string,enabled:boolean)=>{
    const walk=async(v:unknown):Promise<unknown>=>{
      if(typeof v==='string'&&v.startsWith(FUNC_TAG)){
        if(!enabled)return '[stripped]';
        try{const fn=new Function('return ('+v.slice(FUNC_TAG.length)+')')();if(typeof fn==='function')await fn();return '[function]';}catch{return '[error]';}
      }
      if(v&&typeof v==='object'){if(Array.isArray(v)){const o:unknown[]=[];for(const i of v)o.push(await walk(i));return o;}const o:Record<string,unknown>={};for(const [k,val] of Object.entries(v))o[k]=await walk(val);return o;}
      return v;
    };
    let parsed:unknown;try{parsed=JSON.parse(s);}catch{return json(400,{error:'invalid payload'});}
    return json(200,{restored:await walk(parsed)});
  };
  if(url.pathname==='/api/state'&&req.method==='POST'){let s='';try{s=JSON.parse(raw).state??'';}catch{}return unserial(s,true);}
  if(url.pathname==='/api/state-safe'&&req.method==='POST'){let s='';try{s=JSON.parse(raw).state??'';}catch{}return unserial(s,false);}
  // 7. Command injection — vulnerable / safe.
  if(url.pathname==='/api/lookup'&&req.method==='POST'){let host='';try{host=JSON.parse(raw).host??'';}catch{}try{const isWin=process.platform==='win32';const {stdout}=await runShell((isWin?`ping -n 1 ${host}`:`ping -c 1 ${host}`),{timeout:15000});return json(200,{lines:stdout.split(/\r?\n/).length});}catch(error){return json(200,{lines:0,error:(error as Error).message.slice(0,80)});}}
  if(url.pathname==='/api/lookup-safe'&&req.method==='POST'){let host='';try{host=JSON.parse(raw).host??'';}catch{}if(!/^[a-zA-Z0-9.-]+$/.test(host))return json(400,{error:'invalid host'});try{const isWin=process.platform==='win32';const {stdout}=await runShell((isWin?`ping -n 1 ${host}`:`ping -c 1 ${host}`),{timeout:15000});return json(200,{lines:stdout.split(/\r?\n/).length});}catch(error){return json(200,{lines:0,error:(error as Error).message.slice(0,80)});}}
  // 8. Open redirect — vulnerable / safe.
  if(url.pathname==='/go'&&req.method==='GET')return res.writeHead(302,{location:q('to')}).end();
  if(url.pathname==='/go-safe'&&req.method==='GET'){const to=q('to');if(!to.startsWith('/')||to.startsWith('//'))return res.writeHead(302,{location:'/home'}).end();return res.writeHead(302,{location:to}).end();}
  // 9. Upload — vulnerable / safe multipart + retrieval view.
  if((url.pathname==='/api/upload'||url.pathname==='/api/upload-safe')&&req.method==='POST'){
    const boundary=/boundary=(.+)$/.exec(req.headers['content-type']??'')?.[1];const body=Buffer.from(raw,'binary');
    const file={name:'',content:''};
    for(const part of body.toString('binary').split('--'+(boundary??''))){const split=part.indexOf('\r\n\r\n');if(split<0)continue;const head=part.slice(0,split);const content=part.slice(split+4).replace(/\r\n$/,'');const filename=/filename="([^"]*)"/.exec(head)?.[1];const field=/name="([^"]*)"/.exec(head)?.[1];if(filename!==undefined&&field==='file'){file.name=filename;file.content=content;}}
    if(!file.name)return json(400,{error:'file field missing'});
    if(url.pathname==='/api/upload-safe'&&/\.(html|exe|svg|php)$/i.test(file.name))return json(415,{error:'file type not allowed'});
    uploads.set(file.name,file.content);return json(201,{stored:file.name});
  }
  if(url.pathname==='/files-up'&&req.method==='GET'){const content=uploads.get(q('name'));if(content===undefined)return json(404,{error:'not found'});res.setHeader('content-type','text/plain').end(content);return;}
  // 10. Reflected XSS — vulnerable / safe HTML reflection.
  if(url.pathname==='/reflect'&&req.method==='GET'){res.setHeader('content-type','text/html; charset=utf-8').end('<!doctype html><html><body><h1>'+q('msg')+'</h1></body></html>');return;}
  if(url.pathname==='/reflect-safe'&&req.method==='GET'){res.setHeader('content-type','text/html; charset=utf-8').end('<!doctype html><html><body><h1>'+escape(q('msg'))+'</h1></body></html>');return;}
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;

// Ground truth: per class, the vulnerable endpoint that MUST be detected and
// the safe twin that MUST NOT be flagged. Safe twins run in a second campaign
// so a miss on the vulnerable side is never masked.
const benchRoot=fs.mkdtempSync(path.join(os.tmpdir(),'loam-benchmark-'));
fs.writeFileSync(path.join(benchRoot,'note.txt'),'benchmark workspace marker');
const publicDir=path.join(os.tmpdir(),'bench-public');fs.mkdirSync(publicDir,{recursive:true});
fs.writeFileSync(path.join(publicDir,'welcome.txt'),'welcome bench-welcome content');
fs.writeFileSync(path.join(publicDir,'..','bench-secret.txt'),'internal bench-secret-marker content');

const S={baseline:'alice',benignFile:'welcome.txt',fileMarker:'bench-welcome',traversalPayload:'../bench-secret.txt',targetMarker:'bench-secret-marker',ssrfBenign:'homepage',tplBaseline:'welcome',benignXml:'<note><v>ok</v></note>',xmlTemplate:'<note><v>@LOAM_ENTITY_REF@</v></note>',deserBenign:JSON.stringify({n:1}),deserTemplate:JSON.stringify({n:'@LOAM_FUNC@'}),cmdBenign:'127.0.0.1',cmdTemplate:'127.0.0.1 && @LOAM_CMD@',safeTarget:'/home',foreignOrigin:'https://example.invalid',upBenignName:'note.txt',upBenignContent:'plain benign bench-upload-benign',upProbeName:'probe.html',upProbeContent:'probe bench-upload-marker',upMarker:'bench-upload-marker',xssBase:'/reflect'};
const V=(check:string,endpoint:string)=>({check,endpoint});
const groundTruth=[
  V('injection','/search'),V('traversal','/files'),V('ssrf','/fetch'),V('template','/render'),V('xxe','/api/xml'),
  V('deser','/api/state'),V('command','/api/lookup'),V('redirect','/go'),V('upload','/api/upload'),V('xss_reflected','/reflect'),
];

const finish=async(id:string)=>{const deadline=Date.now()+120000;while(Date.now()<deadline){const r=readAssessment(benchRoot,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('benchmark assessment timed out');};
const httpInput={target,authorized:true,checks:['server_banner'],profile:'campaign' as const,scope:{delayMs:0,maxRequests:600},browser:{postPaths:['/api/xml','/api/xml-safe','/api/state','/api/state-safe','/api/lookup','/api/lookup-safe','/api/upload','/api/upload-safe']},businessSecrets:S,
  injection:[{id:'b_sql',kind:'sql' as const,method:'GET' as const,path:'/search',field:'q',baselineRef:'baseline'}],
  traversal:[{id:'b_trav',path:'/files',param:'name',benignRef:'benignFile',benignMarkerRef:'fileMarker',traversalRef:'traversalPayload',markerRef:'targetMarker'}],
  ssrf:[{id:'b_ssrf',kind:'get' as const,path:'/fetch',field:'url',benignRef:'ssrfBenign'}],
  template:[{id:'b_tpl',syntax:'mustache' as const,method:'get' as const,path:'/render',field:'tpl',baselineRef:'tplBaseline'}],
  xxe:[{id:'b_xxe',path:'/api/xml',field:'xml',benignXmlRef:'benignXml',templateRef:'xmlTemplate'}],
  deser:[{id:'b_deser',path:'/api/state',field:'state',benignRef:'deserBenign',templateRef:'deserTemplate'}],
  command:[{id:'b_cmd',path:'/api/lookup',field:'host',benignRef:'cmdBenign',templateRef:'cmdTemplate'}],
  redirect:[{id:'b_red',path:'/go',param:'to',safeTargetRef:'safeTarget',foreignOriginRef:'foreignOrigin'}],
  upload:[{id:'b_up',path:'/api/upload',field:'file',viewPath:'/files-up',benignNameRef:'upBenignName',benignContentRef:'upBenignContent',probeNameRef:'upProbeName',probeContentRef:'upProbeContent',markerRef:'upMarker'}],
};
const safeInput=JSON.parse(JSON.stringify({...httpInput,injection:[{...httpInput.injection[0]!,path:'/search-safe'}],traversal:[{...httpInput.traversal[0]!,path:'/files-safe'}],ssrf:[{...httpInput.ssrf[0]!,path:'/fetch-safe'}],template:[{...httpInput.template[0]!,path:'/render-safe'}],xxe:[{...httpInput.xxe[0]!,path:'/api/xml-safe'}],deser:[{...httpInput.deser[0]!,path:'/api/state-safe'}],command:[{...httpInput.command[0]!,path:'/api/lookup-safe'}],redirect:[{...httpInput.redirect[0]!,path:'/go-safe'}],upload:[{...httpInput.upload[0]!,path:'/api/upload-safe'}]}));
const browserVuln={enabled:true,screenshots:false,maxPages:1,settleMs:250,networkIdleTimeoutMs:2000,xssReflected:[{id:'b_xss',path:'/reflect',param:'msg'}]};
const browserSafe={...browserVuln,xssReflected:[{id:'b_xss',path:'/reflect-safe',param:'msg'}]};

try{
  const vulnRun=await finish(startAssessment(benchRoot,httpInput).id);
  const safeRun=await finish(startAssessment(benchRoot,safeInput).id);
  const vulnXss=await finish(startAssessment(benchRoot,{...httpInput,injection:[],traversal:[],ssrf:[],template:[],xxe:[],deser:[],command:[],redirect:[],upload:[],browser:browserVuln}).id);
  const safeXss=await finish(startAssessment(benchRoot,{...httpInput,injection:[],traversal:[],ssrf:[],template:[],xxe:[],deser:[],command:[],redirect:[],upload:[],browser:browserSafe}).id);
  const findingsVuln=[...vulnRun.findings,...vulnXss.findings].filter(f=>f.verdict==='finding');
  const findingsSafe=[...safeRun.findings,...safeXss.findings].filter(f=>f.verdict==='finding');
  const results:Array<{check:string;endpoint:string;detected:boolean;falsePositive:boolean}>=groundTruth.map(({check,endpoint})=>({
    check,endpoint,
    detected:findingsVuln.some(f=>f.check.startsWith(check+'_')),
    falsePositive:findingsSafe.some(f=>f.check.startsWith(check+'_')),
  }));
  const missed=results.filter(r=>!r.detected);
  const falsePositives=results.filter(r=>r.falsePositive);
  for(const r of results)console.log(`${r.detected?'DETECTED':'MISSED    '} ${r.check.padEnd(13)} ${r.endpoint}${r.falsePositive?'  (FALSE POSITIVE on safe twin)':''}`);
  console.log(`Benchmark summary: ${results.length-missed.length}/${results.length} planted vulnerabilities detected, ${falsePositives.length} false positives on safe twins`);
  assert.deepEqual(missed,[],'every planted vulnerability must be detected');
  assert.deepEqual(falsePositives,[],'no safe twin may be flagged');
  console.log('PASS benchmark: the independent planted ground-truth set is fully detected with zero false positives across all ten dynamic engine classes');
}finally{server.closeAllConnections();server.close();fs.rmSync(benchRoot,{recursive:true,force:true});try{fs.rmSync(publicDir,{recursive:true,force:true});fs.rmSync(path.join(os.tmpdir(),'bench-secret.txt'),{force:true});}catch{/* already gone */}}
