import {timelineDuration,transitionAt} from './creative-timeline-model.js';
import {finalizeWebM} from './creative-webm.js';
export const mp4Type=()=>['video/mp4;codecs=avc1.42001E,mp4a.40.2','video/mp4'].find(t=>window.MediaRecorder?.isTypeSupported(t));
export class TimelineEngine{
  constructor(canvas,onTime){this.canvas=canvas;this.onTime=onTime;this.elements=new Map();this.time=0;this.playing=false;this.generation=0;this.disposed=false;}
  async setProject(project){this.pause();this.project=project;const generation=++this.generation;
    for(const [id,item]of this.elements){const clip=project.clips.find(c=>c.id===id),asset=project.assets.find(a=>a.id===clip?.assetId);if(!clip||item.assetId!==clip.assetId||item.assetData!==(asset?.path||asset?.data)){this.release(item);this.elements.delete(id);}}
    await Promise.all(project.clips.filter(c=>c.kind!=='title'&&!this.elements.has(c.id)).map(async c=>{
      const a=project.assets.find(a=>a.id===c.assetId),element=c.kind==='image'?new Image():document.createElement(c.kind==='audio'?'audio':'video');
      if(c.kind!=='image'){element.preload='auto';element.playsInline=true;}
      const url=a.path?'/api/media?taskId='+encodeURIComponent(project.taskId)+'&path='+encodeURIComponent(a.path):URL.createObjectURL(await(await fetch(a.data)).blob()),item={element,url,assetId:a.id,assetData:a.path||a.data};
      try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('انتهت مهلة تحميل '+a.name)),15000);element.addEventListener(c.kind==='image'?'load':'loadeddata',()=>{clearTimeout(timer);resolve();},{once:true});element.addEventListener('error',()=>{clearTimeout(timer);reject(Error('تعذّر فك ترميز '+a.name));},{once:true});element.src=url;});
        if(c.kind!=='image'&&(!Number.isFinite(element.duration)||c.in+c.duration*c.speed>element.duration+.08))throw Error('مدة المقطع تتجاوز المصدر الحقيقي: '+a.name);
        if(this.disposed||generation!==this.generation){this.release(item);return;}this.elements.set(c.id,item);
      }catch(e){this.release(item);throw e;}
    }));
    if(generation!==this.generation||this.disposed)return;this.canvas.width=project.width;this.canvas.height=project.height;await this.seek(Math.min(this.time,timelineDuration(project)));
  }
  release(item){item.element.pause?.();item.source?.disconnect();item.gain?.disconnect();item.element.src='';URL.revokeObjectURL(item.url);}
  async audio(){if(!this.context){this.context=new AudioContext();this.mix=this.context.createGain();this.speaker=this.context.createGain();this.output=this.context.createMediaStreamDestination();this.mix.connect(this.output);this.mix.connect(this.speaker);this.speaker.connect(this.context.destination);}await this.context.resume();
    for(const item of this.elements.values()){if(item.element instanceof HTMLMediaElement&&!item.source){item.source=this.context.createMediaElementSource(item.element);item.gain=this.context.createGain();item.gain.gain.value=0;item.source.connect(item.gain);item.gain.connect(this.mix);}}
  }
  active(c,time){const track=this.project.tracks.find(t=>t.id===c.trackId);return time>=c.start&&time<c.start+c.duration&&!track.hidden;}
  async seek(time){this.pause();this.time=Math.max(0,Math.min(time,timelineDuration(this.project)));await Promise.all(this.project.clips.map(async c=>{const el=this.elements.get(c.id)?.element;if(!(el instanceof HTMLMediaElement))return;const target=Math.max(c.in,Math.min(c.in+Math.max(0,this.time-c.start)*c.speed,Math.max(0,el.duration-.001)));if(Math.abs(el.currentTime-target)<.01)return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('تعذّر الانتقال داخل '+c.name)),5000);el.addEventListener('seeked',()=>{clearTimeout(timer);resolve();},{once:true});el.currentTime=target;});}));this.draw();this.onTime(this.time,false);}
  draw(){const {canvas,project:p}=this,ctx=canvas.getContext('2d'),renderTime=Math.min(this.time,Math.max(0,timelineDuration(p)-1/p.fps));ctx.globalAlpha=1;ctx.fillStyle=p.background;ctx.fillRect(0,0,canvas.width,canvas.height);
    for(const track of p.tracks){if(track.hidden||track.kind==='audio')continue;for(const c of p.clips.filter(c=>c.trackId===track.id).sort((a,b)=>a.start-b.start)){if(!this.active(c,renderTime)||c.kind==='audio')continue;const transition=transitionAt(c,renderTime);ctx.save();ctx.globalAlpha=transition.opacity;ctx.translate(canvas.width*(.5+c.x+transition.offset),canvas.height*(.5+c.y));
        if(c.kind==='title'){ctx.fillStyle=c.color;ctx.font=`600 ${c.fontSize*c.scale}px sans-serif`;ctx.textAlign='center';ctx.direction='rtl';ctx.shadowColor='#000a';ctx.shadowBlur=5;const lines=c.text.split('\n');lines.forEach((line,i)=>ctx.fillText(line,0,(i-(lines.length-1)/2)*c.fontSize*1.3,canvas.width*.9));}
        else{const el=this.elements.get(c.id)?.element,w=el?.videoWidth||el?.naturalWidth,h=el?.videoHeight||el?.naturalHeight;if(w&&h){const scale=Math.min(canvas.width/w,canvas.height/h)*c.scale;ctx.drawImage(el,-w*scale/2,-h*scale/2,w*scale,h*scale);}}
        ctx.restore();}}
  }
  syncMedia(){for(const c of this.project.clips){const item=this.elements.get(c.id);if(!(item?.element instanceof HTMLMediaElement))continue;const el=item.element,track=this.project.tracks.find(t=>t.id===c.trackId),active=this.active(c,this.time);if(item.gain)item.gain.gain.value=active&&!track.muted?c.volume*(c.transition==='none'?1:transitionAt(c,this.time).audio):0;
      if(active){const target=c.in+(this.time-c.start)*c.speed;el.playbackRate=c.speed;if(Math.abs(el.currentTime-target)>.18&&!el.seeking)el.currentTime=target;if(el.paused&&!el.ended)el.play().catch(e=>{this.error=e;this.pause();});}else el.pause();}}
  async play(){if(this.playing)return;await this.audio();if(this.time>=timelineDuration(this.project))await this.seek(0);this.error=null;this.playing=true;this.started=performance.now()-this.time*1000;
    const tick=()=>{if(!this.playing)return;this.time=Math.min((performance.now()-this.started)/1000,this.rangeEnd??timelineDuration(this.project));this.syncMedia();this.draw();this.onTime(this.time,true);if(this.time>=(this.rangeEnd??timelineDuration(this.project))){this.pause();return;}this.raf=requestAnimationFrame(tick);};tick();}
  pause(){this.playing=false;cancelAnimationFrame(this.raf);for(const item of this.elements.values()){item.element.pause?.();if(item.gain)item.gain.gain.value=0;}this.onTime?.(this.time,false);}
  async export(format,onProgress,signal,range){const mime=format==='mp4'?mp4Type():['video/webm;codecs=vp8,opus','video/webm'].find(t=>MediaRecorder.isTypeSupported(t));if(!mime)throw Error('ترميز '+format.toUpperCase()+' غير متاح في هذا المتصفح.');if(!this.project.clips.length)throw Error('أضف مقاطع إلى الخط الزمني أولًا.');
    this.rangeEnd=range?.end;await this.seek(range?.start||0);await this.audio();this.speaker.gain.value=0;const stream=this.canvas.captureStream(this.project.fps);for(const track of this.output.stream.getAudioTracks())stream.addTrack(track.clone());const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:8000000,audioBitsPerSecond:192000}),chunks=[];let timer;
    const abort=()=>{if(recorder.state==='recording')recorder.stop();this.pause();};signal.addEventListener('abort',abort,{once:true});
    try{if(signal.aborted)throw Error('أُلغي التصدير.');const done=new Promise((resolve,reject)=>{recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.onstop=resolve;recorder.onerror=()=>reject(Error('فشل ترميز الفيديو.'));});recorder.start(250);await this.play();const deadline=performance.now()+((range?.end??timelineDuration(this.project))-(range?.start||0))*1000+15000;
      timer=setInterval(()=>{onProgress((this.time-(range?.start||0))/((range?.end??timelineDuration(this.project))-(range?.start||0)));if(!this.playing||performance.now()>deadline){if(performance.now()>deadline)this.error=Error('توقف العرض أثناء التصدير. أعد المحاولة مع إبقاء النافذة ظاهرة.');if(recorder.state==='recording')recorder.stop();}},30);
      await done;if(signal.aborted)throw Error('أُلغي التصدير.');if(this.error)throw this.error;const blob=new Blob(chunks,{type:format==='mp4'?'video/mp4':'video/webm'});if(blob.size<500)throw Error('ملف التصدير فارغ.');return format==='webm'?await finalizeWebM(blob,(range?.end??timelineDuration(this.project))-(range?.start||0)):blob;
    }finally{clearInterval(timer);signal.removeEventListener('abort',abort);if(recorder.state==='recording')recorder.stop();this.pause();this.rangeEnd=undefined;this.speaker.gain.value=1;stream.getTracks().forEach(t=>t.stop());}
  }
  dispose(){this.disposed=true;this.generation++;this.pause();for(const item of this.elements.values())this.release(item);this.elements.clear();void this.context?.close();}
}
