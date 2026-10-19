import {uploadAsset} from './creative-timeline-storage.js';
import {relinkAsset,removeAssets,validateTimeline,uid} from './creative-timeline-model.js';
const FALLBACK='data:image/svg+xml;charset=utf-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="54"><rect width="96" height="54" rx="4" fill="#1b2634"/><text x="48" y="34" font-size="18" text-anchor="middle" fill="#5b7186">&#9671;</text></svg>');
export const formatBytes=n=>n>=1073741824?(n/1073741824).toFixed(1)+' GB':n>=1048576?(n/1048576).toFixed(1)+' MB':n>=1024?Math.round(n/1024)+' KB':n+' B';
const kindLabels={video:'فيديو',image:'صورة',audio:'صوت'};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/** Client-side media probe used before uploading a replacement or importing files. */
export async function probeMedia(file){
  const kind=file.type.startsWith('image/')?'image':file.type.startsWith('video/')?'video':file.type.startsWith('audio/')?'audio':null;
  if(!kind)throw Error('صيغة وسائط غير مدعومة: '+file.name);
  const url=URL.createObjectURL(file),el=kind==='image'?new Image():document.createElement(kind==='audio'?'audio':'video');
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('انتهت مهلة تحميل '+file.name)),15000);el.addEventListener(kind==='image'?'load':'loadedmetadata',()=>{clearTimeout(timer);resolve();},{once:true});el.onerror=()=>{clearTimeout(timer);reject(Error('تعذّر فك ترميز '+file.name));};el.src=url;});
    if(kind==='image')return {kind,duration:0,width:el.naturalWidth,height:el.naturalHeight};
    if(!Number.isFinite(el.duration)||el.duration<=0)throw Error('مدة الملف غير صالحة: '+file.name);
    return {kind,duration:el.duration,width:el.videoWidth,height:el.videoHeight};
  }finally{el.pause?.();el.src='';URL.revokeObjectURL(url);}
}
/** Tags are comma-separated (Arabic comma allowed), unique, at most 8, each 1..40 chars. */
export function parseTags(value){
  const tags=[...new Set(String(value||'').split(/[,،]/).map(s=>s.trim()).filter(Boolean))];
  if(tags.length>8)throw Error('ثمانية وسوم كحد أقصى لكل أصل.');
  for(const tag of tags){if(tag.length>40)throw Error('الوسم أطول من 40 حرفًا.');if(/[\u0000-\u001f]/.test(tag))throw Error('الوسم يحوي محارف غير صالحة.');}
  return tags;
}
const thumbnails=new Map();
function drawWave(ctx,samples){const w=96,h=54;ctx.fillStyle='#1b2634';ctx.fillRect(0,0,w,h);ctx.strokeStyle='#58e6d3';ctx.beginPath();const step=Math.max(1,Math.floor(samples.length/w));for(let x=0;x<w;x++){let peak=0;const start=x*step,end=Math.min(samples.length,start+step);for(let i=start;i<end;i++){const v=Math.abs(samples[i]);if(v>peak)peak=v;}ctx.moveTo(x+.5,h/2);ctx.lineTo(x+.5,h/2-peak*h/2*.9);}ctx.stroke();}
async function generateThumb(asset,taskId){
  const canvas=document.createElement('canvas');canvas.width=96;canvas.height=54;const ctx=canvas.getContext('2d');
  const url=asset.path?'/api/media?taskId='+encodeURIComponent(taskId)+'&path='+encodeURIComponent(asset.path):asset.data;
  if(asset.kind==='image'){const img=new Image();await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('timeout')),10000);img.onload=()=>{clearTimeout(timer);resolve();};img.onerror=()=>{clearTimeout(timer);reject(Error('load'));};img.src=url;});const w=img.naturalWidth||96,h=img.naturalHeight||54,scale=Math.max(96/w,54/h);ctx.drawImage(img,(96-w*scale)/2,(54-h*scale)/2,w*scale,h*scale);}
  else if(asset.kind==='video'){const video=document.createElement('video');video.muted=true;video.preload='auto';video.playsInline=true;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('timeout')),10000);video.addEventListener('loadeddata',()=>{clearTimeout(timer);resolve();},{once:true});video.addEventListener('error',()=>{clearTimeout(timer);reject(Error('load'));},{once:true});video.src=url;});video.currentTime=Math.min(.5,(video.duration||1)/2);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('timeout')),10000);video.addEventListener('seeked',()=>{clearTimeout(timer);resolve();},{once:true});});const w=video.videoWidth||16,h=video.videoHeight||9,scale=Math.max(96/w,54/h);ctx.drawImage(video,(96-w*scale)/2,(54-h*scale)/2,w*scale,h*scale);video.src='';}
  else if(asset.kind==='audio'&&asset.duration<=180&&(!asset.bytes||asset.bytes<=80*1024*1024)){
    const response=await fetch(url);if(!response.ok)throw Error('fetch');
    const context=new (window.AudioContext||window.webkitAudioContext)();
    try{drawWave(ctx,(await context.decodeAudioData(await response.arrayBuffer())).getChannelData(0));}finally{void context.close();}
  }
  else return FALLBACK;
  const data=canvas.toDataURL('image/png');
  return data.length>2000?FALLBACK:data;
}
/** Server-cached thumbnail first (survives reloads); on miss, generate in-browser and persist the PNG back to the task. */
export function thumbnailFor(asset,taskId){
  const key=(asset.path||'data')+':'+asset.id;
  if(thumbnails.has(key))return thumbnails.get(key);
  const promise=(async()=>{
    if(asset.path){
      try{
        const cached='/api/media?taskId='+encodeURIComponent(taskId)+'&path='+encodeURIComponent('assets/timeline/cache/'+asset.path.split('/').pop()+'.png');
        if((await fetch(cached,{headers:{range:'bytes=0-0'}})).ok)return cached;
      }catch{/* generate below */}
    }
    try{
      const data=await generateThumb(asset,taskId);
      if(asset.path&&typeof data==='string'&&data.startsWith('data:image/png'))void fetch('/api/timeline/thumb?taskId='+encodeURIComponent(taskId),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:asset.path,data})}).catch(()=>{});
      return data;
    }catch{return FALLBACK;}
  })();
  thumbnails.set(key,promise);
  return promise;
}
function metaText(asset){const m=asset.meta;if(!m)return '';const parts=[];if(m.width&&m.height)parts.push(m.width+'×'+m.height);if(m.videoCodec)parts.push(m.videoCodec);if(m.audioCodec)parts.push(m.audioCodec);if(m.hasAudio===false)parts.push('بلا صوت');if(m.transparent)parts.push('شفاف');if(m.sampleRate)parts.push(Math.round(m.sampleRate/100)/10+'kHz');return parts.length?' · '+parts.join(' · '):'';}
const libraryState={search:'',kind:'',folder:''};
const wired=new WeakSet();
const proxyTokens=new Map();
const activeProxyJobs=new Map();
/** Proxy jobs: start / cancel / retry with live button state; results attach to the asset when done. */
async function proxyJobFlow(hooks,assetId,button){
  const taskId=await hooks.identity();
  const asset=()=>hooks.getProject().assets.find(a=>a.id===assetId);
  const api=async(route,body)=>{const response=await fetch('/api/timeline/'+route+'?taskId='+encodeURIComponent(taskId),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error||'تعذّر تنفيذ عملية الـproxy.');return result;};
  const action=button.dataset.jobAction||'create';
  if(action==='cancel'&&button.dataset.jobId){
    try{const job=(await api('proxy-job',{id:button.dataset.jobId,action:'cancel'})).job;activeProxyJobs.set(assetId,{id:job.id,action:'retry'});button.textContent='إعادة المحاولة';button.dataset.jobAction='retry';hooks.status('أُلغيت عملية الـproxy؛ يمكن إعادة المحاولة.');}catch(error){hooks.status(error.message);}
    return;
  }
  const token=(proxyTokens.get(assetId)||0)+1;proxyTokens.set(assetId,token);
  const alive=()=>proxyTokens.get(assetId)===token;
  try{
    let job=action==='retry'&&button.dataset.jobId?(await api('proxy-job',{id:button.dataset.jobId,action:'retry'})).job:(await api('proxy',{path:asset()?.path})).job;
    button.dataset.jobId=job.id;activeProxyJobs.set(assetId,{id:job.id,action:'cancel'});
    for(let guard=0;guard<3600&&alive();guard++){
      const current=document.querySelector('[data-asset-proxy="'+assetId+'"]');
      if(!current)break;
      current.dataset.jobId=job.id;
      current.dataset.jobAction=['queued','running'].includes(job.state)?'cancel':['failed','canceled'].includes(job.state)?'retry':'none';
      current.textContent=job.state==='running'||job.state==='queued'?'إلغاء التوليد…':job.state==='failed'?'إعادة المحاولة':job.state==='canceled'?'إعادة المحاولة':'إعادة Proxy';
      if(['done','failed','canceled'].includes(job.state))break;
      await new Promise(resolve=>setTimeout(resolve,700));
      const response=await fetch('/api/timeline/proxy-job?taskId='+encodeURIComponent(taskId)+'&id='+encodeURIComponent(job.id));
      const result=await response.json();if(!response.ok)break;job=result.job;
    }
    if(!alive())return;
    if(job.state==='done'){activeProxyJobs.delete(assetId);}
    else if(['failed','canceled'].includes(job.state))activeProxyJobs.set(assetId,{id:job.id,action:'retry'});
    if(job.state==='done'&&asset()){
      const result=job.result;
      await hooks.edit(()=>{asset().proxy={path:result.path,bytes:result.bytes,width:result.width};});
      hooks.status('وُلّد proxy بعرض '+result.width+'px ('+formatBytes(result.bytes)+'). المعاينة المخفّضة تستخدمه والتصدير يبقى بالأصل.');
    }else if(job.state==='failed')hooks.status('فشل proxy: '+job.message);
  }catch(error){activeProxyJobs.delete(assetId);if(alive())hooks.status(error.message);}
}
function applyLibraryFilter(container){
  const search=libraryState.search.trim().toLowerCase();
  let visible=0;
  for(const group of container.querySelectorAll('[data-asset-group]')){
    const groupName=group.dataset.assetGroup;
    let groupVisible=0;
    for(const card of group.querySelectorAll('.tl-asset')){
      const match=(!libraryState.kind||card.dataset.kind===libraryState.kind)&&(!libraryState.folder||groupName===libraryState.folder)&&(!search||card.dataset.search.includes(search));
      card.hidden=!match;if(match){groupVisible++;visible++;}
    }
    group.hidden=!groupVisible;
  }
  const counter=container.querySelector('[data-asset-count]');
  if(counter)counter.textContent=visible+' / '+container.querySelectorAll('.tl-asset').length;
}
/** Library with folders, tags, search, kind filter, probe metadata, per-asset proxy and inline organization editing. */
export function renderLibrary(container,project,hooks){
  if(!wired.has(container)){wired.add(container);
    container.addEventListener('input',e=>{if(e.target.hasAttribute('data-asset-search')){libraryState.search=e.target.value;applyLibraryFilter(container);}});
    container.addEventListener('change',e=>{if(e.target.hasAttribute('data-asset-kind'))libraryState.kind=e.target.value;if(e.target.hasAttribute('data-asset-folder'))libraryState.folder=e.target.value;if(e.target.hasAttribute('data-asset-folder')||e.target.hasAttribute('data-asset-kind'))applyLibraryFilter(container);if(e.target.hasAttribute('data-edit-folder'))e.target.closest('[data-asset-form]')?.querySelector('[data-edit-folder-new]')?.toggleAttribute('hidden',e.target.value!=='__new__');});
    container.addEventListener('click',async e=>{
      const b=e.target.closest('button');if(!b||b.disabled||!hooks)return;
      const current=()=>hooks.getProject();
      if(b.dataset.assetProxy){
        const asset=hooks.getProject().assets.find(a=>a.id===b.dataset.assetProxy);
        if(!asset||asset.kind!=='video'){hooks.status('يُنشأ proxy لملفات الفيديو فقط.');return;}
        void proxyJobFlow(hooks,b.dataset.assetProxy,b);
        return;
      }
      if(b.dataset.assetEdit){const form=container.querySelector('[data-asset-form="'+b.dataset.assetEdit+'"]');if(form)form.hidden=!form.hidden;return;}
      if(b.hasAttribute('data-asset-edit-cancel')){const form=b.closest('[data-asset-form]');if(form)form.hidden=true;return;}
      if(b.hasAttribute('data-asset-edit-save')){
        const form=b.closest('[data-asset-form]'),id=form.dataset.assetForm;
        try{
          let folder=form.querySelector('[data-edit-folder]').value;
          if(folder==='__new__')folder=form.querySelector('[data-edit-folder-new]').value.trim();
          if(folder&&(folder.length>60||/[\u0000-\u001f]/.test(folder)))throw Error('اسم المجلد غير صالح (60 حرفًا كحد أقصى).');
          const tags=parseTags(form.querySelector('[data-edit-tags]').value);
          const field=(name,max)=>{const value=form.querySelector('[data-edit-source-'+name+']').value.trim();if(value.length>max)throw Error('قيمة المصدر أطول من الحد.');return value;};
          const url=field('url',500),author=field('author',100),license=field('license',100),notes=field('notes',300);
          if(url&&!/^https?:\/\/.{3,497}$/.test(url))throw Error('رابط المصدر يجب أن يبدأ بـ http:// أو https://');
          await hooks.edit(()=>{
            const a=current().assets.find(x=>x.id===id);if(!a)throw Error('الأصل لم يعد موجودًا.');
            if(folder)a.folder=folder;else delete a.folder;
            if(tags.length)a.tags=tags;else delete a.tags;
            if(url||author||license||notes){const s={};if(url)s.url=url;if(author)s.author=author;if(license)s.license=license;if(notes)s.notes=notes;a.source=s;}else delete a.source;
          });
          form.hidden=true;hooks.status('حُدّثت بيانات الأصل: المجلد والوسوم والمصدر والترخيص.');
        }catch(error){hooks.status(error.message);}
        return;
      }
    });
  }
  const counts=new Map();for(const c of project.clips)if(c.assetId)counts.set(c.assetId,(counts.get(c.assetId)||0)+1);
  const folders=[...new Set(project.assets.map(a=>a.folder).filter(Boolean))].sort();
  const toolbar=document.createElement('div');toolbar.className='tl-library-tools';
  toolbar.innerHTML='<input data-asset-search type="search" placeholder="بحث بالاسم أو الوسم…" value="'+esc(libraryState.search)+'" aria-label="بحث في مكتبة الأصول"><select data-asset-kind aria-label="فلترة النوع"><option value="">كل الأنواع</option>'+Object.entries(kindLabels).map(([k,label])=>'<option value="'+k+'" '+(libraryState.kind===k?'selected':'')+'>'+label+'</option>').join('')+'</select><select data-asset-folder aria-label="فلترة المجلد"><option value="">كل المجلدات</option>'+folders.map(f=>'<option value="'+esc(f)+'" '+(libraryState.folder===f?'selected':'')+'>'+esc(f)+'</option>').join('')+'</select><output data-asset-count></output>';
  const groups=[...folders,''];
  const card=asset=>{
    const entry=document.createElement('div');entry.className='tl-asset';entry.dataset.asset=asset.id;entry.dataset.kind=asset.kind;entry.dataset.search=(asset.name+' '+(asset.tags||[]).join(' ')+' '+(asset.folder||'')).toLowerCase();
    const button=document.createElement('button');button.dataset.tlAsset=asset.id;button.title='إضافة نسخة عند مؤشر الخط الزمني';
    const thumb=document.createElement('img');thumb.dataset.thumb=asset.id;thumb.alt='';thumb.src=FALLBACK;
    const label=document.createElement('span');label.textContent=asset.name;
    const meta=document.createElement('small');const used=counts.get(asset.id)||0;
    meta.textContent=(kindLabels[asset.kind]||asset.kind)+' · '+(asset.kind==='image'?'صورة ثابتة':asset.duration.toFixed(1)+' ث')+(asset.bytes?' · '+formatBytes(asset.bytes):'')+metaText(asset)+' · '+(used?used+(used===1?' مقطع':' مقاطع'):'غير مستخدم');
    button.append(thumb,label,meta);
    const actions=document.createElement('div');actions.className='tl-asset-actions';
    const replace=document.createElement('button');replace.dataset.assetReplace=asset.id;replace.title='استبدال ملف الأصل مع الحفاظ على مواضع مقاطعه وتعديلاته';replace.textContent='استبدال';
    actions.append(replace);
    const edit=document.createElement('button');edit.dataset.assetEdit=asset.id;edit.title='تعديل المجلد والوسوم';edit.textContent='تحرير';actions.append(edit);
    if(asset.kind==='video'){const proxy=document.createElement('button');proxy.dataset.assetProxy=asset.id;const active=activeProxyJobs.get(asset.id);if(active){proxy.dataset.jobId=active.id;proxy.dataset.jobAction=active.action;proxy.textContent=active.action==='cancel'?'جارٍ التوليد…':'إعادة المحاولة';}else proxy.textContent=asset.proxy?'إعادة Proxy ('+formatBytes(asset.proxy.bytes)+')':'إنشاء Proxy';proxy.title='نسخة معاينة مصغرة يوفّرها المحرك عند تقليل جودة المعاينة؛ التصدير يستخدم الأصل';actions.append(proxy);}
    entry.append(button,actions);
    const form=document.createElement('form');form.dataset.assetForm=asset.id;form.className='tl-asset-form';form.hidden=true;
    const source=asset.source||{};
    form.innerHTML='<label>المجلد<select data-edit-folder><option value="">بدون مجلد</option>'+folders.map(f=>'<option value="'+esc(f)+'" '+(asset.folder===f?'selected':'')+'>'+esc(f)+'</option>').join('')+'<option value="__new__">مجلد جديد…</option></select></label><input data-edit-folder-new placeholder="اسم المجلد الجديد" hidden><label>الوسوم<input data-edit-tags value="'+esc((asset.tags||[]).join('، '))+'" placeholder="وسوم مفصولة بفواصل"></label><label>رابط المصدر<input data-edit-source-url value="'+esc(source.url||'')+'" placeholder="https://…"></label><label>صاحب العمل<input data-edit-source-author value="'+esc(source.author||'')+'"></label><label>الترخيص<input data-edit-source-license value="'+esc(source.license||'')+'" placeholder="مثال: CC-BY-4.0"></label><label>ملاحظات المصدر<input data-edit-source-notes value="'+esc(source.notes||'')+'"></label><button type="button" data-asset-edit-save>حفظ</button><button type="button" data-asset-edit-cancel>إلغاء</button>';
    entry.append(form);
    if(asset.tags?.length){const tags=document.createElement('div');tags.className='tl-asset-tags';for(const tag of asset.tags){const chip=document.createElement('span');chip.textContent=tag;tags.append(chip);}if(asset.folder){const chip=document.createElement('span');chip.className='tl-asset-folder';chip.textContent='📁 '+asset.folder;tags.prepend(chip);}entry.append(tags);}
    else if(asset.folder){const tags=document.createElement('div');tags.className='tl-asset-tags';const chip=document.createElement('span');chip.className='tl-asset-folder';chip.textContent='📁 '+asset.folder;tags.append(chip);entry.append(tags);}
    return entry;
  };
  const list=document.createElement('div');list.className='tl-library-list';
  for(const folder of groups){
    const assets=project.assets.filter(a=>(a.folder||'')===folder);if(!assets.length)continue;
    const group=document.createElement('div');group.dataset.assetGroup=folder;
    const head=document.createElement('h4');head.textContent=folder||'بدون مجلد';group.append(head);
    for(const asset of assets)group.append(card(asset));
    list.append(group);
  }
  container.replaceChildren(toolbar,list);
  applyLibraryFilter(container);
  void (async()=>{for(const asset of project.assets){const img=container.querySelector('img[data-thumb="'+asset.id+'"]');if(!img)continue;try{img.src=await thumbnailFor(asset,project.taskId);}catch{/* placeholder remains */}}})();
  return container;
}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
/** Asset integrity panel: missing-file relink, unused cleanup, duplicate detection and portable ZIP packages. */
export function installAssetTools({host,getProject,identity,edit,run,status,prepare,onImportedProject}){
  let pendingAsset=null,lastStatus=null;
  const report=host.querySelector('[data-tl-asset-report]'),fileInput=host.querySelector('[data-tl-asset-file]');
  function renderReport(){
    if(!lastStatus)return;
    const byId=id=>lastStatus.assets.find(a=>a.id===id);
    const missing=lastStatus.missing.map(byId).filter(Boolean);
    const unused=lastStatus.unused.map(byId).filter(Boolean);
    report.replaceChildren();
    const summary=document.createElement('p');summary.dataset.assetSummary='';
    summary.textContent='الأصول: '+lastStatus.assets.length+' · الحجم على القرص: '+formatBytes(lastStatus.totalBytes)+' · مفقود: '+missing.length+' · غير مستخدم: '+unused.length;
    report.append(summary);
    for(const asset of missing){
      const row=document.createElement('div');row.className='tl-asset-issue';row.dataset.issue='missing';
      const title=document.createElement('strong');title.textContent=asset.name+' ('+(kindLabels[asset.kind]||asset.kind)+')';
      const note=document.createElement('span');note.textContent='الملف غير موجود في ملفات المهمة';
      const button=document.createElement('button');button.dataset.assetRelink=asset.id;button.textContent='إعادة ربط بملف';
      row.append(title,note,button);report.append(row);
    }
    for(const group of lastStatus.duplicates){
      const names=group.map(byId).filter(Boolean).map(a=>a.name);
      if(names.length<2)continue;
      const row=document.createElement('div');row.className='tl-asset-issue';row.dataset.issue='duplicate';
      const title=document.createElement('strong');title.textContent='محتوى مكرر';
      const note=document.createElement('span');note.textContent=names.join(' ≡ ')+' — الملفات متطابقة المحتوى؛ احذف المقاطع الزائدة ثم نظّف غير المستخدم.';
      row.append(title,note);report.append(row);
    }
    if(unused.length){
      const row=document.createElement('div');row.className='tl-asset-issue';row.dataset.issue='unused';
      const title=document.createElement('strong');title.textContent='غير مستخدم: '+unused.map(a=>a.name).join('، ');
      const button=document.createElement('button');button.dataset.tlUnusedDelete='';button.textContent='حذف الأصول غير المستخدمة من المشروع';
      row.append(title,button);report.append(row);
    }
  }
  async function checkAssets(){
    const taskId=await identity();
    const response=await fetch('/api/timeline/assets-status?taskId='+encodeURIComponent(taskId),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(getProject())});
    const result=await response.json();
    if(!response.ok)throw Error(result.error||'تعذّر فحص الأصول.');
    lastStatus=result;renderReport();
    status(result.missing.length?'يوجد '+result.missing.length+' أصل مفقود — أعد ربطه بملف موجود.':'الأصول سليمة: '+result.assets.length+' أصلًا · '+formatBytes(result.totalBytes)+'.');
  }
  async function downloadPackage(){
    await prepare();
    const taskId=await identity();
    const response=await fetch('/api/timeline/package?taskId='+encodeURIComponent(taskId),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(getProject())});
    const result=await response.json();
    if(!response.ok)throw Error(result.error||'تعذّر إنشاء الحزمة.');
    const media=await fetch('/api/media?taskId='+encodeURIComponent(taskId)+'&path='+encodeURIComponent(result.path));
    if(!media.ok)throw Error('تعذّر تنزيل الحزمة.');
    downloadBlob(await media.blob(),'loam-timeline-package.zip');
    status('نُزّلت حزمة محمولة تضم المشروع و'+result.assets+' أصلًا ('+formatBytes(result.bytes)+').');
  }
  async function importPackageFile(file){
    const taskId=await identity();
    const response=await fetch('/api/timeline/package-import?taskId='+encodeURIComponent(taskId),{method:'POST',headers:{'content-type':'application/zip'},body:file});
    const result=await response.json();
    if(!response.ok)throw Error(result.error||'تعذّر استيراد الحزمة.');
    const project=validateTimeline(result.project);
    await onImportedProject(project);
    status('استُوردت حزمة المشروع وأُعيد تخزين '+result.assets+' أصلًا في هذه المهمة.');
  }
  async function applyReplacement(file){
    if(!pendingAsset)return;
    const assetId=pendingAsset;pendingAsset=null;
    const asset=getProject().assets.find(a=>a.id===assetId);
    if(!asset)throw Error('الأصل لم يعد موجودًا في المشروع.');
    const probe=await probeMedia(file);
    if(probe.kind!==asset.kind)throw Error('نوع الملف الجديد ('+(kindLabels[probe.kind]||probe.kind)+') لا يطابق نوع الأصل ('+(kindLabels[asset.kind]||asset.kind)+').');
    const stored=await uploadAsset(file,await identity());
    await edit(()=>relinkAsset(getProject(),assetId,{path:stored.path,bytes:stored.bytes,duration:probe.duration}));
    status('استُبدل ملف الأصل «'+asset.name+'» مع الحفاظ على مواضع مقاطعه وتعديلاتها.');
    await checkAssets();
  }
  host.querySelector('[data-tl-asset-check]').onclick=()=>void run(checkAssets);
  const storageButton=host.querySelector('[data-tl-storage]'),storagePanel=host.querySelector('[data-tl-storage-panel]');
  async function refreshStorage(){
    const taskId=await identity();
    const response=await fetch('/api/timeline/storage?taskId='+encodeURIComponent(taskId));
    const result=await response.json();
    if(!response.ok)throw Error(result.error||'تعذّر قراءة حالة المساحة.');
    const free=result.freeDisk==null?'غير معروفة على هذا النظام':formatBytes(result.freeDisk);
    const row=(label,data,what,hint)=>'<div class="tl-asset-issue"><strong>'+label+': '+data.count+' ملفًا · '+formatBytes(data.bytes)+'</strong><span>'+hint+'</span><button data-tl-cleanup="'+what+'">تنظيف</button></div>';
    storagePanel.innerHTML='<p>المساحة الحرة على القرص: '+free+' · الأصول الأصلية: '+result.assets.count+' ملفًا ('+formatBytes(result.assets.bytes)+')</p>'
      +row('صور وموجات المصغرات المخزنة',result.thumbCache,'thumbs','مشتقات قابلة لإعادة التوليد عند الحاجة')
      +row('ملفات عمليات التصدير المؤقتة',result.jobTemp,'jobParts','أجزاء الرندر وملفات الصوت المؤقتة للعمليات المنتهية؛ النتائج المحفوظة لا تُمس')
      +row('ملفات وسائط يتيمة',result.orphans,'orphans','ملفات غير مُشار إليها بأي مشروع محفوظ أو عملية نشطة؛ تُحذف بعد حماية أصول المشروع الحالي');
    status('المساحة الحرة: '+free+' · مؤقتات: '+formatBytes(result.thumbCache.bytes+result.jobTemp.bytes)+'.');
  }
  if(storageButton){
    storageButton.onclick=()=>void run(refreshStorage);
    storagePanel.addEventListener('click',e=>{
      const b=e.target.closest('button[data-tl-cleanup]');if(!b||b.disabled)return;
      const what=b.dataset.tlCleanup;
      void run(async()=>{
        const project=getProject(),protect=project.assets.flatMap(a=>[a.path,...(a.proxy?[a.proxy.path]:[])]);
        const response=await fetch('/api/timeline/cleanup?taskId='+encodeURIComponent(await identity()),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({protect,thumbs:what==='thumbs',jobParts:what==='jobParts',orphans:what==='orphans'})});
        const result=await response.json();
        if(!response.ok)throw Error(result.error||'تعذّر التنظيف.');
        const field={thumbs:['thumbs','thumbsBytes','مصغرة'],jobParts:['jobParts','jobPartsBytes','ملف عمليات'],orphans:['orphans','orphansBytes','ملف يتيم']}[what];
        status('حُذف '+result[field[0]]+' '+field[2]+' ('+formatBytes(result[field[1]])+'). الأصول المستخدمة محفوظة.');
        await refreshStorage();
      });
    });
  }
  host.querySelector('[data-tl-package]').onclick=()=>void run(downloadPackage);
  host.querySelector('[data-tl-package-open]').onclick=()=>host.querySelector('[data-tl-package-file]').click();
  host.querySelector('[data-tl-package-file]').onchange=e=>{const file=e.target.files[0];e.target.value='';if(file)void run(()=>importPackageFile(file));};
  fileInput.onchange=e=>{const file=e.target.files[0];e.target.value='';if(file)void run(()=>applyReplacement(file));};
  host.addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b||b.disabled)return;
    const target=b.dataset.assetRelink||b.dataset.assetReplace;
    if(target){pendingAsset=target;fileInput.click();return;}
    if(b.hasAttribute('data-tl-unused-delete')&&lastStatus){const doomed=lastStatus.unused;void run(async()=>{let removed=0;await edit(()=>{removed=removeAssets(getProject(),doomed);});status('أُزيل '+removed+' أصلًا غير مستخدم من وصف المشروع؛ الملفات تبقى في مساحة المهمة.');await checkAssets();});}
  });
}
/** Preview files before adding them: metadata, folder, tags and source range selection (in/out) per file. */
export async function openImportDialog({files,identity,getProject,apply,status}){
  const dialog=document.createElement('dialog');dialog.className='creative-import-dialog';
  dialog.innerHTML='<header><div><small>LOAM / IMPORT</small><h2>معاينة الأصول قبل إضافتها</h2></div><button data-import-cancel>إلغاء</button></header><div data-import-rows></div><div class="tl-toolbar"><button data-import-apply disabled>جارٍ فحص الملفات…</button><span data-import-note role="status"></span></div><p class="creative-help">حدّد جزء الفيديو أو الصوت (من/إلى بالثواني) لإضافة المقطع ضمنه فقط. المجلد والوسوم يُحفظان مع المشروع.</p>';
  document.body.append(dialog);dialog.showModal();
  const rows=dialog.querySelector('[data-import-rows]'),applyButton=dialog.querySelector('[data-import-apply]'),note=dialog.querySelector('[data-import-note]');
  const close=result=>{dialog.close();dialog.remove();return result;};
  dialog.querySelector('[data-import-cancel]').onclick=()=>close(false);
  dialog.addEventListener('cancel',e=>{e.preventDefault();close(false);});
  const taskId=await identity();
  const folders=()=>[...new Set(getProject().assets.map(a=>a.folder).filter(Boolean))];
  const entries=[];
  for(const file of files){
    const entry={file,asset:null,range:null,error:null,row:document.createElement('div')};
    entry.row.className='tl-import-row';entries.push(entry);rows.append(entry.row);
    const state=text=>{entry.row.querySelector('[data-import-state]').textContent=text;};
    try{
      entry.row.innerHTML='<strong>'+esc(file.name)+'</strong><small data-import-state>فحص الملف…</small><div data-import-body></div>';
      const probe=await probeMedia(file);
      state('رفع…');
      const stored=await uploadAsset(file,taskId,p=>state('رفع '+Math.round(p*100)+'%'));
      let meta;
      try{
        const response=await fetch('/api/timeline/probe?taskId='+encodeURIComponent(taskId),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:stored.path})});
        const result=await response.json();if(!response.ok)throw Error(result.error);meta=response.ok?result:{};
      }catch{meta={};}
      const clean={};
      for(const key of ['width','height','duration','container','videoCodec','audioCodec','sampleRate'])if(typeof meta[key]==='number'||typeof meta[key]==='string')clean[key]=meta[key];
      for(const key of ['hasAudio','transparent'])if(typeof meta[key]==='boolean')clean[key]=meta[key];
      const duration=probe.kind==='image'?0:(typeof meta.duration==='number'&&meta.duration>0?meta.duration:probe.duration);
      entry.asset={id:uid(),name:file.name.slice(0,200),kind:probe.kind,duration,path:stored.path,bytes:stored.bytes,...(Object.keys(clean).length?{meta:clean}:{})};
      const media='/api/media?taskId='+encodeURIComponent(taskId)+'&path='+encodeURIComponent(stored.path);
      const facts=[clean.width&&clean.height?clean.width+'×'+clean.height:'',clean.videoCodec,clean.audioCodec,clean.hasAudio===false?'بلا صوت':'',clean.transparent?'شفاف':''].filter(Boolean).join(' · ');
      const body=entry.row.querySelector('[data-import-body]');
      const preview=probe.kind==='image'?'<img src="'+media+'" alt="معاينة" loading="lazy">':probe.kind==='video'?'<video controls preload="metadata" src="'+media+'"></video>':'<audio controls preload="metadata" src="'+media+'"></audio>';
      const range=['video','audio'].includes(probe.kind)?'<label>من ث<input data-import-in type="number" min="0" max="'+duration.toFixed(3)+'" step="0.05" value="0"></label><label>إلى ث<input data-import-out type="number" min="0" max="'+duration.toFixed(3)+'" step="0.05" value="'+duration.toFixed(2)+'"></label><output data-import-length>المدة الكاملة</output>':'';
      body.innerHTML=preview+'<div class="tl-import-fields"><span class="creative-help">'+esc(facts)+'</span>'+range+'<label>المجلد<select data-import-folder><option value="">بدون مجلد</option>'+folders().map(f=>'<option value="'+esc(f)+'">'+esc(f)+'</option>').join('')+'<option value="__new__">مجلد جديد…</option></select></label><input data-import-folder-new placeholder="اسم المجلد الجديد" hidden><label>الوسوم<input data-import-tags placeholder="وسوم مفصولة بفواصل"></label></div>';
      const updateLength=()=>{const inV=Number(body.querySelector('[data-import-in]').value),outV=Number(body.querySelector('[data-import-out]').value),out=body.querySelector('[data-import-length]');out.textContent=Number.isFinite(inV)&&Number.isFinite(outV)&&outV>inV?('المقطع: '+(outV-inV).toFixed(2)+' ث'):'مدى غير صالح';};
      body.addEventListener('input',e=>{if(e.target.hasAttribute('data-import-in')||e.target.hasAttribute('data-import-out'))updateLength();});
      body.addEventListener('change',e=>{if(e.target.hasAttribute('data-import-folder'))body.querySelector('[data-import-folder-new]').toggleAttribute('hidden',e.target.value!=='__new__');});
      state('');
    }catch(error){entry.error=error.message;entry.row.classList.add('tl-import-error');state(error.message);}
  }
  const ready=entries.filter(e=>!e.error).length;
  if(!ready){applyButton.textContent='لا ملفات صالحة';note.textContent='فشل فحص جميع الملفات المختارة.';return;}
  applyButton.disabled=false;applyButton.textContent='إضافة '+ready+' إلى الخط الزمني';
  applyButton.onclick=async()=>{
    const included=[];
    for(const entry of entries){
      if(entry.error)continue;
      try{
        let folder=entry.row.querySelector('[data-import-folder]').value;
        if(folder==='__new__')folder=entry.row.querySelector('[data-import-folder-new]').value.trim();
        if(folder&&(folder.length>60||/[\u0000-\u001f]/.test(folder)))throw Error('اسم المجلد غير صالح: '+entry.asset.name);
        const tags=parseTags(entry.row.querySelector('[data-import-tags]').value);
        let range=null;
        if(['video','audio'].includes(entry.asset.kind)){
          const inV=Number(entry.row.querySelector('[data-import-in]').value),outV=Number(entry.row.querySelector('[data-import-out]').value);
          if(!(Number.isFinite(inV)&&Number.isFinite(outV))||inV<0||outV>entry.asset.duration+.08||outV-inV<1/60)throw Error('مدى التحديد غير صالح: '+entry.asset.name);
          range={in:Math.max(0,inV),duration:outV-inV};
        }
        const asset={...entry.asset};
        if(folder)asset.folder=folder;
        if(tags.length)asset.tags=tags;
        included.push({asset,range});
      }catch(error){note.textContent=error.message;return;}
    }
    if(!included.length){note.textContent='لا ملفات مضمنة.';return;}
    applyButton.disabled=true;applyButton.textContent='جارٍ الإضافة…';
    try{await apply(included);close(true);}
    catch(error){applyButton.disabled=false;applyButton.textContent='إضافة '+included.length+' إلى الخط الزمني';note.textContent=error.message;}
  };
}
