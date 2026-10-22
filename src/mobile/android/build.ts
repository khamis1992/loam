import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import JSZip from 'jszip';
import {taskPath} from '../../server/taskWorkspace.js';
import {MobileError,readMobile} from '../store.js';
import {androidFiles,ANDROID_TOOLCHAIN} from './generate.js';
import {readCode} from '../versions.js';

type State='building'|'succeeded'|'failed'|'cancelled'|'unobserved'|'interrupted';
export type AndroidBuild={id:string;status:State;revision:number;applicationId:string;sourceHash:string;startedAt:string;finishedAt?:string;pid?:number;exitCode?:number|null;error?:string;apk?:{bytes:number;sha256:string};files:string[]};
const active=new Map<string,{job:AndroidBuild;child:ChildProcess;cancelled:boolean}>();
const exists=(p:string)=>{try{return fs.statSync(p).isFile();}catch{return false;}};
const dirs=(p:string)=>{try{return fs.readdirSync(p,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name);}catch{return [];}};
function javaPath(){const name=process.platform==='win32'?'java.exe':'java';const candidates=[...(process.env.JAVA_HOME?[path.join(process.env.JAVA_HOME,'bin',name)]:[]),...(process.env.PATH||'').split(path.delimiter).map(p=>path.join(p,name))];return candidates.find(exists)||'';}
function gradleJar(){const version=ANDROID_TOOLCHAIN.gradle;const homes=[process.env.LOAM_ANDROID_GRADLE_HOME,process.env.GRADLE_HOME].filter(Boolean) as string[];const base=path.join(os.homedir(),'.gradle/wrapper/dists');for(const dist of [`gradle-${version}-all`,`gradle-${version}-bin`])for(const hash of dirs(path.join(base,dist)))homes.push(path.join(base,dist,hash,'gradle-'+version));return homes.map(p=>path.join(p,'lib',`gradle-launcher-${version}.jar`)).find(exists)||'';}
export function androidEnvironment(){
 const sdk=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT||(process.platform==='win32'?path.join(process.env.LOCALAPPDATA||'','Android/Sdk'):path.join(os.homedir(),'Android/Sdk'));
 const java=javaPath(),gradle=gradleJar();const probe=java?spawnSync(java,['-version'],{encoding:'utf8',timeout:5000,windowsHide:true}):null;
 const major=Number((probe?.stderr||probe?.stdout||'').match(/version\s+"(\d+)/)?.[1]||0);
 const checks=[{id:'java',label:'Java JDK 17 أو أحدث',ready:!!probe&&probe.status===0&&major>=17},{id:'sdk',label:'Android SDK '+ANDROID_TOOLCHAIN.compileSdk,ready:exists(path.join(sdk,'platforms','android-'+ANDROID_TOOLCHAIN.compileSdk,'android.jar'))},{id:'gradle',label:'Gradle '+ANDROID_TOOLCHAIN.gradle,ready:!!gradle}];
 return {ready:checks.every(c=>c.ready),checks,toolchain:ANDROID_TOOLCHAIN,sdk,java,gradle};
}
function directory(root:string,id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new MobileError('Invalid build id');return taskPath(root,'.loam/android/builds/'+id);}
function persist(root:string,job:AndroidBuild){const dir=directory(root,job.id),temp=taskPath(dir,'status.tmp');fs.writeFileSync(temp,JSON.stringify(job,null,2));fs.renameSync(temp,taskPath(dir,'status.json'));}
export function androidBuildStatus(root:string,id?:string):{build:AndroidBuild|null;log:string}{
 if(!id){const latest=taskPath(root,'.loam/android/latest.json');if(!exists(latest))return {build:null,log:''};id=JSON.parse(fs.readFileSync(latest,'utf8')).id;}
 const dir=directory(root,id!),file=taskPath(dir,'status.json');if(!exists(file))throw new MobileError('Build not found',404);
 const job=JSON.parse(fs.readFileSync(file,'utf8')) as AndroidBuild;
 if(job.status==='building'&&active.get(root)?.job.id!==job.id){
  let alive=false;try{if(job.pid){process.kill(job.pid,0);alive=true;}}catch{}
  job.status=alive?'unobserved':'interrupted';job.error=alive?'توجد عملية بناء سابقة لم نعد نتابع سجل خروجها. انتظر انتهاءها قبل إعادة البناء.':'انقطعت متابعة البناء. أعد البناء للتحقق من الناتج.';
 }
 const logFile=taskPath(dir,'build.log');let log='';if(exists(logFile)){const fd=fs.openSync(logFile,'r');try{const size=fs.fstatSync(fd).size,buffer=Buffer.alloc(Math.min(size,64000));fs.readSync(fd,buffer,0,buffer.length,Math.max(0,size-buffer.length));log=buffer.toString('utf8');}finally{fs.closeSync(fd);}}
 return {build:job,log};
}
function terminate(child:ChildProcess){if(!child.pid||child.exitCode!==null)return;if(process.platform==='win32'){const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32/taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());}else child.kill('SIGTERM');}
export async function startAndroidBuild(root:string,identity:string,expectedRevision:unknown){
 if(active.size)throw new MobileError('يوجد بناء Android جارٍ. انتظر اكتماله أو أوقفه.',409);
 const previous=androidBuildStatus(root).build;if(previous?.status==='unobserved')throw new MobileError(previous.error!,409);
 const project=readMobile(root);if(!project||project.revision!==expectedRevision)throw new MobileError('تغيّر المشروع. احفظه مجددًا قبل البناء.',409);
 const env=androidEnvironment();if(!env.ready)throw new MobileError('بيئة Android غير مكتملة: '+env.checks.filter(c=>!c.ready).map(c=>c.label).join('، '));
 const generated=androidFiles(project,identity),id=randomUUID(),dir=directory(root,id),source=taskPath(dir,'source');
 let customized=false;for(const [name,content]of Object.entries(readCode(root).files))if(name.startsWith('android/')){
  const relative=name.slice(8);if(!Object.hasOwn(generated.files,relative))throw new MobileError('ملف Android غير معروف: '+relative);
  generated.files[relative]=content;customized=true;
 }
 if(customized){generated.sourceHash=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(generated.files).filter(([name])=>name!=='loam-build.json')))).digest('hex');generated.files['loam-build.json']=JSON.stringify({applicationId:generated.applicationId,revision:project.revision,sourceHash:generated.sourceHash,toolchain:ANDROID_TOOLCHAIN},null,2);}
 fs.mkdirSync(source,{recursive:true});
 for(const [name,content]of Object.entries(generated.files)){const file=taskPath(source,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);}
 fs.writeFileSync(taskPath(source,'local.properties'),'sdk.dir='+env.sdk.replaceAll('\\','/').replaceAll(':','\\:')+'\n');
 const job:AndroidBuild={id,status:'building',revision:project.revision,applicationId:generated.applicationId,sourceHash:generated.sourceHash,startedAt:new Date().toISOString(),files:Object.keys(generated.files)};
 persist(root,job);fs.writeFileSync(taskPath(root,'.loam/android/latest.json'),JSON.stringify({id}));
 const logFile=taskPath(dir,'build.log');fs.writeFileSync(logFile,'Loam native Android · revision '+project.revision+'\nSource SHA256 '+generated.sourceHash+'\n');let logBytes=0;
 const child=spawn(env.java,['-cp',env.gradle,'org.gradle.launcher.GradleMain','--no-daemon','--console=plain','--max-workers=2',':app:assembleDebug'],{cwd:source,windowsHide:true,env:{...process.env,ANDROID_HOME:env.sdk},stdio:['ignore','pipe','pipe']});
 const run={job,child,cancelled:false};active.set(root,run);job.pid=child.pid;persist(root,job);
 const append=(data:Buffer)=>{if(logBytes>4_000_000)return;logBytes+=data.length;try{fs.appendFileSync(logFile,data);}catch{job.error='تعذّر حفظ سجل البناء.';terminate(child);}};child.stdout?.on('data',append);child.stderr?.on('data',append);
 const timeout=setTimeout(()=>{job.error='تجاوز البناء 12 دقيقة؛ أوقفناه دون إعلان نجاح.';terminate(child);},12*60*1000);timeout.unref();
 let finished=false;
 const finish=async(code:number|null,error?:string)=>{if(finished)return;finished=true;clearTimeout(timeout);job.exitCode=code;job.finishedAt=new Date().toISOString();
  try{
   if(run.cancelled){job.status='cancelled';job.error='أُوقف البناء.';}
   else if(code!==0||error||job.error){job.status='failed';job.error=error||job.error||'فشل البناء. راجع سجل المترجم.';}
   else{for(const [name,content]of Object.entries(generated.files))if(fs.readFileSync(taskPath(source,name),'utf8')!==content)throw Error('تغيّر المصدر أثناء البناء. أعد البناء من نسخة محفوظة.');const file=taskPath(source,'app/build/outputs/apk/debug/app-debug.apk');const bytes=fs.readFileSync(file);const zip=await JSZip.loadAsync(bytes);if(!zip.file('classes.dex')||!zip.file('AndroidManifest.xml'))throw Error('لم ينتج ملف APK صالح');fs.writeFileSync(taskPath(dir,'app-debug.apk'),bytes);job.apk={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};job.status='succeeded';}
  }catch(e){job.status='failed';job.error=e instanceof Error?e.message:String(e);}finally{try{persist(root,job);}catch(e){console.error('Android build status could not be saved',e);}finally{active.delete(root);}}
 };
 child.on('error',error=>void finish(null,error.message));child.on('close',code=>void finish(code));return job;
}
export function cancelAndroidBuild(root:string,id:string){const run=active.get(root);if(!run||run.job.id!==id)throw new MobileError('لا توجد عملية بناء جارية لهذا الطلب.',409);run.cancelled=true;terminate(run.child);return {stopping:true};}
export async function androidArtifact(root:string,id:string,kind:'apk'|'source'){
 const {build}=androidBuildStatus(root,id);if(!build)throw new MobileError('Build not found',404);const dir=directory(root,id);
 if(kind==='apk'){if(build.status!=='succeeded'||!build.apk)throw new MobileError('لم يكتمل بناء APK بنجاح.',409);const bytes=fs.readFileSync(taskPath(dir,'app-debug.apk'));if(createHash('sha256').update(bytes).digest('hex')!==build.apk.sha256)throw new MobileError('تغيّر ملف APK بعد البناء. أعد البناء.',409);return bytes;}
 const zip=new JSZip();for(const file of build.files)zip.file(file,fs.readFileSync(taskPath(taskPath(dir,'source'),file)));return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
