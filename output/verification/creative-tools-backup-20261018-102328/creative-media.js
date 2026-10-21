import {finalizeWebM} from './creative-webm.js';
const defaults=()=>({brightness:100,contrast:100,saturation:100,grayscale:0,blur:0,rotation:0,ratio:'original',text:'',start:0,end:0,muted:false});
const dataURL=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('تعذّر قراءة الملف'));r.readAsDataURL(blob);});
const download=(blob,name)=>{const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
export function installCreativeMedia({root,identity,signal}){
  const button=document.createElement('button');button.type='button';button.textContent='الصور والفيديو والمؤثرات';button.dataset.mediaOpen='';root.querySelector('.creative-toolbar').append(button);
  let dialog,source,sourceBlob,sourceName='',url,raf,recording=false,recorder,settings=defaults(),kind,disposed=false;
  const notice=text=>{if(dialog)dialog.querySelector('[data-media-status]').textContent=text;};
  const $=selector=>dialog.querySelector(selector);
  function stop(){source?.pause?.();cancelAnimationFrame(raf);if(recorder?.state==='recording')recorder.stop();}
  function cleanup(){stop();if(url)URL.revokeObjectURL(url);url=null;source=null;sourceBlob=null;dialog?.remove();dialog=null;}
  signal.addEventListener('abort',()=>{disposed=true;cleanup();},{once:true});
  function draw(){if(!source||!dialog)return;const canvas=$('canvas'),ctx=canvas.getContext('2d'),w=source.videoWidth||source.naturalWidth,h=source.videoHeight||source.naturalHeight;if(!w||!h)return;
    const swapped=settings.rotation%180!==0,rw=swapped?h:w,rh=swapped?w:h;
    const ratio=settings.ratio==='square'?1:settings.ratio==='wide'?16/9:settings.ratio==='portrait'?9/16:rw/rh;
    const cw=Math.min(rw,rh*ratio),ch=cw/ratio,scale=Math.min(1,1920/Math.max(cw,ch));
    const width=Math.max(2,Math.round(cw*scale/2)*2),height=Math.max(2,Math.round(ch*scale/2)*2);
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    ctx.save();ctx.fillStyle='#111722';ctx.fillRect(0,0,width,height);ctx.translate(width/2,height/2);ctx.scale(scale,scale);ctx.rotate(settings.rotation*Math.PI/180);
    ctx.filter=`brightness(${settings.brightness}%) contrast(${settings.contrast}%) saturate(${settings.saturation}%) grayscale(${settings.grayscale}%) blur(${settings.blur}px)`;
    ctx.drawImage(source,-w/2,-h/2,w,h);ctx.restore();
    if(settings.text){ctx.font=`600 ${Math.max(16,Math.round(width/24))}px sans-serif`;ctx.textAlign='center';ctx.direction='rtl';ctx.fillStyle='white';ctx.shadowColor='black';ctx.shadowBlur=6;ctx.fillText(settings.text,width/2,height*.9,width*.9);ctx.shadowBlur=0;}
    if(kind==='video'){$('[data-media-time]').textContent=source.currentTime.toFixed(2)+' / '+source.duration.toFixed(2)+' s';if(!recording&&source.currentTime>=settings.end)source.pause();}
  }
  function tick(){draw();if(dialog)raf=requestAnimationFrame(tick);}
  function fields(){for(const [key,value]of Object.entries(settings)){const el=$(`[data-media-field="${key}"]`);if(el){if(el.type==='checkbox')el.checked=value;else el.value=value;}}$('[data-media-video]').hidden=kind!=='video';}
  async function load(blob,name,initial){
    if(blob.size>30*1024*1024)throw Error('الحد الأقصى للوسائط 30 MB.');
    const nextKind=blob.type.startsWith('image/')?'image':blob.type.startsWith('video/')?'video':null;if(!nextKind)throw Error('اختر صورة PNG/JPEG/WebP أو فيديو يدعمه المتصفح.');
    const next=nextKind==='image'?new Image():document.createElement('video'),nextUrl=URL.createObjectURL(blob);
    if(nextKind==='video'){next.preload='auto';next.playsInline=true;}
    try{await new Promise((resolve,reject)=>{next.addEventListener(nextKind==='image'?'load':'loadeddata',resolve,{once:true});next.addEventListener('error',()=>reject(Error('تعذّر فك ترميز هذا الملف. جرّب PNG أو MP4/WebM.')),{once:true});next.src=nextUrl;});
      if(!dialog||disposed){URL.revokeObjectURL(nextUrl);return;}
      if(nextKind==='video'&&(!Number.isFinite(next.duration)||next.duration<=0))throw Error('الفيديو يحتاج مدة صالحة ومحددة.');
      const nextSettings={...defaults(),end:nextKind==='video'?next.duration:0,...initial};
      if(nextKind==='video'&&(nextSettings.start<0||nextSettings.end>next.duration+.05||nextSettings.end<=nextSettings.start))throw Error('حدود قص الفيديو غير صالحة.');
      stop();if(url)URL.revokeObjectURL(url);url=nextUrl;source=next;sourceBlob=blob;sourceName=name;kind=nextKind;settings=nextSettings;
      if(kind==='video'){source.currentTime=settings.start;source.muted=settings.muted;}
      fields();tick();notice('جاهز · '+name);$('[data-media-controls]').disabled=false;
    }catch(e){URL.revokeObjectURL(nextUrl);throw e;}
  }
  async function importFile(file){if(!file)return;if(/\.json$/i.test(file.name)){
    if(file.size>45*1024*1024)throw Error('ملف مشروع الوسائط أكبر من 45 MB.');
    const project=JSON.parse(await file.text());if(project.format!=='loam-media'||project.version!==1||typeof project.source!=='string'||!/^data:(image\/(png|jpeg|webp)|video\/(mp4|webm));base64,/.test(project.source))throw Error('ملف مشروع وسائط غير صالح.');
    const v=project.settings;if(!v||typeof v!=='object')throw Error('إعدادات المشروع غير صالحة.');
    for(const [key,min,max]of [['brightness',0,200],['contrast',0,200],['saturation',0,200],['grayscale',0,100],['blur',0,20],['start',0,86400],['end',0,86400]])if(typeof v[key]!=='number'||!Number.isFinite(v[key])||v[key]<min||v[key]>max)throw Error('قيمة مؤثر غير صالحة.');
    if(![0,90,180,270].includes(v.rotation)||!['original','square','wide','portrait'].includes(v.ratio)||typeof v.text!=='string'||v.text.length>200||typeof v.muted!=='boolean')throw Error('إعدادات المشروع غير صالحة.');
    await load(await(await fetch(project.source)).blob(),String(project.name||'media'),v);
  }else await load(file,file.name);}
  async function projectBlob(){if(!sourceBlob)throw Error('استورد ملفًا أولًا.');const snapshot=structuredClone(settings),name=sourceName,blob=sourceBlob;return new Blob([JSON.stringify({format:'loam-media',version:1,name,source:await dataURL(blob),settings:snapshot})],{type:'application/json'});}
  async function exportMedia(){if(!source)throw Error('استورد ملفًا أولًا.');draw();if(kind==='image'){const blob=await new Promise(resolve=>$('canvas').toBlob(resolve,'image/png'));if(!blob)throw Error('تعذّر تصدير الصورة.');download(blob,'loam-image.png');notice('تم تصدير PNG');return;}
    if(!window.MediaRecorder||!HTMLCanvasElement.prototype.captureStream)throw Error('تصدير الفيديو غير مدعوم في هذا المتصفح.');
    const mime=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(t=>MediaRecorder.isTypeSupported(t));if(!mime)throw Error('ترميز WebM غير متاح.');
    let stream,audioContext,audioSource,timer,canceled=false;recording=true;$('[data-media-controls]').disabled=true;$('[data-media-close]').disabled=true;$('[data-media-cancel]').hidden=false;
    const cancel=()=>{canceled=true;if(recorder?.state==='recording')recorder.stop();};$('[data-media-cancel]').onclick=cancel;
    try{
      source.pause();source.currentTime=settings.start;await new Promise(resolve=>{if(!source.seeking)resolve();else source.addEventListener('seeked',resolve,{once:true});});draw();
      stream=$('canvas').captureStream(30);
      if(!settings.muted){audioContext=new AudioContext();audioSource=audioContext.createMediaElementSource(source);const output=audioContext.createMediaStreamDestination();audioSource.connect(output);await audioContext.resume();for(const track of output.stream.getAudioTracks())stream.addTrack(track);}
      const chunks=[];recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:6000000});
      const done=new Promise((resolve,reject)=>{recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.onstop=resolve;recorder.onerror=()=>reject(Error('فشل تسجيل الفيديو'));});
      recorder.start(250);await source.play();notice('جارٍ تصدير WebM بالوقت الفعلي… أبقِ النافذة مفتوحة.');
      timer=setInterval(()=>{if(source.currentTime>=settings.end||source.ended){source.pause();if(recorder.state==='recording')recorder.stop();}},20);
      await done;if(disposed||!dialog||canceled)return;
      const blob=new Blob(chunks,{type:'video/webm'});if(blob.size<100)throw Error('لم ينتج التسجيل فيديو صالحًا.');download(await finalizeWebM(blob,Math.min(source.currentTime,settings.end)-settings.start),'loam-video.webm');notice('تم تصدير WebM');
    }finally{clearInterval(timer);if(recorder?.state==='recording')recorder.stop();source?.pause?.();stream?.getTracks().forEach(t=>t.stop());audioSource?.disconnect();await audioContext?.close();recording=false;if(dialog){$('[data-media-controls]').disabled=false;$('[data-media-close]').disabled=false;$('[data-media-cancel]').hidden=true;}
      // A media element can have only one AudioContext source over its lifetime.
      if(audioSource&&sourceBlob&&dialog){const time=source.currentTime;await load(sourceBlob,sourceName,settings);source.currentTime=time;if(!canceled)notice('تم تصدير WebM');}
    }
  }
  async function action(fn){try{await fn();}catch(e){notice(e.message);}}
  button.addEventListener('click',()=>{
    if(dialog){dialog.showModal();return;}dialog=document.createElement('dialog');dialog.className='creative-media';
    dialog.innerHTML=`<header><strong>Loam · الصور والفيديو</strong><button data-media-close>إغلاق</button></header><p>حرّر صورة أو مقطع فيديو، ثم صدّر النتيجة أو احفظ ملف المشروع لاستكماله. قص المدة والمؤثرات يطبّقان على التصدير. حد المصدر 30 MB. احفظ المشروع قبل مغادرة مساحة العمل.</p><fieldset data-media-controls><div class="creative-media-toolbar"><button data-media-import>استيراد صورة / فيديو / مشروع</button><input data-media-file type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,.json" hidden><button data-media-project>تنزيل المشروع JSON</button><button data-media-save>حفظ المشروع في المهمة</button><button data-media-export>تصدير النتيجة</button><button data-media-list>مشاريع المهمة المحفوظة</button><select data-media-saved aria-label="فتح مشروع وسائط محفوظ" hidden></select></div><canvas width="640" height="360" aria-label="معاينة الوسائط"></canvas><div class="creative-media-fields">${[['brightness','السطوع',200,100],['contrast','التباين',200,100],['saturation','التشبع',200,100],['grayscale','أبيض وأسود',100,0],['blur','التمويه',20,0]].map(([key,label,max,value])=>`<label>${label}<input data-media-field="${key}" type="range" min="0" max="${max}" value="${value}"></label>`).join('')}<label>الدوران<select data-media-field="rotation"><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label><label>اقتصاص مركزي<select data-media-field="ratio"><option value="original">الأصل</option><option value="square">1:1</option><option value="wide">16:9</option><option value="portrait">9:16</option></select></label><label>نص على الصورة<input data-media-field="text" maxlength="200"></label></div><div data-media-video hidden><button data-media-play>تشغيل المعاينة</button><label>من ثانية <input type="number" data-media-field="start" min="0" step=".1" value="0"></label><label>إلى ثانية <input type="number" data-media-field="end" min="0" step=".1" value="0"></label><label><input type="checkbox" data-media-field="muted">كتم الصوت</label><output data-media-time></output></div></fieldset><button data-media-cancel hidden>إلغاء التصدير</button><p data-media-status role="status">استورد ملفًا للبدء. تصدير الصور PNG والفيديو WebM حتى 1920 بكسل.</p>`;
    document.body.append(dialog);dialog.showModal();
    $('[data-media-close]').onclick=()=>dialog.close();dialog.addEventListener('cancel',e=>{if(recording)e.preventDefault();});dialog.addEventListener('close',()=>{source?.pause?.();});
    $('[data-media-import]').onclick=()=>$('[data-media-file]').click();$('[data-media-file]').onchange=e=>{const file=e.target.files[0];e.target.value='';void action(()=>importFile(file));};
    dialog.addEventListener('input',e=>{const key=e.target.dataset.mediaField;if(!key)return;if(!source){fields();notice('استورد ملفًا أولًا.');return;}const value=e.target.type==='checkbox'?e.target.checked:['text','ratio'].includes(key)?e.target.value:Number(e.target.value);if(['start','end'].includes(key)&&(!Number.isFinite(value)||value<0||value>source.duration||(key==='start'?value>=settings.end:value<=settings.start))){notice('اختر بداية أقل من النهاية وضمن مدة الفيديو.');fields();return;}settings[key]=value;if(kind==='video'){source.muted=settings.muted;if(key==='start')source.currentTime=value;}draw();});
    $('[data-media-play]').onclick=()=>void action(async()=>{if(source.paused){if(source.currentTime>=settings.end)source.currentTime=settings.start;await source.play();}else source.pause();});
    $('[data-media-project]').onclick=()=>void action(async()=>{download(await projectBlob(),'loam-media.json');notice('تم تنزيل المشروع مع المصدر والمؤثرات');});
    $('[data-media-save]').onclick=()=>void action(async()=>{const blob=await projectBlob(),id=await identity();const response=await fetch('/api/upload?taskId='+encodeURIComponent(id)+'&name=loam-media.json',{method:'POST',body:blob});const result=await response.json();if(!response.ok)throw Error(result.error||'تعذّر الحفظ');notice('حُفظ في ملفات المهمة: '+result.path+' · نزّله واستورده لاستكمال التعديل.');});
    $('[data-media-list]').onclick=()=>void action(async()=>{const id=await identity(),response=await fetch('/api/files?taskId='+encodeURIComponent(id)+'&path=uploads&max=2000');if(response.status===404){notice('لا توجد مشاريع محفوظة في هذه المهمة.');return;}const data=await response.json();if(!response.ok)throw Error(data.error);const files=data.entries.filter(f=>!f.dir&&f.name.endsWith('loam-media.json')),select=$('[data-media-saved]');select.replaceChildren(new Option('اختر مشروعًا محفوظًا…',''),...files.map(f=>new Option(f.name,f.path)));select.hidden=!files.length;notice(files.length?'اختر الملف لاستكمال التعديل.':'لا توجد مشاريع وسائط محفوظة.');});
    $('[data-media-saved]').onchange=e=>void action(async()=>{const path=e.target.value;if(!path)return;const id=await identity(),response=await fetch('/api/media?taskId='+encodeURIComponent(id)+'&path='+encodeURIComponent(path));if(!response.ok)throw Error('تعذّر فتح المشروع');await importFile(new File([await response.blob()],'loam-media.json',{type:'application/json'}));});
    $('[data-media-export]').onclick=()=>void action(exportMedia);
  },{signal});
  return {dispose:cleanup};
}
