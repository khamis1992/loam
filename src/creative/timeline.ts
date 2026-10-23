import {renderFrames,renderAudio,joinAudio,type RenderProject} from './offline-render.js';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {spawn, type ChildProcess} from 'node:child_process';
import type {IncomingMessage,ServerResponse} from 'node:http';
import JSZip from 'jszip';
import {chromium,type Browser} from 'playwright';
import {ROOT} from '../config.js';
import {getTask,listTasks} from '../server/db.js';
import {requireTaskWorkspace,taskPath} from '../server/taskWorkspace.js';
// The same structural validator is used by the editor and persistent worker.
// @ts-expect-error plain browser module
import {validateTimeline,timelineDuration} from '../../ui/creative-timeline-model.js';
import {BoundedMap} from '../memory/cache.js';
import {registerCacheStats} from '../memory/stats.js';

/** J6 hard caps: recent export jobs and recent proxy-preview jobs in RAM. */
const TIMELINE_JOB_CAPACITY=64;
const TIMELINE_PROXY_CAPACITY=64;

type Project=RenderProject;
type Job={rendererVersion?:number;id:string;taskId:string;title:string;format:'mp4'|'webm'|'wav'|'stems';loudnessTarget?:number;state:'queued'|'running'|'done'|'failed'|'canceled';completed:number;total:number;duration:number;project:Project;message:string;path?:string;createdAt:number};
type ProxyJob={id:string;taskId:string;source:string;state:'queued'|'running'|'done'|'failed'|'canceled';message:string;width:number;child?:ChildProcess;result?:{path:string;bytes:number;width:number};createdAt:number};
const segment=5;
const atomic=(file:string,value:unknown)=>{const temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(value));fs.renameSync(temp,file);};
const json=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
async function body(req:IncomingMessage){let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>2_000_000)throw Error('بيانات المشروع كبيرة جدًا؛ يجب رفع الوسائط كأصول مستقلة.');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString());}

export class TimelineService{
  /** Live/recent export jobs (J6: bounded). `start()` rehydrates finished jobs
   *  from disk and `getRenderJob`-style reads fall back to `job.json`, so a
   *  long-lived editor process only needs the most recent jobs in RAM. */
  private jobs=new BoundedMap<string,Job>(TIMELINE_JOB_CAPACITY,'timeline-jobs');private working=false;private stopped=false;private browser?:Browser;private process?:ChildProcess;private base='';private currentJob?:string;
  constructor(private workspace:string){
    registerCacheStats('timeline-jobs',()=>this.jobs.stats());
    registerCacheStats('timeline-proxy-jobs',()=>this.proxyJobs.stats());
  }
  private root(taskId:string){if(getTask(taskId)?.mode!=='media')throw Error('يلزم مشروع في استديو صمّم.');return requireTaskWorkspace(taskId,this.workspace);}
  private dir(job:Job){const dir=taskPath(this.root(job.taskId),`.timeline-jobs/${job.id}`);fs.mkdirSync(dir,{recursive:true});return dir;}
  private persist(job:Job){atomic(path.join(this.dir(job),'job.json'),job);}
  private public(job:Job){const {project,...result}=job;return {...result,progress:job.total?job.completed/job.total:0};}
  start(base:string){this.base=base;for(const task of listTasks()){if(task.mode!=='media'||!task.workspace)continue;try{const dir=taskPath(task.workspace,'.timeline-jobs');if(!fs.existsSync(dir))continue;for(const id of fs.readdirSync(dir)){if(!/^[a-f\d-]{36}$/.test(id))continue;try{const j=JSON.parse(fs.readFileSync(taskPath(task.workspace,`.timeline-jobs/${id}/job.json`),'utf8')) as Job;if(j.id!==id||j.taskId!==task.id)continue;if(j.state==='running'){j.state='queued';j.message='استكمال من آخر جزء محفوظ';}this.jobs.set(j.id,j);}catch{}}}catch{}}void this.pump();}
  async close(){this.stopped=true;this.process?.kill();await this.browser?.close().catch(()=>{});}
  private checked(input:unknown,taskId:string):Project{const project=validateTimeline({...input as object,taskId}) as Project;for(const a of project.assets){if(a.data||!a.path)throw Error('ارفع الأصول إلى المهمة قبل الحفظ.');const file=taskPath(this.root(taskId),a.path);if(!fs.statSync(file).isFile())throw Error('أصل مفقود من ملفات المهمة: '+a.name);}return project;}
  /** Content fingerprint for duplicate detection: whole file up to 128 MB, otherwise first 1 MB plus size. */
  private fingerprint(file:string,size:number){const hash=createHash('sha256');const fd=fs.openSync(file,'r');try{const whole=size<=128*1024*1024,limit=whole?size:1024*1024,buffer=Buffer.alloc(Math.min(limit,1024*1024));let read=0;while(read<limit){const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,limit-read),read);if(n<=0)break;read+=n;hash.update(buffer.subarray(0,n));}if(!whole)hash.update('bytes:'+size);}finally{fs.closeSync(fd);}return hash.digest('hex');}
  async handle(req:IncomingMessage,res:ServerResponse,url:URL){
    if(!url.pathname.startsWith('/api/timeline/'))return false;
    try{
      if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`||req.headers['sec-fetch-site']==='cross-site'){json(res,403,{error:'Same-origin required'});return true;}
      if(req.method==='GET'&&url.pathname==='/api/timeline/environment'){json(res,200,{background:true,checkpointSeconds:segment,ffmpegAvailable:fs.existsSync(path.join(ROOT,'node_modules','ffmpeg-static',process.platform==='win32'?'ffmpeg.exe':'ffmpeg'))});return true;}
      const taskId=url.searchParams.get('taskId')||'',root=this.root(taskId),p=url.pathname;
      if(req.method==='POST'&&p==='/api/timeline/asset-copy'){const input=await body(req);if(typeof input.path!=='string'||!/^assets\/timeline\/[a-f\d-]+\.(png|jpg|webp|mp4|webm|mp3|wav|ogg|m4a)$/.test(input.path))throw Error('مسار أصل غير صالح');const source=taskPath(this.root(input.taskId),input.path),relative=`assets/timeline/${randomUUID()}${path.extname(source)}`,file=taskPath(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});await fs.promises.copyFile(source,file);json(res,201,{path:relative,bytes:fs.statSync(file).size});return true;}
      if(req.method==='POST'&&p==='/api/timeline/asset'){
        const extensions:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','video/mp4':'mp4','video/webm':'webm','audio/mpeg':'mp3','audio/mp3':'mp3','audio/wav':'wav','audio/x-wav':'wav','audio/ogg':'ogg','audio/mp4':'m4a','audio/webm':'webm'};
        const ext=extensions[(req.headers['content-type']||'').split(';')[0]!];if(!ext)throw Error('صيغة الوسائط غير مدعومة.');
        const relative=`assets/timeline/${randomUUID()}.${ext}`,file=taskPath(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});
        try{await pipeline(req,fs.createWriteStream(file+'.partial',{flags:'wx'}));if(!fs.statSync(file+'.partial').size)throw Error('ملف فارغ');fs.renameSync(file+'.partial',file);}catch(e){fs.rmSync(file+'.partial',{force:true});throw e;}
        json(res,201,{path:relative,bytes:fs.statSync(file).size});return true;
      }
      if(p==='/api/timeline/project'&&req.method==='POST'){const project=this.checked(await body(req),taskId);const relative=`uploads/${Date.now()}-${randomUUID()}-loam-timeline.json`,file=taskPath(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});atomic(file,project);json(res,201,{path:relative});return true;}
      if(p==='/api/timeline/jobs'&&req.method==='GET'){json(res,200,{jobs:[...this.jobs.values()].filter(j=>j.taskId===taskId).sort((a,b)=>a.createdAt-b.createdAt).map(j=>this.public(j))});return true;}
      if(p==='/api/timeline/jobs'&&req.method==='POST'){const input=await body(req),project=this.checked(input.project,taskId);if(!project.clips.length)throw Error('أضف مقاطع أولًا');if(!['mp4','webm','wav','stems'].includes(input.format))throw Error('صيغة غير صالحة');const loudnessTarget=typeof input.loudness==='number'&&Number.isFinite(input.loudness)?Math.max(-40,Math.min(-5,input.loudness)):undefined;const duration=Math.ceil(timelineDuration(project)*project.fps-1e-9)/project.fps;const job:Job={rendererVersion:2,id:randomUUID(),taskId,title:project.title,format:input.format,loudnessTarget,state:'queued',completed:0,total:Math.ceil(duration/segment),duration,project,message:'في انتظار التصدير الخلفي',createdAt:Date.now()};this.persist(job);this.jobs.set(job.id,job);json(res,202,{job:this.public(job)});void this.pump();return true;}
      if(p==='/api/timeline/job'&&req.method==='POST'){const input=await body(req),job=this.jobs.get(input.id);if(!job||job.taskId!==taskId)throw Error('عملية غير موجودة');if(input.action==='cancel'&&['queued','running'].includes(job.state)){const running=job.state==='running';job.state='canceled';job.message='أُلغي؛ الأجزاء المكتملة محفوظة';this.persist(job);if(running){this.process?.kill();await this.browser?.close().catch(()=>{});}}else if(input.action==='retry'&&['failed','canceled'].includes(job.state)){if(this.currentJob===job.id)throw Error('انتظر اكتمال إلغاء العملية');job.state='queued';job.message='استكمال الأجزاء المتبقية';this.persist(job);void this.pump();}json(res,200,{job:this.public(job)});return true;}
      if(req.method==='POST'&&p==='/api/timeline/assets-status'){
        const project=validateTimeline(await body(req)) as Project;
        const usage=new Map<string,number>();for(const c of project.clips)if(c.assetId)usage.set(c.assetId,(usage.get(c.assetId)||0)+1);
        const assets=project.assets.map(a=>{const file=taskPath(root,a.path);let exists=false,bytes=0,print='';try{const stat=fs.statSync(file);exists=stat.isFile();if(exists){bytes=stat.size;print=this.fingerprint(file,bytes);}}catch{/* missing asset is reported, not thrown */}return {id:a.id,name:a.name,kind:a.kind,path:a.path,exists,bytes,fingerprint:print,usedCount:usage.get(a.id)||0};});
        const groups=new Map<string,string[]>();for(const a of assets)if(a.exists&&a.bytes>0)groups.set(a.fingerprint,[...(groups.get(a.fingerprint)||[]),a.id]);
        json(res,200,{assets,missing:assets.filter(a=>!a.exists).map(a=>a.id),unused:assets.filter(a=>!a.usedCount).map(a=>a.id),duplicates:[...groups.values()].filter(g=>g.length>1),totalBytes:assets.reduce((sum,a)=>sum+a.bytes,0)});return true;
      }
      if(req.method==='POST'&&p==='/api/timeline/package'){
        const project=this.checked(await body(req),taskId);
        let total=0;for(const a of project.assets)total+=fs.statSync(taskPath(root,a.path)).size;
        if(total>2*1024*1024*1024)throw Error('أصول المشروع تتجاوز 2 GB، وهي الحد الحالي لحزمة واحدة قابلة للإنشاء في الذاكرة.');
        const zip=new JSZip();
        const manifest:{format:string;version:number;createdAt:string;app:string;projectTitle:string;fonts:string[];assets:Array<{id:string;name:string;kind:string;path:string;file:string;bytes:number}>}={format:'loam-timeline-package',version:1,createdAt:new Date().toISOString(),app:'Loam',projectTitle:project.title,fonts:[],assets:[]};
        for(const a of project.assets){const file='assets/'+path.basename(a.path);const bytes=fs.readFileSync(taskPath(root,a.path));zip.file(file,bytes,{compression:'STORE'});manifest.assets.push({id:a.id,name:a.name,kind:a.kind,path:a.path,file,bytes:bytes.length});}
        zip.file('manifest.json',JSON.stringify(manifest,null,2));zip.file('project.json',JSON.stringify(project));
        const buffer=await zip.generateAsync({type:'nodebuffer',compression:'STORE'});
        const relative=`uploads/${Date.now()}-${randomUUID()}-loam-timeline-package.zip`,file=taskPath(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});
        const temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,buffer);fs.renameSync(temp,file);
        json(res,201,{path:relative,bytes:buffer.length,assets:project.assets.length});return true;
      }
      if(req.method==='POST'&&p==='/api/timeline/package-import'){
        const type=((req.headers['content-type']||'').split(';')[0])||'';
        if(!['application/zip','application/octet-stream','application/x-zip-compressed'].includes(type))throw Error('أرسل ملف الحزمة بصيغة ZIP.');
        const temp=taskPath(root,`.timeline-jobs/import-${randomUUID()}.partial`);
        try{
          let received=0;const limit=2*1024*1024*1024;
          const meter=new Transform({transform(chunk:Buffer,_enc,cb){received+=chunk.length;received>limit?cb(Error('حزمة المشروع تتجاوز 2 GB.')):cb(null,chunk);}});
          await pipeline(req,meter,fs.createWriteStream(temp,{flags:'wx'}));
          if(!received)throw Error('ملف حزمة فارغ.');
          const zip=await JSZip.loadAsync(fs.readFileSync(temp));
          if(Object.keys(zip.files).length>300)throw Error('الحزمة تحوي عددًا كبيرًا من الملفات.');
          const manifestEntry=zip.file('manifest.json');if(!manifestEntry)throw Error('الحزمة لا تحتوي manifest.json.');
          const manifest=JSON.parse(await manifestEntry.async('string')) as {format?:unknown;version?:unknown;assets?:Array<{path?:unknown;bytes?:unknown}>};
          if(manifest.format!=='loam-timeline-package'||manifest.version!==1)throw Error('صيغة حزمة غير مدعومة.');
          const projectEntry=zip.file('project.json');if(!projectEntry)throw Error('الحزمة لا تحتوي project.json.');
          const project=validateTimeline(JSON.parse(await projectEntry.async('string'))) as Project;
          let uncompressed=0;for(const entry of Object.values(zip.files)){const size=(entry as unknown as {_data?:{uncompressedSize?:number}})._data?.uncompressedSize;if(size)uncompressed+=size;}
          if(uncompressed>2*1024*1024*1024)throw Error('المحتوى المفكوك من الحزمة يتجاوز 2 GB.');
          const remapped=structuredClone(project);remapped.taskId=taskId;
          for(const asset of remapped.assets){
            const ext=path.extname(asset.path).slice(1).toLowerCase();
            if(!/^(png|jpg|webp|mp4|webm|mp3|wav|ogg|m4a)$/.test(ext))throw Error('نوع ملف غير مدعوم في الحزمة.');
            const entry=zip.file('assets/'+path.basename(asset.path));
            if(!entry)throw Error('الحزمة ناقصة ملف أصل: '+asset.name);
            const bytes=Buffer.from(await entry.async('arraybuffer'));
            const declared=manifest.assets?.find(m=>m.path===asset.path) as {bytes?:number}|undefined;
            if(declared?.bytes!==undefined&&declared.bytes!==bytes.length)throw Error('حجم ملف في الحزمة لا يطابق البيان: '+asset.name);
            const relative=`assets/timeline/${randomUUID()}.${ext}`,file=taskPath(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
            asset.path=relative;asset.bytes=bytes.length;
            // Proxies are machine-local derivatives of the original file; the importer regenerates them instead of carrying stale paths.
            delete asset.proxy;
          }
          json(res,200,{project:remapped,assets:remapped.assets.length});return true;
        }finally{fs.rmSync(temp,{force:true});}
      }
      if(req.method==='POST'&&p==='/api/timeline/probe'){
        const input=await body(req);
        if(typeof input.path!=='string'||!/^assets\/timeline\/[a-f\d-]+\.(png|jpg|webp|mp4|webm|mp3|wav|ogg|m4a)$/.test(input.path))throw Error('مسار أصل غير صالح.');
        const file=taskPath(root,input.path);const stat=fs.statSync(file);if(!stat.isFile())throw Error('الملف غير موجود.');
        if(stat.size>2*1024*1024*1024)throw Error('الملف أكبر من 2 GB للفحص.');
        const stderr=await this.runFfmpegRaw(['-i',file],stat.size>500*1024*1024?120000:30000);
        const info=this.parseProbe(stderr,path.extname(file).slice(1).toLowerCase());
        if(info.videoCodec===undefined&&info.hasAudio===undefined)throw Error('تعذّر قراءة بيانات الملف بهذا الترميز.');
        json(res,200,{...info,bytes:stat.size});return true;
      }
      if(req.method==='POST'&&p==='/api/timeline/proxy'){
        const input=await body(req);
        if(typeof input.path!=='string'||!/^assets\/timeline\/[a-f\d-]+\.(mp4|webm)$/.test(input.path))throw Error('الproxy يُنشأ لملفات فيديو MP4/WebM فقط.');
        const source=taskPath(root,input.path);const stat=fs.statSync(source);if(!stat.isFile())throw Error('ملف الفيديو غير موجود.');
        if(stat.size>2*1024*1024*1024)throw Error('ملف الفيديو أكبر من 2 GB لتوليد proxy.');
        const stderr=await this.runFfmpegRaw(['-i',source]);
        const info=this.parseProbe(stderr,path.extname(source).slice(1).toLowerCase());
        if(!info.width||!info.height)throw Error('تعذّر قراءة أبعاد الفيديو.');
        const job:ProxyJob={id:randomUUID(),taskId,source:input.path,state:'queued',message:'في انتظار التوليد',width:Math.min(640,info.width-(info.width%2)),createdAt:Date.now()};
        this.proxyJobs.set(job.id,job);this.chainProxy(job);
        json(res,202,{job:this.publicProxy(job)});return true;
      }
      if(req.method==='GET'&&p==='/api/timeline/proxy-job'){
        const job=this.proxyJobs.get(url.searchParams.get('id')||'');
        if(!job||job.taskId!==taskId)throw Error('عملية proxy غير موجودة.');
        json(res,200,{job:this.publicProxy(job)});return true;
      }
      if(req.method==='POST'&&p==='/api/timeline/proxy-job'){
        const input=await body(req),job=this.proxyJobs.get(input.id);
        if(!job||job.taskId!==taskId)throw Error('عملية proxy غير موجودة.');
        if(input.action==='cancel'){
          if(job.state==='queued'){job.state='canceled';job.message='أُلغيت قبل البدء';}
          else if(job.state==='running'){job.state='canceled';job.message='أُلغيت أثناء الترميز';job.child?.kill();}
          else throw Error('لا إلغاء لعملية منتهية.');
        }else if(input.action==='retry'){
          if(!['failed','canceled'].includes(job.state))throw Error('الإعادة لعملية فاشلة أو ملغاة فقط.');
          job.state='queued';job.message='إعادة المحاولة';this.chainProxy(job);
        }else throw Error('إجراء غير معروف.');
        json(res,200,{job:this.publicProxy(job)});return true;
      }
      if(req.method==='POST'&&p==='/api/timeline/thumb'){
        const input=await body(req);
        if(typeof input.path!=='string'||!/^assets\/timeline\/[a-f\d-]+\.(png|jpg|webp|mp4|webm|mp3|wav|ogg|m4a)$/.test(input.path))throw Error('مسار أصل غير صالح للصورة المصغرة.');
        if(typeof input.data!=='string'||!/^data:image\/png;base64,[a-z\d+/=]+$/i.test(input.data)||input.data.length>300000)throw Error('صورة مصغرة غير صالحة (PNG حتى 300 KB).');
        if(!fs.statSync(taskPath(root,input.path)).isFile())throw Error('الأصل غير موجود.');
        const relative=`assets/timeline/cache/${path.basename(input.path)}.png`,file=taskPath(root,relative);
        fs.mkdirSync(path.dirname(file),{recursive:true});
        const temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,Buffer.from(input.data.split(',')[1]!,'base64'));fs.renameSync(temp,file);
        json(res,201,{path:relative});return true;
      }
      if(req.method==='GET'&&p==='/api/timeline/storage'){
        json(res,200,this.storageReport(root));return true;
      }
      if(req.method==='POST'&&p==='/api/timeline/cleanup'){
        const input=await body(req);
        const protect=new Set<string>(Array.isArray(input.protect)?input.protect.filter((x:unknown)=>typeof x==='string') as string[]:[]);
        const result=this.cleanup(root,protect,Boolean(input.thumbs),Boolean(input.jobParts),Boolean(input.orphans));
        json(res,200,result);return true;
      }
      json(res,404,{error:'Not found'});
    }catch(e){if(!res.headersSent)json(res,400,{error:e instanceof Error?e.message:String(e)});}
    return true;
  }
  private ffmpeg(args:string[],control?:{process:(child:ChildProcess|undefined)=>void},stdin=false,stdinData?:Buffer){return new Promise<void>((resolve,reject)=>{const executable=path.join(ROOT,'node_modules','ffmpeg-static',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');const child=spawn(executable,['-hide_banner','-loglevel','error','-y',...args],{windowsHide:true,stdio:[stdin?'pipe':'ignore','ignore','pipe']});if(control)control.process(child);else this.process=child;let error='';child.stderr?.on('data',data=>{error=(error+data).slice(-2000);});child.once('error',reject);child.once('exit',code=>{if(this.process===child)this.process=undefined;code===0?resolve():reject(Error('تعذّر ترميز التصدير: '+error));});child.stdin?.on('error',()=>{});if(stdinData&&child.stdin)child.stdin.end(stdinData);});}
  /** Raw ffmpeg run whose nonzero exit is expected (stream inspection via -i); stderr is returned for parsing. */
  private runFfmpegRaw(args:string[],timeoutMs=30000){return new Promise<string>((resolve,reject)=>{const executable=path.join(ROOT,'node_modules','ffmpeg-static',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');const child=spawn(executable,['-hide_banner',...args],{windowsHide:true,stdio:['ignore','ignore','pipe']});let stderr='',settled=false;const timer=setTimeout(()=>{if(!settled){settled=true;child.kill();reject(Error('انتهت مهلة فحص الملف.'));}},timeoutMs);child.stderr?.on('data',data=>{stderr=(stderr+data).slice(-12000);});child.once('error',e=>{if(!settled){settled=true;clearTimeout(timer);reject(e);}});child.once('exit',()=>{if(!settled){settled=true;clearTimeout(timer);resolve(stderr);}});});}
  /** Parse `ffmpeg -i` stderr into honest container/stream facts; unknown facts stay undefined instead of guessed. */
  private parseProbe(stderr:string,container:string){const line=(marker:string)=>stderr.split('\n').find(l=>l.includes(marker))??'';const video=line(' Video: '),audio=line(' Audio: ');
    const dims=/\b(\d{2,5})x(\d{2,5})\b/.exec(video),vcodec=/Video:\s*([^,]+)/.exec(video),acodec=/Audio:\s*([^,]+)/.exec(audio),rate=/(\d{3,6}) Hz/.exec(audio),duration=/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
    const pix=video.split(',').map(s=>s.trim()).find(s=>/^(yuv|rgb|rgba|yuva|gray|pal8)[a-z0-9()]*$/.test(s));
    return {container,duration:duration?(Number(duration[1])*3600+Number(duration[2])*60+Number(duration[3])):undefined,videoCodec:vcodec?.[1]?.trim().split(' ')[0],pixFmt:pix,transparent:/\b(rgba|yuva|pal8)\b/.test(video),width:dims?Number(dims[1]):undefined,height:dims?Number(dims[2]):undefined,hasAudio:!!audio,audioCodec:acodec?.[1]?.trim().split(' ')[0],sampleRate:rate?Number(rate[1]):undefined};}
  private proxyQueue:Promise<unknown>=Promise.resolve();
  /** Proxy transcode jobs (J6: bounded). Each keeps a job record plus its
   *  rendered output path; a burst of preview requests must not retain every
   *  job forever. A dropped job falls back to the on-disk project file. */
  private proxyJobs=new BoundedMap<string,ProxyJob>(TIMELINE_PROXY_CAPACITY,'timeline-proxy-jobs');
  private publicProxy(job:ProxyJob){return {id:job.id,state:job.state,message:job.message,width:job.width,...(job.result?{result:job.result}:{})};}
  /** Serialized proxy transcodes; cancel/retry flip state and the runner discards its partial output. */
  private chainProxy(job:ProxyJob){
    const run=async()=>{
      if(job.state!=='queued')return;
      const root=this.root(job.taskId);
      job.state='running';job.message='ترميز نسخة المعاينة';
      const relative=`assets/timeline/${randomUUID()}.mp4`,target=taskPath(root,relative);
      await new Promise<void>(resolve=>{
        const executable=path.join(ROOT,'node_modules','ffmpeg-static',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');
        const child=spawn(executable,['-hide_banner','-loglevel','error','-y','-i',taskPath(root,job.source),'-vf','scale='+job.width+':-2','-c:v','libx264','-preset','veryfast','-crf','28','-c:a','aac','-b:a','96k','-movflags','+faststart','-f','mp4',target+'.partial'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
        job.child=child;let error='';
        child.stderr?.on('data',data=>{error=(error+data).slice(-2000);});
        child.once('error',e=>{error=String(e);});
        child.once('exit',()=>{
          job.child=undefined;
          if(job.state==='canceled'){fs.rmSync(target+'.partial',{force:true});job.message='أُلغيت؛ يمكن إعادة المحاولة';resolve();return;}
          if(!fs.existsSync(target+'.partial')){job.state='failed';job.message=error||'فشل ترميز الـproxy';resolve();return;}
          fs.renameSync(target+'.partial',target);
          job.result={path:relative,bytes:fs.statSync(target).size,width:job.width};
          job.state='done';job.message='جاهزة';resolve();
        });
      });
    };
    this.proxyQueue=this.proxyQueue.then(run,run);
  }
  /** Paths referenced by saved projects, export jobs, or proxy jobs — never candidates for orphan cleanup. */
  private referencedPaths(root:string):Set<string>{
    const referenced=new Set<string>();
    const uploads=path.join(root,'uploads');
    if(fs.existsSync(uploads))for(const name of fs.readdirSync(uploads)){if(!name.endsWith('loam-timeline.json'))continue;try{const project=JSON.parse(fs.readFileSync(path.join(uploads,name),'utf8')) as {assets?:Array<{path?:string;proxy?:{path?:string}}>};for(const a of project.assets??[]){if(a.path)referenced.add(a.path);if(a.proxy?.path)referenced.add(a.proxy.path);}}catch{/* unreadable project protects nothing extra */}}
    for(const job of this.jobs.values())for(const a of job.project.assets){if(a.path)referenced.add(a.path);if(a.proxy?.path)referenced.add(a.proxy.path);}
    for(const job of this.proxyJobs.values())referenced.add(job.source);
    return referenced;
  }
  private dirStats(root:string,dir:string){let count=0,bytes=0;const target=taskPath(root,dir);if(!fs.existsSync(target))return {count,bytes};for(const name of fs.readdirSync(target)){try{const stat=fs.statSync(path.join(target,name));if(stat.isFile()){count++;bytes+=stat.size;}}catch{/* raced deletion */}}return {count,bytes};}
  private storageReport(root:string){
    const assets=this.dirStats(root,'assets/timeline');
    const thumbCache=this.dirStats(root,'assets/timeline/cache');
    const jobsDir=path.join(root,'.timeline-jobs');let jobTemp={count:0,bytes:0};
    if(fs.existsSync(jobsDir))for(const id of fs.readdirSync(jobsDir)){const stat=this.dirStats(root,path.join('.timeline-jobs',id));jobTemp={count:jobTemp.count+stat.count,bytes:jobTemp.bytes+stat.bytes};}
    const outputs=this.dirStats(root,'uploads');
    let orphans={count:0,bytes:0};
    const referenced=this.referencedPaths(root),media=path.join(root,'assets/timeline');
    if(fs.existsSync(media))for(const name of fs.readdirSync(media)){const relative='assets/timeline/'+name;try{const stat=fs.statSync(path.join(media,name));if(stat.isFile()&&!referenced.has(relative)&&!relative.startsWith('assets/timeline/cache/')){orphans={count:orphans.count+1,bytes:orphans.bytes+stat.size};}}catch{/* raced */}}
    let freeDisk:null|number=null;
    try{const stats=fs.statfsSync(root);freeDisk=Number(stats.bavail)*Number(stats.bsize);}catch{/* platform without statfs */}
    return {assets:{count:assets.count-thumbCache.count,bytes:assets.bytes-thumbCache.bytes},thumbCache,jobTemp,outputs:{count:outputs.count,bytes:outputs.bytes},orphans,freeDisk};
  }
  /** Delete regenerable/derived files; referenced originals (saved projects, queued jobs, protected list) are never touched. */
  private cleanup(root:string,protect:Set<string>,thumbs:boolean,jobParts:boolean,orphans:boolean){
    const removed={thumbs:0,thumbsBytes:0,jobParts:0,jobPartsBytes:0,orphans:0,orphansBytes:0};
    const liveJobs=new Set([...this.jobs.values()].filter(j=>['queued','running'].includes(j.state)).map(j=>j.id));
    if(thumbs){const cache=path.join(root,'assets/timeline/cache');if(fs.existsSync(cache))for(const name of fs.readdirSync(cache)){try{const file=path.join(cache,name),stat=fs.statSync(file);if(stat.isFile()){fs.rmSync(file);removed.thumbs++;removed.thumbsBytes+=stat.size;}}catch{/* in use */}}}
    if(jobParts){const jobs=path.join(root,'.timeline-jobs');if(fs.existsSync(jobs))for(const id of fs.readdirSync(jobs)){if(liveJobs.has(id))continue;try{const dir=path.join(jobs,id),stat=fs.statSync(dir);if(stat.isDirectory()){for(const name of fs.readdirSync(dir)){const f=path.join(dir,name),s=fs.statSync(f);if(s.isFile()){removed.jobPartsBytes+=s.size;}}fs.rmSync(dir,{recursive:true});removed.jobParts++;}}catch{/* raced */}}}
    if(orphans){
      const referenced=this.referencedPaths(root);
      for(const relative of protect)referenced.add(relative);
      const media=path.join(root,'assets/timeline');
      if(fs.existsSync(media))for(const name of fs.readdirSync(media)){const relative='assets/timeline/'+name;try{const file=path.join(media,name),stat=fs.statSync(file);if(stat.isFile()&&!referenced.has(relative)&&!relative.startsWith('assets/timeline/cache/')){fs.rmSync(file);removed.orphans++;removed.orphansBytes+=stat.size;}}catch{/* in use */}}
    }
    return {...removed,storage:this.storageReport(root)};
  }
  private async pump(){if(this.working||this.stopped)return;this.working=true;try{let job:Job|undefined;while(!this.stopped&&(job=[...this.jobs.values()].find(j=>j.state==='queued'))){const current=job,dir=this.dir(current),attempt=randomUUID();this.currentJob=current.id;try{
      if(current.rendererVersion!==2){current.completed=0;current.rendererVersion=2;current.duration=Math.ceil(timelineDuration(current.project)*current.project.fps-1e-9)/current.project.fps;current.total=Math.ceil(current.duration/segment);}current.state='running';current.message='رندر مضبوط بالإطارات في الخلفية';this.persist(current);
      // Only fully normalized parts count as checkpoints. Incomplete work is redone.
      while(current.completed>0&&(!fs.existsSync(path.join(dir,`${current.completed-1}.mp4`))||!fs.existsSync(path.join(dir,`${current.completed-1}.pcm`))))current.completed--;
      this.browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
      const page=await this.browser.newPage();await page.route('**/*',route=>route.request().url().startsWith(this.base+'/')||route.request().url().startsWith('data:')?route.continue():route.abort());await page.goto(this.base+'/creative-render.html');await page.waitForFunction(()=>typeof (globalThis as unknown as {prepareExactRender:unknown}).prepareExactRender==='function');await page.evaluate(async project=>await (globalThis as unknown as {prepareExactRender:(p:unknown)=>Promise<void>}).prepareExactRender(project),current.project);const control={process:(child:ChildProcess|undefined)=>{this.process=child;},check:()=>{if(this.stopped||current.state!=='running')throw Error('Interrupted');}};
      for(let i=current.completed;i<current.total;i++){
        control.check();const startFrame=i*segment*current.project.fps,count=Math.min(segment*current.project.fps,Math.round(current.duration*current.project.fps)-startFrame);
        if(current.format!=='wav'&&current.format!=='stems')await renderFrames(page,current.project,startFrame,count,path.join(dir,i+'-'+attempt+'.tmp'),control);
        const audio=await renderAudio(current.project,this.root(current.taskId),startFrame,count,control,dir);fs.writeFileSync(path.join(dir,i+'-'+attempt+'.pcm.tmp'),audio);control.check();if(current.format!=='wav'&&current.format!=='stems')fs.renameSync(path.join(dir,i+'-'+attempt+'.tmp'),path.join(dir,i+'.mp4'));fs.renameSync(path.join(dir,i+'-'+attempt+'.pcm.tmp'),path.join(dir,i+'.pcm'));current.completed=i+1;current.message=`حُفظ ${current.completed} / ${current.total} جزء`;this.persist(current);
      }
      await this.browser.close();this.browser=undefined;if(this.stopped||current.state!=='running')throw Error('Interrupted');
      current.message='دمج الإطارات وترميز الصوت المتصل';this.persist(current);const audioFile=path.join(dir,'mix-'+attempt+'.pcm');await joinAudio(Array.from({length:current.total},(_,i)=>path.join(dir,i+'.pcm')),audioFile,control.check);control.check();
      if(current.format==='wav'||current.format==='stems'){
        const relative=current.format==='wav'?`uploads/loam-export-${current.id}.wav`:`uploads/loam-export-${current.id}-stems.zip`;
        const output=taskPath(this.root(current.taskId),relative);fs.mkdirSync(path.dirname(output),{recursive:true});
        current.message=current.format==='wav'?'ترميز الصوت المتصل (WAV)':'توليد مسارات منفصلة لكل مسار';this.persist(current);
        if(current.format==='wav'){
          await this.ffmpeg(current.loudnessTarget!=null
            ?['-f','f32le','-ar','48000','-ac','2','-i',audioFile,'-af',`loudnorm=I=${current.loudnessTarget}:TP=-1.5:LRA=11`,'-ar','48000','-c:a','pcm_s16le','-f','wav',output+'.'+attempt+'.partial']
            :['-f','f32le','-ar','48000','-ac','2','-i',audioFile,'-c:a','pcm_s16le','-f','wav',output+'.'+attempt+'.partial']);
        }else{
          const JSZipModule=await import('jszip');const zip=new JSZipModule.default();
          const audible=current.project.tracks.filter(t=>!t.muted&&!t.hidden);
          const totalFrames=Math.round(current.duration*current.project.fps);
          let index=1;
          for(const track of audible){
            control.check();
            const stemPcm=await renderAudio(current.project,this.root(current.taskId),0,totalFrames,control,dir,track.id);
            const stemWav=path.join(dir,`stem-${track.id}-${attempt}.wav`);
            await this.ffmpeg(['-f','f32le','-ar','48000','-ac','2','-i','pipe:0','-t',String(current.duration),'-c:a','pcm_s16le','-f','wav',stemWav],undefined,true,Buffer.from(stemPcm.buffer));
            zip.file(`stem-${String(index).padStart(2,'0')}-${track.name.replace(/[\\/:*?"<>|]/g,'_')}.wav`,fs.readFileSync(stemWav));
            index++;
          }
          fs.writeFileSync(output+'.'+attempt+'.partial',await zip.generateAsync({type:'nodebuffer'}));
        }
        if(this.stopped||current.state!=='running')throw Error('Interrupted');fs.renameSync(output+'.'+attempt+'.partial',output);
        let lufsNote='';
        if(current.format==='wav'){
          try{
            const stderr=await this.runFfmpegRaw(['-i',output,'-map','0:a:0','-af','ebur128=peak=true','-f','null','-']);
            const integrated=[...stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?) LUFS/g)].map(m=>m[1]).at(-1),peak=[...stderr.matchAll(/Peak:\s*(-?\d+(?:\.\d+)?) dBFS/g)].map(m=>m[1]).at(-1);
            if(integrated)lufsNote=` · مقاس ${integrated} LUFS${peak?` وذروة ${peak} dBFS`:''}`;
          }catch{/* measurement is informational */}
        }
        current.path=relative;current.state='done';current.message=(current.format==='wav'?`مكتمل — صوت WAV${current.loudnessTarget!=null?` مُسوّى إلى ${current.loudnessTarget} LUFS`:''}`:'مكتمل — مسارات منفصلة ZIP')+lufsNote;this.persist(current);
      }else{
      fs.writeFileSync(path.join(dir,'parts.txt'),Array.from({length:current.total},(_,i)=>`file '${i}.mp4'`).join('\n'));
      const relative=`uploads/loam-export-${current.id}.${current.format}`,output=taskPath(this.root(current.taskId),relative);fs.mkdirSync(path.dirname(output),{recursive:true});
      await this.ffmpeg(['-f','concat','-safe','1','-i',path.join(dir,'parts.txt'),'-f','f32le','-ar','48000','-ac','2','-i',audioFile,'-map','0:v:0','-map','1:a:0','-t',String(current.duration),...(current.format==='mp4'?['-c:v','copy','-c:a','aac','-movflags','+faststart','-f','mp4']:['-c:v','libvpx-vp9','-c:a','libopus','-f','webm']),output+'.'+attempt+'.partial']);
      if(this.stopped||current.state!=='running')throw Error('Interrupted');fs.renameSync(output+'.'+attempt+'.partial',output);current.path=relative;current.state='done';current.message='مكتمل ومحفوظ';this.persist(current);
      }
    }catch(e){if(!this.stopped&&current.state!=='canceled'){current.state='failed';current.message=e instanceof Error?e.message:String(e);this.persist(current);}}finally{await this.browser?.close().catch(()=>{});this.browser=undefined;this.currentJob=undefined;}}
    }finally{this.working=false;}}
}
