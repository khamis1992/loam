import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import {createHash} from 'node:crypto';
import {taskPath} from '../server/taskWorkspace.js';
import {exportMobile,mobileHtml} from './export.js';
import {MobileError,readMobile,saveMobile,touchMobile,validateProject,checkCollectionCompatibility} from './store.js';
import {atomicJson,readCode,codeTag,seedVersions,versionSnapshot} from './versions.js';

const editable=/^(?:web\/[a-zA-Z0-9_./-]+\.(?:html|css|js|json)|expo\/[a-zA-Z0-9_./-]+\.(?:jsx?|json)|android\/[a-zA-Z0-9_./-]+\.(?:kt|kts|xml|properties)|README\.md|mobile\.json)$/;
export function safeSourcePath(value:unknown):string{
 if(typeof value!=='string'||value.length>240||value.split('/').some(x=>!x||x==='.'||x==='..'||x.startsWith('.'))||!editable.test(value))throw new MobileError('مسار الملف غير مسموح');
 return value;
}
export async function sourceFiles(root:string,taskId:string){
 const project=readMobile(root);if(!project)throw new MobileError('احفظ مشروعًا أولًا',404);
 const zip=await JSZip.loadAsync(await exportMobile(project,taskId)),files:Record<string,string>={};
 await Promise.all(Object.keys(zip.files).filter(name=>!zip.files[name]!.dir&&editable.test(name)).map(async name=>{files[name]=await zip.files[name]!.async('string');}));
 const html=mobileHtml(project,'loam-mobile-'+taskId),css=html.match(/<style>([\s\S]*?)<\/style>/)![1]!,js=html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
 files['web/index.html']=html.replace(/<style>[\s\S]*?<\/style>/,'<link rel="stylesheet" href="styles.css">').replace(/<script>[\s\S]*?<\/script>/,'<script src="app.js"></script>');
 files['web/styles.css']=css;files['web/app.js']=js;
 for(const [name,content]of Object.entries(readCode(root).files)){safeSourcePath(name);files[name]=content;}
 // Upgrade only the generated legacy entry point, retaining any user runtime edits.
 // The current schema is injected by the preview/export host, never frozen in an override.
 if(files['web/app.js']&&/\nmountMobile\(document\.getElementById\('mobile-app'\),[^\n]*\);\s*$/.test(files['web/app.js']!)){
  const boot=js.slice(js.indexOf('\nlet liveProject='));
  files['web/app.js']=files['web/app.js']!.replace(/\nmountMobile\(document\.getElementById\('mobile-app'\),[^\n]*\);\s*$/,boot);
 }
 return {project,files,tag:codeTag(readCode(root))};
}
export function assertSourceRevision(root:string,expected:unknown,tag:unknown){
 const project=readMobile(root);if(!project||project.revision!==expected||codeTag(readCode(root))!==tag)throw new MobileError('تغيّرت الملفات أو نسخة المشروع. احتفظ بمسودتك ثم حدّث الملفات.',409);
 return project;
}
export function saveSource(root:string,name:unknown,content:unknown,expected:unknown,tag:unknown,reset=false){
 const file=safeSourcePath(name),project=assertSourceRevision(root,expected,tag);
 if(typeof content!=='string'||Buffer.byteLength(content)>1_500_000||content.includes('\0'))throw new MobileError('الملف يجب أن يكون نصًا بحجم أقل من 1.5 MB');
 if(file==='mobile.json')return saveMobile(root,JSON.parse(content),expected,'تعديل مخطط التطبيق');
 const before=readCode(root),next=structuredClone(before);if(reset)delete next.files[file];else next.files[file]=content;
 if(Buffer.byteLength(JSON.stringify(next))>12_000_000)throw new MobileError('تجاوزت ملفات الشيفرة 12 MB');
 seedVersions(root,project);atomicJson(root,'.loam/mobile-code.json',next);
 try{return touchMobile(root,expected,(reset?'إعادة توليد ':'تعديل ')+file);}catch(e){atomicJson(root,'.loam/mobile-code.json',before);throw e;}
}
export function restoreVersion(root:string,id:unknown,expected:unknown,tag:unknown){
 const current=assertSourceRevision(root,expected,tag),snapshot=versionSnapshot(root,id),clean=validateProject(snapshot.project);
 checkCollectionCompatibility(current,clean);
 for(const [name,value]of Object.entries(snapshot.code.files)){safeSourcePath(name);if(typeof value!=='string')throw new MobileError('Invalid source snapshot');}
 const before=readCode(root);atomicJson(root,'.loam/mobile-code.json',snapshot.code);
 try{const p=saveMobile(root,clean,expected,'استعادة إصدار سابق');return p.revision===expected?touchMobile(root,expected,'استعادة ملفات إصدار سابق'):p;}
 catch(e){atomicJson(root,'.loam/mobile-code.json',before);throw e;}
}
export async function materializeSource(root:string,taskId:string,force=false){
 const source=await sourceFiles(root,taskId);
 const manifestPath=taskPath(root,'.loam/mobile-worktree-manifest.json'),previous:Record<string,string>=fs.existsSync(manifestPath)?JSON.parse(fs.readFileSync(manifestPath,'utf8')):{},next:Record<string,string>={},externalChanges:string[]=[];
 const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
 for(const [name,content]of Object.entries(source.files)){
  const target=taskPath(root,'.loam/mobile-worktree/'+name);fs.mkdirSync(path.dirname(target),{recursive:true});
  const exists=fs.existsSync(target),actual=exists?hash(fs.readFileSync(target,'utf8')):null;
  // A refresh updates generated files but never silently overwrites terminal edits.
  if(force||!exists||actual===previous[name]||actual===hash(content)){fs.writeFileSync(target,content);next[name]=hash(content);}
  else{externalChanges.push(name);if(previous[name])next[name]=previous[name];}
 }
 for(const name of Object.keys(previous))if(!Object.hasOwn(source.files,name)){
  const file=taskPath(root,'.loam/mobile-worktree/'+safeSourcePath(name));
  if(fs.existsSync(file)&&(force||hash(fs.readFileSync(file,'utf8'))===previous[name]))fs.unlinkSync(file);
 }
 atomicJson(root,'.loam/mobile-worktree-manifest.json',next);
 return {...source,externalChanges};
}
export function writeWorktreeFile(root:string,name:string,content:string){
 const target=taskPath(root,'.loam/mobile-worktree/'+safeSourcePath(name));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);
 const manifestPath=taskPath(root,'.loam/mobile-worktree-manifest.json'),manifest=fs.existsSync(manifestPath)?JSON.parse(fs.readFileSync(manifestPath,'utf8')):{};manifest[name]=createHash('sha256').update(content).digest('hex');atomicJson(root,'.loam/mobile-worktree-manifest.json',manifest);
}
export async function sourceExport(root:string,taskId:string){
 const {project,files}=await sourceFiles(root,taskId),zip=await JSZip.loadAsync(await exportMobile(project,taskId));
 for(const [name,content]of Object.entries(files))zip.file(name,content);
 let html=files['web/index.html']!;
 html=html.replace(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi,(whole,href)=>files['web/'+href]!==undefined&&href.endsWith('.css')?'<style>'+files['web/'+href]!.replace(/<\/style/gi,'<\\/style')+'</style>':whole);
 html=html.replace(/<script\b([^>]*)src=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,(_whole,_a,src)=>files['web/'+src]!==undefined?'<script>'+files['web/'+src]!.replace(/<\/script/gi,'<\\/script')+'</script>':'');
 html=html.replace(/<body([^>]*)>/i,`<body$1><script>window.__loamProject=${JSON.stringify(project).replace(/</g,'\\u003c')};window.__loamStorageKey=${JSON.stringify('loam-mobile-'+taskId)};</script>`);
 zip.file('index.html',html);
 return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
