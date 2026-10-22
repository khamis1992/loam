import {colorFilter} from './creative-color.js';
import {animatedClip,animatedValue} from './creative-keyframes.js';
import {easedValue,effectsFilter,parseCube,sampleLut} from './creative-fx.js';
import {timelineDuration,transitionAt} from './creative-timeline-model.js';
import {finalizeWebM} from './creative-webm.js';
export const mp4Type=()=>['video/mp4;codecs=avc1.42001E,mp4a.40.2','video/mp4'].find(t=>window.MediaRecorder?.isTypeSupported(t));
export class TimelineEngine{
  constructor(canvas,onTime){this.canvas=canvas;this.onTime=onTime;this.elements=new Map();this.time=0;this.playing=false;this.generation=0;this.disposed=false;this.previewScale=1;this.safeFraction=0;this.missingMedia=[];}
  /** Preview-only resolution scale (1 / .5 / .25). Export and background rendering always use full project resolution. */
  async setPreviewScale(scale){if(this.previewScale===scale)return;this.previewScale=scale;if(this.project){await this.setProject(this.project);await this.seek(Math.min(this.time,timelineDuration(this.project)));}}
  async setProject(project){this.pause();this.project=project;this.missingMedia=[];const generation=++this.generation;
    for(const [id,item]of this.elements){const clip=project.clips.find(c=>c.id===id),asset=project.assets.find(a=>a.id===clip?.assetId);const wanted=this.sourceFor(asset);if(!clip||item.assetId!==clip.assetId||item.assetData!==wanted){this.release(item);this.elements.delete(id);}}
    const missing=[];
    await Promise.all(project.clips.filter(c=>c.kind!=='title'&&!this.elements.has(c.id)).map(async c=>{
      const a=project.assets.find(a=>a.id===c.assetId),element=c.kind==='image'?new Image():document.createElement(c.kind==='audio'?'audio':'video');
      if(c.kind!=='image'){element.preload='auto';element.playsInline=true;}
      const useProxy=this.sourceFor(a)!==a.path;
      let url;
      if(a.path){
        // A 404 means the project was moved without its files (or the proxy vanished): keep the project open so the user can relink.
        const probe=await fetch(this.sourceFor(a),{headers:{range:'bytes=0-0'}});
        if(probe.status===404&&useProxy){const original=await fetch('/api/media?taskId='+encodeURIComponent(project.taskId)+'&path='+encodeURIComponent(a.path),{headers:{range:'bytes=0-0'}});if(original.ok)url='/api/media?taskId='+encodeURIComponent(project.taskId)+'&path='+encodeURIComponent(a.path);else{missing.push(a.name);return;}}
        else if(probe.status===404){missing.push(a.name);return;}
        else url=this.sourceFor(a);
      }
      else url=URL.createObjectURL(await(await fetch(a.data)).blob());
      const item={element,url,assetId:a.id,assetData:url,trackId:c.trackId};
      try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('انتهت مهلة تحميل '+a.name)),15000);element.addEventListener(c.kind==='image'?'load':'loadeddata',()=>{clearTimeout(timer);resolve();},{once:true});element.addEventListener('error',()=>{clearTimeout(timer);reject(Error('تعذّر فك ترميز '+a.name));},{once:true});element.src=url;});
        if(c.kind!=='image'&&Number.isFinite(element.duration)&&c.in+c.duration*c.speed>element.duration+.08)throw Error('مدة المقطع تتجاوز المصدر الحقيقي: '+a.name+' (المقطع '+(c.in+c.duration*c.speed).toFixed(2)+'ث مقابل مصدر '+(Number.isFinite(element.duration)?element.duration.toFixed(2):'غير معروفة')+'ث)');
        if(this.disposed||generation!==this.generation){this.release(item);return;}this.elements.set(c.id,item);
      }catch(e){this.release(item);throw e;}
    }));
    this.missingMedia=[...new Set(missing)];
    if(generation!==this.generation||this.disposed)return;this.canvas.width=Math.max(2,Math.round(project.width*this.previewScale));this.canvas.height=Math.max(2,Math.round(project.height*this.previewScale));await this.seek(Math.min(this.time,timelineDuration(project)));
  }
  /** Preview prefers the proxy derivative at reduced quality; full quality and offline rendering use the original file. */
  sourceFor(asset){if(asset&&asset.path&&this.previewScale<1&&asset.proxy?.path&&['video','audio'].includes(asset.kind))return '/api/media?taskId='+encodeURIComponent(this.project?.taskId??'')+'&path='+encodeURIComponent(asset.proxy.path);return asset?.path?'/api/media?taskId='+encodeURIComponent(this.project?.taskId??'')+'&path='+encodeURIComponent(asset.path):asset?.data;}
  release(item){item.element.pause?.();item.source?.disconnect();item.gain?.disconnect();item.element.src='';URL.revokeObjectURL(item.url);}
  async audio(){if(!this.context){this.context=new AudioContext();this.mix=this.context.createGain();this.speaker=this.context.createGain();this.output=this.context.createMediaStreamDestination();this.meter=this.context.createAnalyser();this.meter.fftSize=2048;this.mix.connect(this.meter);this.mix.connect(this.output);this.mix.connect(this.speaker);this.speaker.connect(this.context.destination);}await this.context.resume();
    for(const item of this.elements.values()){if(item.element instanceof HTMLMediaElement&&!item.source){item.source=this.context.createMediaElementSource(item.element);item.gain=this.context.createGain();item.gain.gain.value=0;item.source.connect(item.gain);item.gain.connect(this.trackBus(item.trackId??'').gain);}}
  }
  /** Per-track gain+pan bus between clip gains and the master mix; solo/mute/pan are applied every sync. */
  trackBus(trackId){this.buses??=new Map();let bus=this.buses.get(trackId);if(!bus){const gain=this.context.createGain(),low=this.context.createBiquadFilter(),mid=this.context.createBiquadFilter(),high=this.context.createBiquadFilter(),compressor=this.context.createDynamicsCompressor(),pan=this.context.createStereoPanner(),analyser=this.context.createAnalyser();low.type='lowshelf';low.frequency.value=200;mid.type='peaking';mid.frequency.value=1000;mid.Q.value=1;high.type='highshelf';high.frequency.value=4000;analyser.fftSize=1024;gain.connect(low);low.connect(mid);mid.connect(high);high.connect(compressor);compressor.connect(pan);pan.connect(analyser);analyser.connect(this.mix);bus={gain,low,mid,high,compressor,pan,analyser};this.buses.set(trackId,bus);}return bus;}
  /** Peak of all voice-role buses, driving live ducking of the other tracks. */
  voicePeak(){let peak=0;for(const track of this.project?.tracks??[])if(track.role==='voice'){const bus=this.buses?.get(track.id);if(bus?.analyser){const data=new Uint8Array(bus.analyser.fftSize);bus.analyser.getByteTimeDomainData(data);for(const value of data){const centered=Math.abs(value-128)/128;if(centered>peak)peak=centered;}}return peak;}return peak;}
  /** Output device selection when the platform supports AudioContext.setSinkId. */
  async setOutputDevice(deviceId){if(!this.context||typeof this.context.setSinkId!=='function')throw Error('اختيار جهاز الإخراج غير مدعوم في هذا المتصفح.');await this.context.setSinkId(deviceId);}
  trackLevels(trackId){const bus=this.buses?.get(trackId);if(!bus?.analyser)return -1;const data=new Uint8Array(bus.analyser.fftSize);bus.analyser.getByteTimeDomainData(data);let peak=0;for(const value of data){const centered=Math.abs(value-128)/128;if(centered>peak)peak=centered;}return peak;}
  /** Master peak (0..1) after mixing, for level meters; -1 when audio is not running. */
  levels(){if(!this.context||!this.meter)return {peak:-1};const data=new Uint8Array(this.meter.fftSize);this.meter.getByteTimeDomainData(data);let peak=0;for(const value of data){const centered=Math.abs(value-128)/128;if(centered>peak)peak=centered;}return {peak};}
  active(c,time){const track=this.project.tracks.find(t=>t.id===c.trackId);return time>=c.start&&time<c.start+c.duration&&!track.hidden;}
  async seek(time,exact=false){this.pause();this.time=Math.max(0,Math.min(time,timelineDuration(this.project)));await Promise.all(this.project.clips.map(async c=>{const el=this.elements.get(c.id)?.element;if(!(el instanceof HTMLMediaElement)||exact&&(c.kind==='audio'||this.project.tracks.find(t=>t.id===c.trackId)?.hidden))return;const target=Math.max(c.in,Math.min(c.in+Math.max(0,this.time-c.start)*c.speed+(exact?0.00001:0),Math.max(0,el.duration-.001)));if(Math.abs(el.currentTime-target)<(exact ? 0.0000001 : .01))return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('تعذّر الانتقال داخل '+c.name)),5000);el.addEventListener('seeked',()=>{clearTimeout(timer);resolve();},{once:true});el.currentTime=target;});}));this.draw();this.onTime(this.time,false);}
  draw(){const {canvas,project:p}=this,ctx=canvas.getContext('2d'),renderTime=Math.min(this.time,Math.max(0,timelineDuration(p)-1/p.fps));ctx.globalAlpha=1;ctx.fillStyle=p.background;ctx.fillRect(0,0,canvas.width,canvas.height);
    for(const track of p.tracks){if(track.hidden||track.kind==='audio')continue;
      if(track.adjust){const snapshot=document.createElement('canvas');snapshot.width=canvas.width;snapshot.height=canvas.height;snapshot.getContext('2d').drawImage(canvas,0,0);ctx.save();ctx.clearRect(0,0,canvas.width,canvas.height);ctx.filter=colorFilter(track);ctx.drawImage(snapshot,0,0);ctx.restore();ctx.filter='none';continue;}
      const target=track.blend&&track.blend!=='normal'?(this.layerCanvas??=document.createElement('canvas')):null;
      if(target){target.width=canvas.width;target.height=canvas.height;}
      const layer=target?target.getContext('2d'):ctx;
      if(target)layer.clearRect(0,0,target.width,target.height);
      for(const c of p.clips.filter(c=>c.trackId===track.id).sort((a,b)=>a.start-b.start)){if(!this.active(c,renderTime)||c.kind==='audio')continue;const motion=this.easedClip(c,renderTime),transition=transitionAt(motion,renderTime);layer.save();if(transition.wipe){layer.beginPath();const wipeFrom=transition.wipeDirection<0;const x0=wipeFrom?0:canvas.width*(1-transition.wipe);const x1=wipeFrom?canvas.width*transition.wipe:canvas.width;layer.rect(x0,0,x1-x0,canvas.height);layer.clip();}layer.globalAlpha=transition.opacity;layer.translate(canvas.width*(.5+motion.x+transition.offset),canvas.height*(.5+motion.y));
        if(c.kind==='title'){const track=p.tracks.find(t=>t.id===c.trackId);const style=track?.role==='subtitles'?track.subsStyle:undefined;const scale=this.canvas.width/p.width;const fontSizePx=c.fontSize*motion.scale*scale;layer.font=`600 ${fontSizePx}px sans-serif`;layer.textAlign='center';layer.direction='rtl';const lines=c.text.split('\n');const lineH=c.fontSize*1.3*scale;const width=Math.max(...lines.map(l=>layer.measureText(l).width))+fontSizePx*.4;const height=lineH*lines.length;const originY=canvas.height*(.5+motion.y);const top=style?Math.max((style.safe??0)*canvas.height-originY,Math.min(-height/2,canvas.height-(style.safe??0)*canvas.height-height-originY)):-height/2;
          if(style?.bg&&style.bgOpacity>0){layer.save();layer.globalAlpha=transition.opacity*style.bgOpacity;layer.fillStyle=style.bg;layer.fillRect(-width/2,top,width,height);layer.restore();}
          layer.globalAlpha=transition.opacity;layer.fillStyle=c.color;layer.shadowColor='#000a';layer.shadowBlur=5*Math.max(.25,scale);
          lines.forEach((line,i)=>{const y=top+lineH*(i+.5)+fontSizePx*.35;if(style?.outlineWidth>0){layer.lineWidth=style.outlineWidth*scale*2;layer.strokeStyle=style.outline;layer.lineJoin='round';layer.strokeText(line,0,y,canvas.width*.9);}layer.fillText(line,0,y,canvas.width*.9);});}
        else{const el=this.elements.get(c.id)?.element,w=el?.videoWidth||el?.naturalWidth,h=el?.videoHeight||el?.naturalHeight;if(w&&h){const scale=Math.min(canvas.width/w,canvas.height/h)*motion.scale,drawW=w*scale,drawH=h*scale;const chroma=c.effects?.find(effect=>effect.type==='chroma'&&effect.enabled!==false);const needsLut=c.effects?.some(effect=>effect.type==='lut'&&effect.enabled!==false&&effect.params.cube);const mask=c.effects?.find(effect=>effect.type==='mask'&&effect.enabled!==false);const chain=[colorFilter(c),effectsFilter(c)].filter(part=>part&&part!=='none').join(' ');if(chroma||mask||needsLut){const scratch=this.scratchCanvas??=document.createElement('canvas');scratch.width=Math.min(canvas.width,Math.max(2,Math.round(drawW)));scratch.height=Math.min(canvas.height,Math.max(2,Math.round(drawH)));const sctx=scratch.getContext('2d',{willReadFrequently:true});sctx.clearRect(0,0,scratch.width,scratch.height);sctx.filter=chain||'none';sctx.drawImage(el,0,0,scratch.width,scratch.height);sctx.filter='none';if(chroma)this.applyChroma(sctx,chroma.params);const lut=c.effects?.find(effect=>effect.type==='lut'&&effect.enabled!==false&&effect.params.cube);if(lut)this.applyLut(sctx,lut.params);if(mask)this.applyMask(sctx,mask.params);layer.drawImage(scratch,-drawW/2,-drawH/2,drawW,drawH);}else{layer.filter=chain||'none';layer.drawImage(el,-drawW/2,-drawH/2,drawW,drawH);}layer.filter='none';}}
        layer.restore();}
      if(target){ctx.save();ctx.globalCompositeOperation=track.blend;ctx.drawImage(target,0,0);ctx.restore();}
    }
    this.drawSafeGuides();
  }
  syncMedia(){const anySolo=this.project.tracks.some(t=>t.solo);const duck=this.project.duck?.enabled?this.voicePeak():0;const duckFactor=1-(this.project.duck?.amount??0.6)*(duck>0.01?Math.min(1,duck*8):0);for(const track of this.project.tracks){const bus=this.buses?.get(track.id);if(bus){const role=track.role==='voice';bus.gain.gain.value=(anySolo?(track.solo?1:0):(track.muted?0:1)*(track.volume??1))*(role?1:duckFactor);bus.pan.pan.value=Math.max(-1,Math.min(1,track.pan??0));const eq=track.eq;bus.low.gain.value=eq?.low??0;bus.mid.gain.value=eq?.mid??0;bus.high.gain.value=eq?.high??0;const comp=track.compressor;bus.compressor.threshold.value=comp?.enabled?(comp.threshold??-24):0;bus.compressor.ratio.value=comp?.enabled?(comp.ratio??4):1;}}for(const c of this.project.clips){const item=this.elements.get(c.id);if(!(item?.element instanceof HTMLMediaElement))continue;const el=item.element,track=this.project.tracks.find(t=>t.id===c.trackId),active=this.active(c,this.time);if(item.trackId!==c.trackId){try{item.gain.disconnect();}catch{}item.gain.connect(this.trackBus(c.trackId));item.trackId=c.trackId;}if(item.gain)item.gain.gain.value=active?animatedValue(c,'volume',this.time)*(c.transition==='none'?1:transitionAt(c,this.time).audio):0;
      if(active){const target=c.in+(this.time-c.start)*c.speed;el.playbackRate=c.speed;if(Math.abs(el.currentTime-target)>.18&&!el.seeking)el.currentTime=target;if(el.paused&&!el.ended)el.play().catch(e=>{this.error=e;this.pause();});}else el.pause();}}
  async play(){if(this.playing)return;await this.audio();const rangeEnd=this.project.range?.out??timelineDuration(this.project);if(this.time>=rangeEnd-1e-9||(this.project.range&&this.time<this.project.range.in-1e-9))await this.seek(this.project.range?.in??0);this.error=null;this.playing=true;this.started=performance.now()-this.time*1000;
    const tick=()=>{if(!this.playing)return;this.time=Math.min((performance.now()-this.started)/1000,this.rangeEnd??this.project.range?.out??timelineDuration(this.project));this.syncMedia();this.draw();this.onTime(this.time,true);if(this.time>=(this.rangeEnd??this.project.range?.out??timelineDuration(this.project))){this.pause();return;}this.raf=requestAnimationFrame(tick);};tick();}
  pause(){this.playing=false;cancelAnimationFrame(this.raf);for(const item of this.elements.values()){item.element.pause?.();if(item.gain)item.gain.gain.value=0;}this.onTime?.(this.time,false);}
  async export(format,onProgress,signal,range){const mime=format==='mp4'?mp4Type():['video/webm;codecs=vp8,opus','video/webm'].find(t=>MediaRecorder.isTypeSupported(t));if(!mime)throw Error('ترميز '+format.toUpperCase()+' غير متاح في هذا المتصفح.');if(!this.project.clips.length)throw Error('أضف مقاطع إلى الخط الزمني أولًا.');
    // Realtime capture must run at full project resolution even while the preview is scaled down.
    const restoreScale=this.previewScale;if(restoreScale!==1)await this.setPreviewScale(1);
    try{
    this.rangeEnd=range?.end;await this.seek(range?.start||0);await this.audio();this.speaker.gain.value=0;const stream=this.canvas.captureStream(this.project.fps);for(const track of this.output.stream.getAudioTracks())stream.addTrack(track.clone());const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:8000000,audioBitsPerSecond:192000}),chunks=[];let timer;
    const abort=()=>{if(recorder.state==='recording')recorder.stop();this.pause();};signal.addEventListener('abort',abort,{once:true});
    try{if(signal.aborted)throw Error('أُلغي التصدير.');const done=new Promise((resolve,reject)=>{recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.onstop=resolve;recorder.onerror=()=>reject(Error('فشل ترميز الفيديو.'));});recorder.start(250);await this.play();const deadline=performance.now()+((range?.end??timelineDuration(this.project))-(range?.start||0))*1000+15000;
      timer=setInterval(()=>{onProgress((this.time-(range?.start||0))/((range?.end??timelineDuration(this.project))-(range?.start||0)));if(!this.playing||performance.now()>deadline){if(performance.now()>deadline)this.error=Error('توقف العرض أثناء التصدير. أعد المحاولة مع إبقاء النافذة ظاهرة.');if(recorder.state==='recording')recorder.stop();}},30);
      await done;if(signal.aborted)throw Error('أُلغي التصدير.');if(this.error)throw this.error;const blob=new Blob(chunks,{type:format==='mp4'?'video/mp4':'video/webm'});if(blob.size<500)throw Error('ملف التصدير فارغ.');return format==='webm'?await finalizeWebM(blob,(range?.end??timelineDuration(this.project))-(range?.start||0)):blob;
    }finally{clearInterval(timer);signal.removeEventListener('abort',abort);if(recorder.state==='recording')recorder.stop();this.pause();this.rangeEnd=undefined;this.speaker.gain.value=1;stream.getTracks().forEach(t=>t.stop());}
    }finally{if(restoreScale!==1)await this.setPreviewScale(restoreScale).catch(()=>{});}}
  drawSafeGuides(){if(!this.safeFraction)return;const {canvas}=this,ctx=canvas.getContext('2d'),mx=canvas.width*this.safeFraction,my=canvas.height*this.safeFraction;ctx.save();ctx.strokeStyle='rgba(224,160,106,.7)';ctx.setLineDash([8,6]);ctx.lineWidth=2;ctx.strokeRect(mx,my,canvas.width-mx*2,canvas.height-my*2);ctx.restore();}
  easedClip(clip,time){const value={...clip};for(const field of ['x','y','scale','opacity','volume'])value[field]=easedValue(clip,field,time);return value;}
  /** Per-pixel chroma key with soft edge: normalized RGB distance vs similarity, feathered by smoothness. */
  applyChroma(ctx,params){
    const image=ctx.getImageData(0,0,ctx.canvas.width,ctx.canvas.height),data=image.data;
    const keyR=Number.parseInt(params.color.slice(1,3),16),keyG=Number.parseInt(params.color.slice(3,5),16),keyB=Number.parseInt(params.color.slice(5,7),16);
    const similarity=Math.max(.01,params.similarity),smoothness=params.smoothness;
    for(let i=0;i<data.length;i+=4){
      const distance=Math.sqrt(((data[i]-keyR)/255)**2+((data[i+1]-keyG)/255)**2+((data[i+2]-keyB)/255)**2)/Math.sqrt(3);
      if(distance<similarity)data[i+3]=0;
      else if(distance<similarity+smoothness)data[i+3]=Math.round(data[i+3]*Math.min(1,(distance-similarity)/Math.max(.001,smoothness)));
    }
    ctx.putImageData(image,0,0);
  }
  /** Apply a .cube LUT with strength blending: out = mix(src, lut(src), strength). */
  applyLut(ctx,params){
    const lut=parseCube(params.cube);const strength=Math.max(0,Math.min(1,params.strength??1));
    const image=ctx.getImageData(0,0,ctx.canvas.width,ctx.canvas.height),data=image.data;
    for(let i=0;i<data.length;i+=4){
      const [r,g,b]=sampleLut(lut,data[i]/255,data[i+1]/255,data[i+2]/255);
      data[i]=Math.round(data[i]+(r*255-data[i])*strength);
      data[i+1]=Math.round(data[i+1]+(g*255-data[i+1])*strength);
      data[i+2]=Math.round(data[i+2]+(b*255-data[i+2])*strength);
    }
    ctx.putImageData(image,0,0);
  }
  /** Geometric mask with feathered edges; invert flips keep/out. */
  applyMask(ctx,params){
    const width=ctx.canvas.width,height=ctx.canvas.height,cx=params.x*width,cy=params.y*height,halfW=params.w*width/2,halfH=params.h*height/2;
    const mask=document.createElement('canvas');mask.width=width;mask.height=height;
    const mctx=mask.getContext('2d');
    mctx.filter='blur('+params.feather+'px)';
    mctx.fillStyle='#fff';
    if(params.shape==='ellipse'){mctx.beginPath();mctx.ellipse(cx,cy,halfW,halfH,0,0,Math.PI*2);mctx.fill();}
    else mctx.fillRect(cx-halfW,cy-halfH,halfW*2,halfH*2);
    ctx.save();
    ctx.globalCompositeOperation=params.invert?'destination-out':'destination-in';
    ctx.drawImage(mask,0,0);
    ctx.restore();
  }
  dispose(){this.disposed=true;this.generation++;this.pause();for(const item of this.elements.values())this.release(item);this.elements.clear();void this.context?.close();}
}
