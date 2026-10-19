import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {PreviewService} from '../preview/serve.js';
import {resolveRead,resolveWrite} from '../policy/paths.js';
import {readMobile,validateProject,type MobileProject} from '../mobile/store.js';
import {exportMobile,mobileHtml} from '../mobile/export.js';
import {startAndroidBuild,androidBuildStatus} from '../mobile/android/build.js';
import type {Tool,ToolContext} from './registry.js';
import {str} from './registry.js';

// Legacy tool names remain compatible; all results come from real project artifacts.
// A web preview is not a simulator, and a source export is not a compiled native build.
export function createRorkTools(preview:PreviewService):Tool[]{
 async function deliver(project:MobileProject,ctx:ToolContext){
  const identity=ctx.taskId||ctx.workspace;
  const dir=resolveWrite(ctx.workspace,'mobile-exports/'+randomUUID());
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'mobile-source.zip'),await exportMobile(project,identity));
  fs.writeFileSync(path.join(dir,'index.html'),mobileHtml(project,'loam-mobile-export-'+identity));
  const instance=await preview.start(dir);
  return {ok:true,content:JSON.stringify({root:dir,previewUrl:instance.url,previewType:'web',sourceArchive:path.join(dir,'mobile-source.zip'),revision:project.revision,targets:['web','Android Kotlin/Compose source','Expo source'],compiled:false,limitations:'Source export only. Use Android build in Mobile Studio for an actual debug APK. No iOS build, QR deployment or store publishing has been performed.'})};
 }
 return [{name:'rork_build',description:'Compatibility adapter for the real Loam Mobile project in this task. Default action export produces its working web preview and Android Kotlin/Compose + Expo source ZIP. Create/edit the project with loam_mobile first. android_build starts an actual local Gradle debug APK build and requires expectedRevision; poll android_status for terminal status. Does not generate a fixed demo or claim untested platforms.',parameters:{type:'object',properties:{action:{type:'string',enum:['export','android_build','android_status']},expectedRevision:{type:'integer',minimum:1}}},async run(args,ctx){
  try{
   if(!ctx.taskId)throw Error('An active task is required');
   if(args.action==='android_status')return {ok:true,content:JSON.stringify(androidBuildStatus(ctx.workspace))};
   if(args.action==='android_build')return {ok:true,content:JSON.stringify({build:await startAndroidBuild(ctx.workspace,ctx.taskId,args.expectedRevision),instruction:'Poll android_status; building is not success. Download the APK from Mobile Studio only after succeeded.'})};
   if(args.action!==undefined&&args.action!=='export')throw Error('Unsupported action');
   const project=readMobile(ctx.workspace);if(!project)throw Error('No mobile project exists. Create it with loam_mobile first; a prompt alone does not create a native application.');
   return await deliver(project,ctx);
  }catch(e){return {ok:false,content:e instanceof Error?e.message:String(e)};}
 }},{name:'rork_from_web',description:'Export a validated Loam mobile.json project from a folder as mobile source and a web preview. Arbitrary HTML/Lovable/React-to-native conversion is not implemented; it must first be modeled with loam_mobile. Preserves screen content and navigation rather than substituting a demo.',parameters:{type:'object',properties:{sourceDir:{type:'string',description:'Workspace folder containing a Loam mobile.json project.'}},required:['sourceDir']},async run(args,ctx){
  try{const file=resolveRead(ctx.workspace,path.join(str(args,'sourceDir','.'),'mobile.json'),false);if(!fs.existsSync(file))throw Error('This folder has no mobile.json. Automatic HTML-to-native conversion is not implemented. Model the actual screens and actions with loam_mobile, then export/build them.');const raw=JSON.parse(fs.readFileSync(file,'utf8'));const project:MobileProject={...validateProject(raw),revision:Number.isSafeInteger(raw.revision)&&raw.revision>0?raw.revision:1};return await deliver(project,ctx);}catch(e){return {ok:false,content:e instanceof Error?e.message:String(e)};}
 }}];
}
