import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import type {Page} from 'playwright';
import {ROOT, rootAsset} from '../config.js';
import {taskPath} from '../server/taskWorkspace.js';
// @ts-expect-error shared browser math
import {animatedValue} from '../../ui/creative-keyframes.js';
// @ts-expect-error shared browser math
import {transitionAt} from '../../ui/creative-timeline-model.js';
type Clip={id:string;assetId:string;trackId:string;kind:string;start:number;duration:number;in:number;speed:number;volume:number;transition:string};
export type RenderProject={taskId:string;title:string;fps:number;assets:Array<{id:string;path:string;data?:string;name:string;kind:string;duration:number;bytes?:number;folder?:string;tags?:string[];meta?:Record<string,number|string|boolean>;proxy?:{path:string;bytes:number;width:number}}>;clips:Clip[];tracks:Array<{id:string;name:string;muted:boolean;hidden:boolean;volume?:number;pan?:number;solo?:boolean;role?:'subtitles'|'voice';eq?:{low?:number;mid?:number;high?:number};compressor?:{enabled?:boolean;threshold?:number;ratio?:number}}>;duck?:{enabled?:boolean;amount?:number}};
type Control={process:(child:ChildProcess|undefined)=>void;check:()=>void};
const executable=()=>rootAsset('node_modules', 'ffmpeg-static',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');
function command(args:string[],control:Control,stdin=false){const child=spawn(executable(),['-hide_banner','-loglevel','error','-y',...args],{windowsHide:true,stdio:[stdin?'pipe':'ignore','pipe','pipe']});control.process(child);let error='';child.stderr?.on('data',data=>{error=(error+data).slice(-4000);});const done=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>{control.process(undefined);if(code===0)resolve();else reject(Error(error||'توقف محرك الترميز'));});});void done.catch(()=>{});child.stdin?.on('error',()=>{});return {child,done};}
export async function renderFrames(page:Page,project:RenderProject,startFrame:number,count:number,file:string,control:Control){
 const {child,done}=command(['-f','image2pipe','-framerate',String(project.fps),'-i','pipe:0','-an','-c:v','libx264','-preset','veryfast','-crf','18','-vf','scale=out_color_matrix=bt709:out_range=tv','-pix_fmt','yuv420p','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-color_range','tv','-frames:v',String(count),'-video_track_timescale',String(project.fps*1024),'-f','mp4',file],control,true);
 try{for(let frame=0;frame<count;frame++){control.check();const png=await page.evaluate(async time=>await (globalThis as unknown as {renderExactFrame:(t:number)=>Promise<string>}).renderExactFrame(time),(startFrame+frame)/project.fps);control.check();await new Promise<void>((resolve,reject)=>child.stdin!.write(Buffer.from(png,'base64'),error=>error?reject(error):resolve()));}child.stdin!.end();await done;}catch(e){child.kill();await done.catch(()=>{});throw e;}
}
export function tempoFilters(speed:number){const factors:number[]=[];while(speed<.5){factors.push(.5);speed/=.5;}while(speed>2){factors.push(2);speed/=2;}factors.push(speed);return factors.map(value=>'atempo='+value).join(',');}
/** Per-track EQ + compressor as an ffmpeg filter chain (deterministic offline counterpart of the WebAudio bus). */
export function trackFilters(track:RenderProject['tracks'][number]):string[]{
 const eq=track.eq,filters:string[]=[];
 if(eq?.low)filters.push('bass=g='+eq.low.toFixed(2));
 if(eq?.mid)filters.push('equalizer=f=1000:width_type=q:width=1:g='+eq.mid.toFixed(2));
 if(eq?.high)filters.push('treble=g='+eq.high.toFixed(2));
 if(track.compressor?.enabled)filters.push('acompressor=threshold='+(track.compressor.threshold??-24)+'dB:ratio='+(track.compressor.ratio??4)+':attack=5:release=80');
 return filters;
}
export async function renderAudio(project:RenderProject,root:string,startFrame:number,count:number,control:Control,cacheDir:string,onlyTrackId?:string){
 const rate=48000,start=startFrame/project.fps,end=(startFrame+count)/project.fps,samples=count*rate/project.fps,mix=new Float32Array(samples*2);
 // Ducking envelope: voice-role tracks first, then lower the rest while speech is active.
 let duckEnvelope:Float32Array|null=null;const duckAmount=project.duck?.enabled?(project.duck?.amount??0.6):0;
 const hasVoice=project.tracks.some(t=>t.role==='voice'&&!t.muted&&!t.hidden);
 if(hasVoice&&duckAmount>0&&!onlyTrackId){
   const voiceMix=new Float32Array(samples*2);
   await mixClips(project,root,start,end,rate,samples,voiceMix,control,cacheDir,t=>t.role==='voice');
   duckEnvelope=new Float32Array(Math.ceil(samples/(rate/100)));
   let window=0,sum=0,index=0;
   for(let i=0;i<samples;i++){const level=Math.max(Math.abs(voiceMix[i*2]!),Math.abs(voiceMix[i*2+1]!));sum+=level;window++;if(window===rate/100){duckEnvelope[index++]=sum/window>0.004?1:0;window=0;sum=0;}}
   if(window)duckEnvelope[index]=sum/window>0.004?1:0;
 }
 const scratch=onlyTrackId?mix:new Float32Array(samples*2);
 if(!onlyTrackId)await mixClips(project,root,start,end,rate,samples,mix,control,cacheDir,()=>true,duckEnvelope,duckAmount);
 else await mixClips(project,root,start,end,rate,samples,mix,control,cacheDir,t=>t.id===onlyTrackId);
 return Buffer.from(mix.buffer);
 async function mixClips(project:RenderProject,root:string,start:number,end:number,rate:number,samples:number,out:Float32Array,control:Control,cacheDir:string,include:(track:RenderProject['tracks'][number])=>boolean,duckEnvelope?:Float32Array|null,duckAmount=0){
 for(const clip of project.clips){control.check();const track=project.tracks.find(t=>t.id===clip.trackId);if(!['audio','video'].includes(clip.kind)||!track||track.muted||track.hidden||!include(track)||clip.start>=end||clip.start+clip.duration<=start)continue;
  const from=Math.max(start,clip.start),to=Math.min(end,clip.start+clip.duration),asset=project.assets.find(a=>a.id===clip.assetId);if(!asset)throw Error('أصل صوت مفقود');
  const offset=Math.round((from-clip.start)*rate),length=Math.round((to-from)*rate),filters=trackFilters(track),signature=filters.join(';'),cached=path.join(cacheDir,'audio-'+clip.id+(signature?'-'+Buffer.from(signature).toString('base64url').slice(0,24):'')+'.pcm'),silent=cached+'.silent',clipSamples=Math.ceil(clip.duration*rate-1e-7);
  // Float duration edges can make ffmpeg emit one sample fewer than the computed length; treat ±1 stereo frame as equivalent and zero-pad.
  const sampleFrame=8,matches=(size:number)=>size>0&&size<=clipSamples*sampleFrame&&size>=Math.floor((clipSamples-rate/2)*sampleFrame);// pad any shortfall up to half a second as trailing silence; gross mismatches still fail
  if(fs.existsSync(silent))continue;
  if(!fs.existsSync(cached)||!matches(fs.statSync(cached).size)){const temp=cached+'.'+randomUUID()+'.tmp';const {done}=command(['-ss',String(clip.in),'-i',taskPath(root,asset.path),'-map','0:a:0?','-vn','-af','aresample=48000,'+tempoFilters(clip.speed)+(filters.length?','+filters.join(','):'')+',apad=whole_len='+clipSamples+',atrim=end_sample='+clipSamples,'-t',String(clip.duration),'-ar',String(rate),'-ac','2','-f','f32le',temp],control);try{await done;control.check();const size=fs.statSync(temp).size;if(!matches(size))throw Error('عدد عينات الصوت غير مطابق للمشروع (متوقع '+clipSamples*sampleFrame+' بايت، نتج '+size+')');if(size!==clipSamples*sampleFrame){const padded=Buffer.alloc(clipSamples*sampleFrame);if(size>0){const fd=fs.openSync(temp,'r');try{fs.readSync(fd,padded,0,size,0);}finally{fs.closeSync(fd);}}fs.writeFileSync(temp,padded);}fs.renameSync(temp,cached);}catch(e){if(clip.kind==='video'&&/does not contain any stream|matches no streams/i.test(String(e))){fs.writeFileSync(silent,'');continue;}throw e;}}
  control.check();const data=Buffer.alloc(length*8),fd=fs.openSync(cached,'r');let read=0;try{while(read<data.length){const bytes=fs.readSync(fd,data,read,data.length-read,offset*8+read);if(!bytes)break;read+=bytes;}}finally{fs.closeSync(fd);}const base=Math.round((from-start)*rate),available=Math.min(length,Math.floor(read/8),samples-base);
  const anySolo=project.tracks.some(t=>t.solo);const trackGain=anySolo?(track.solo?1:0):(track.muted?0:1)*(track.volume??1);const pan=Math.max(-1,Math.min(1,track.pan??0));const left=Math.cos((pan+1)*Math.PI/4),right=Math.sin((pan+1)*Math.PI/4);const isVoice=track.role==='voice';
  for(let i=0;i<available;i++){const time=from+i/rate;let gain=animatedValue(clip,'volume',time)*(clip.transition==='none'?1:transitionAt(clip,time).audio)*trackGain;if(duckEnvelope&&!isVoice)gain*=1-duckAmount*duckEnvelope[Math.min(duckEnvelope.length-1,Math.floor((base+i)/(rate/100)))]!;out[(base+i)*2]!+=data.readFloatLE(i*8)*gain*left;out[(base+i)*2+1]!+=data.readFloatLE(i*8+4)*gain*right;}
 }
 }
}
export async function joinAudio(files:string[],target:string,check:()=>void=()=>{}){const stream=fs.createWriteStream(target);stream.on('error',()=>{});try{for(const file of files)for await(const chunk of fs.createReadStream(file)){check();await new Promise<void>((resolve,reject)=>stream.write(chunk,error=>error?reject(error):resolve()));}await new Promise<void>((resolve,reject)=>{stream.once('error',reject);stream.end(resolve);});}catch(error){stream.destroy();throw error;}}
