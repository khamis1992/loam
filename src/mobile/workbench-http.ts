import type {IncomingMessage,ServerResponse} from 'node:http';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {UI_DIR} from '../config.js';
import {getTask} from '../server/db.js';
import {requireTaskWorkspace,taskPath} from '../server/taskWorkspace.js';
import {MobileError,readMobile,mobileHistory} from './store.js';
import {atomicJson,readCode,codeTag,listVersions,seedVersions,bookmarkVersion} from './versions.js';
import {sourceFiles,saveSource,restoreVersion,materializeSource,writeWorktreeFile,safeSourcePath,assertSourceRevision} from './source.js';

const routes=['/api/mobile/source','/api/mobile/versions','/api/mobile/source-preview','/api/mobile/releases','/api/mobile/git'];
type Release={id:string;label:string;createdAt:string;revision:number};
function releases(root:string):{active:string|null;items:Release[]}{const file=taskPath(root,'.loam/mobile-releases.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{active:null,items:[]};}
const json=(res:ServerResponse,value:unknown)=>{res.writeHead(200,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
const safeJson=(v:unknown)=>JSON.stringify(v).replace(/</g,'\\u003c');
export function previewHtml(files:Record<string,string>){
 const bridge=`<script>window.__loamProject=${safeJson(JSON.parse(files['mobile.json']!))};${fs.readFileSync(path.join(UI_DIR,'mobile-sandbox.js'),'utf8')}</script>`;
 let html=files['web/index.html']!;
 // Every executable asset is inlined into an opaque-origin sandbox. No Loam API access.
 html=html.replace(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi,(whole,href)=>files['web/'+href]!==undefined&&href.endsWith('.css')?'<style>'+files['web/'+href]!.replace(/<\/style/gi,'<\\/style')+'</style>':whole);
 html=html.replace(/<script\b([^>]*)src=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,(_whole,_a,src)=>files['web/'+src]!==undefined?'<script>'+files['web/'+src]!.replace(/<\/script/gi,'<\\/script')+'</script>':'');
 html=html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi,(_whole,attrs,code)=>/type\s*=\s*["']application\/json/.test(attrs)?_whole:'<script>window.__loamReady.then(async()=>{\n'+code+'\n}).catch(e=>window.__loamReport(e));</script>');
 return '<!doctype html>'+bridge+html.replace(/<!doctype[^>]*>/i,'');
}
export async function handleMobileWorkbench(req:IncomingMessage,res:ServerResponse,url:URL,workspace:string){
 if(!routes.includes(url.pathname))return false;
 try{
  let body:Record<string,unknown>={};
  if(req.method==='POST'){
   if(!req.headers['content-type']?.startsWith('application/json'))throw new MobileError('JSON required',415);
   let raw='';for await(const c of req){raw+=c;if(Buffer.byteLength(raw)>2_000_000)throw new MobileError('Body too large',413);}
   body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw new MobileError('Expected object');
  }
  const taskId=body.taskId??url.searchParams.get('taskId');if(typeof taskId!=='string'||!taskId)throw new MobileError('taskId required');
  const task=getTask(taskId);if(!task)throw new MobileError('Task not found',404);if(task.mode!=='build')throw new MobileError('Build task required',403);
  const root=requireTaskWorkspace(taskId,workspace),project=readMobile(root);if(!project)throw new MobileError('احفظ مشروعًا أولًا',404);
  const post=req.method==='POST',route=url.pathname;
  if(route==='/api/mobile/source'){
   if(post){
    let content=body.content;
    if(body.action==='import'){const name=safeSourcePath(body.path),file=taskPath(root,'.loam/mobile-worktree/'+name);if(fs.statSync(file).size>1_500_000)throw new MobileError('الملف كبير');content=fs.readFileSync(file,'utf8');}
    const saved=saveSource(root,body.path,content,body.expectedRevision,body.tag,body.action==='reset');
    const source=await sourceFiles(root,taskId);if(body.path!=='mobile.json')writeWorktreeFile(root,String(body.path),source.files[String(body.path)]!);
    json(res,{...source,project:saved,history:mobileHistory(root)});
   }else{const source=await materializeSource(root,taskId);json(res,{...source,overrides:Object.keys(readCode(root).files)});}
  }else if(route==='/api/mobile/versions'){
   seedVersions(root,project);
   if(post&&body.action==='restore'){const saved=restoreVersion(root,body.id,body.expectedRevision,body.tag);await materializeSource(root,taskId,true);json(res,{project:saved,history:mobileHistory(root),tag:codeTag(readCode(root)),versions:listVersions(root)});}
   else if(post&&body.action==='bookmark')json(res,{versions:bookmarkVersion(root,body.id,body.value)});
   else if(post)throw new MobileError('Unknown version action');
   else json(res,{versions:listVersions(root),tag:codeTag(readCode(root))});
  }else if(route==='/api/mobile/source-preview'){
   if(post)throw new MobileError('GET required',405);
   let files:Record<string,string>;
   const id=url.searchParams.get('releaseId');if(id){if(!releases(root).items.some(x=>x.id===id))throw new MobileError('Release not found',404);files=JSON.parse(fs.readFileSync(taskPath(root,'.loam/mobile-release-'+id+'.json'),'utf8')).files;}
   else files=(await sourceFiles(root,taskId)).files;
   res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-ancestors 'self'; form-action 'none'; base-uri 'none'"});res.end(previewHtml(files));
  }else if(route==='/api/mobile/releases'){
   const data=releases(root);
   if(post&&body.action==='publish'){
    assertSourceRevision(root,body.expectedRevision,body.tag);const source=await sourceFiles(root,taskId),id=randomUUID();
    atomicJson(root,'.loam/mobile-release-'+id+'.json',{project,files:source.files});
    data.items.push({id,revision:project.revision,label:project.title,createdAt:new Date().toISOString()});data.active=id;atomicJson(root,'.loam/mobile-releases.json',data);
   }else if(post&&body.action==='activate'){if(!data.items.some(x=>x.id===body.id))throw new MobileError('Release not found',404);data.active=String(body.id);atomicJson(root,'.loam/mobile-releases.json',data);}
   else if(post)throw new MobileError('Unknown release action');
   const id=url.searchParams.get('releaseId')||data.active;
   const item=id?data.items.find(x=>x.id===id):null;if(id&&!item)throw new MobileError('Release not found',404);
   const saved=item?JSON.parse(fs.readFileSync(taskPath(root,'.loam/mobile-release-'+item.id+'.json'),'utf8')).project:null;
   json(res,{...data,project:saved,url:id?'/mobile-published.html?taskId='+encodeURIComponent(taskId)+'&releaseId='+id:null});
  }else if(route==='/api/mobile/git'){
   await materializeSource(root,taskId);const cwd=taskPath(root,'.loam/mobile-worktree');taskPath(root,'.loam/mobile-worktree/.git');
   const git=(args:string[])=>execFileSync('git',['-c','core.hooksPath=NUL','-c','core.fsmonitor=false','-c','credential.helper=',...args],{cwd,encoding:'utf8',timeout:15000,maxBuffer:1_000_000,windowsHide:true,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'}}).trim();
   let exists=fs.existsSync(taskPath(root,'.loam/mobile-worktree/.git'));
   if(post&&body.action==='init'){if(!exists)git(['init']);exists=true;}
   else if(post&&body.action==='commit'){
    if(!exists)throw new MobileError('هيّئ المستودع أولًا');if(typeof body.message!=='string'||!body.message.trim()||body.message.length>160)throw new MobileError('اكتب وصفًا للحفظ');
    const {files}=await sourceFiles(root,taskId);git(['add','--',...Object.keys(files)]);git(['-c','user.name=Loam Local','-c','user.email=loam@localhost','commit','-m',body.message]);
   }else if(post)throw new MobileError('Unknown git action');
   json(res,{initialized:exists,status:exists?git(['status','--short']):'',log:exists?(()=>{try{return git(['log','-8','--format=%h %s']);}catch{return '';}})():'',note:'Git محلي داخل مجلد مصدر التطبيق. الربط والدفع إلى GitHub يحتاجان إعداد مستودع بعيد من الطرفية.'});
  }
 }catch(e){res.writeHead(e instanceof MobileError?e.status:400,{'content-type':'application/json; charset=utf-8'});res.end(safeJson({error:e instanceof Error?e.message:String(e)}));}
 return true;
}
