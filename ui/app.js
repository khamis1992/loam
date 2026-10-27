import { icon } from './icons.js';
import { createNavigation } from './navigation.js';
import { mountAppUpdates } from './app-updates.js';
import { createCreativeStudio } from './creative.js';
import { createStudio } from './studio.js';
import { mountTaskView } from './task-view.js';
import { mountLivePreview } from './live-preview.js';
import { renderMarkdown } from './markdown.js';
import { studios, studioById, installStudioBridge } from './studio-routes.js';
// Per-bot chat accent color (C20): a task owned by a companion tints the chat.
import { chatAccentFor, accentVars } from './chat-color.js';
const $ = id => document.getElementById(id);
const updateNavigation=createNavigation();
mountAppUpdates({confirm:confirmAction});
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {queued:'في الانتظار',running:'جارٍ التنفيذ',done:'مكتملة',error:'تعثّرت',interrupted:'انقطع التشغيل',cancelled:'متوقفة'};
const state = {modes:[],tasks:[],task:null,mode:null,draft:null,attachments:[],sequence:0,stream:null,posting:new Set(),launching:false,uploading:false,projectId:null};
let livePreview=null;
const busy = task => ['queued','running'].includes(task?.status);
const modeById = id => state.modes.find(m=>m.id===id);
const date = value => value ? new Date(value).toLocaleDateString('ar',{month:'short',day:'numeric'}) : '';
async function api(path, options={}) {
  const controller = new AbortController(); const timer=setTimeout(()=>controller.abort(),20000);
  try { const response=await fetch(path,{...options,signal:options.signal || controller.signal}); const data=await response.json(); if(!response.ok) throw new Error(data.error || `تعذّر الاتصال (${response.status})`); return data; }
  finally {clearTimeout(timer);}
}
const post=(path,body)=>api(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
function notice(message,error=false) { $('notice').hidden=!message; $('notice').textContent=message; $('notice').classList.toggle('err-text',error); }
function run(action) { return (...args)=>{ try { return Promise.resolve(action(...args)).catch(error=>notice(error.message,true)); } catch(error) { notice(error.message,true); } }; }
function show(view,title) { updateNavigation(title); const creative=(view==='mode' && state.mode?.id==='media') || (view==='chat' && state.task?.mode==='media');document.body.classList.toggle('creative-workspace',creative);if(!creative)creativeStudio.unmount(); const office=(view==='mode' && ['write','data'].includes(state.mode?.id)) || (view==='chat' && ['write','data'].includes(state.task?.mode));document.body.classList.toggle('office-workspace',office);if(!office)officeStudio.unmount(); document.body.classList.toggle('build-studio',(view==='mode' && state.mode?.id==='build') || (view==='chat' && state.task?.mode==='build')); document.querySelectorAll('.view').forEach(el=>el.classList.toggle('active',el.id===`view-${view}`)); $('crumb').textContent=title; document.title=`${title} — Loam`; $('sidebar').classList.remove('open'); $('menuToggle').setAttribute('aria-expanded','false'); }
function confirmAction(title,text) { const dialog=$('confirmDialog'); $('confirmTitle').textContent=title; $('confirmText').textContent=text; dialog.returnValue='cancel'; dialog.showModal(); return new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true})); }
function resetWorkspace() { $('filesList').replaceChildren(); $('fileView').replaceChildren(); $('fileView').hidden=true; $('previewFrame').src='about:blank'; $('previewFrame').hidden=true; livePreview?.destroy(); livePreview=null; $('liveView').hidden=true; document.querySelector('.sidepanel').hidden=true; $('taskWorkspace').setAttribute('aria-expanded','false'); }
function stopStream() { state.stream?.close(); state.stream=null; }
const officeStudio=createStudio({ensureDraft,draftFactory:()=>{const context={sequence:state.sequence,mode:state.mode,projectId:state.projectId};return()=>ensureDraft(context);},confirm:confirmAction});
const creativeStudio=createCreativeStudio({ensureDraft,draftFactory:()=>{const context={sequence:state.sequence,mode:state.mode,projectId:state.projectId};return()=>ensureDraft(context);},confirm:confirmAction});
const taskView=mountTaskView({markdown:renderMarkdown,stop:run(stopTask),followup:()=>$('promptChat').focus(),openFile:run(openFile)});
$('view-chat').insertAdjacentHTML('beforeend', `<section id="buildStage" class="build-stage" aria-label="معاينة التطبيق" hidden><div class="build-preview-toolbar"><button id="buildPreview" class="build-preview-label" type="button"><loam-icon name="eye"></loam-icon> المعاينة</button><button id="buildFiles" class="btn" type="button"><loam-icon name="file"></loam-icon> الملفات</button><span id="buildAddress" class="build-address" dir="ltr">/</span><button id="buildReload" class="icon" type="button" aria-label="تحديث المعاينة"><loam-icon name="refresh"></loam-icon></button><button id="buildSize" class="icon" type="button" aria-label="معاينة بحجم الهاتف" aria-pressed="false"><loam-icon name="mobile"></loam-icon></button></div><div class="build-canvas"><div id="buildEmpty" class="build-placeholder"><span class="build-mark" aria-hidden="true"><loam-icon name="build"></loam-icon></span><h2>مساحة تطبيقك</h2><p id="buildPreviewStatus" role="status">شغّل المعاينة لمشاهدة التطبيق هنا.</p><button id="buildStartPreview" class="primary" type="button">تشغيل المعاينة</button></div><iframe id="buildFrame" title="معاينة التطبيق الجاري تطويره" sandbox="allow-scripts allow-forms" hidden></iframe></div></section>`);
let buildPreviewTask=null;
async function refreshBuildPreview(start=false) {
  const id=state.task?.id;if(state.task?.mode!=='build')return;
  const seq=state.sequence;
  $('buildPreviewStatus').textContent='جارٍ التحقق من المعاينة…';
  try {
    let data=await api('/api/preview?'+taskQuery(id));
    if(id!==state.task?.id || seq!==state.sequence)return;
    if(!data.running && start)data=await post('/api/preview',{taskId:id,dir:'.'});
    if(id!==state.task?.id || seq!==state.sequence)return;
    if(!data.url){$('buildPreviewStatus').textContent='المعاينة غير مشغّلة. يمكنك تشغيلها بعد إنشاء ملفات التطبيق.';return;}
    if(!/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(data.url||''))throw new Error('عنوان المعاينة غير صالح.');
    $('buildFrame').src=data.url;$('buildFrame').hidden=false;$('buildEmpty').hidden=true;$('buildAddress').textContent=data.url;
  } catch(error) {if(id===state.task?.id && seq===state.sequence)$('buildPreviewStatus').textContent='تعذّر فتح المعاينة. حاول تشغيلها مجددًا. '+error.message;}
}
$('buildPreview').onclick=$('buildStartPreview').onclick=()=>refreshBuildPreview(true);
$('buildReload').onclick=()=>refreshBuildPreview(true);
$('buildFiles').onclick=()=>{if(document.querySelector('.sidepanel').hidden)$('taskWorkspace').click();};
$('buildSize').onclick=()=>{const narrow=$('buildStage').classList.toggle('phone-preview');$('buildSize').setAttribute('aria-pressed',String(narrow));};
function renderTaskState() {
  const task=state.task; if(!task)return;
  $('buildStage').hidden=task.mode!=='build';
  if(task.mode==='media'){creativeStudio.adopt(task.id);creativeStudio.mount($('view-chat'),{mode:task.mode,taskId:task.id,key:'task:'+task.id});}
  if(['write','data'].includes(task.mode)){officeStudio.adopt(task.id);officeStudio.mount($('view-chat'),{mode:task.mode,taskId:task.id,key:'task:'+task.id});}
  if(task.mode==='build' && buildPreviewTask!==task.id){buildPreviewTask=task.id;$('buildFrame').src='about:blank';$('buildFrame').hidden=true;$('buildEmpty').hidden=false;$('buildAddress').textContent='/';$('activityTab').click();void refreshBuildPreview();}
  $('chatTitle').textContent=task.title || 'مهمة جديدة'; $('chatMode').textContent=modeById(task.mode)?.label || 'Loam';
  $('chatMeta').textContent=`مساحة مستقلة · ${date(task.createdAt)}`;
  $('chatStatus').textContent=labels[task.status] || task.status; $('chatStatus').className=`pill ${task.status}`;
  $('sendChat').disabled=busy(task)||state.posting.has(task.id)||state.launching||state.uploading; $('stopChat').hidden=!busy(task);
  $('attachChat').disabled=busy(task)||state.uploading;
  $('promptChat').placeholder=busy(task)?'يمكنك كتابة توجيه وإرساله بعد اكتمال التنفيذ…':'أضف توجيهًا إلى هذه المهمة…';
  $('taskIntegrations').hidden=task.mode==='ask'; $('taskIntegrations').href='/integrations.html?taskId='+encodeURIComponent(task.id);
  $('codegraphConsent').hidden=true;
if(task&&(task.mode==='ask'||task.mode==='build')&&!state.codegraphAsked?.has(task.id)){
post('/api/codegraph/project/open',{taskId:task.id}).then(d=>{if(state.task?.id!==task.id)return;$('codegraphConsent').hidden=d.decision!=='ask-consent';}).catch(()=>{});}
$('taskTerminal').hidden=task.mode!=='build'; $('taskTerminal').href='/terminal.html?taskId='+encodeURIComponent(task.id);
  $('taskPreview').hidden=!(modeById(task.mode)?.panels || []).includes('preview');
}
function renderTaskLists() {
  const tasks=state.tasks.filter(t=>t.messageCount!==0 || t.stepCount>0);
  const row=t=>`<a class="task-row" href="#/tasks/${encodeURIComponent(t.id)}"><div><strong>${esc(t.title)}</strong><small>${esc(modeById(t.mode)?.labelAr || 'مهمة')} · ${date(t.updatedAt)}</small></div><span class="pill ${esc(t.status)}">${esc(labels[t.status]||t.status)}</span></a>`;
  $('sideTasks').innerHTML=tasks.filter(t=>t.title.toLowerCase().includes($('sideSearch').value.toLowerCase())).map(t=>`<a class="item" href="#/tasks/${encodeURIComponent(t.id)}" title="${esc(t.title)}"><span class="t">${esc(t.title)}</span><span class="pill ${esc(t.status)}">${esc(labels[t.status]||t.status)}</span></a>`).join('') || '<span class="muted">لا مهام بعد</span>';
  $('recentList').innerHTML=tasks.slice(0,4).map(row).join('') || '<div class="empty">تبدأ رحلتك من إحدى المساحات أعلاه.</div>';
  if(location.hash==='#/tasks') $('listBody').innerHTML=tasks.filter(t=>t.title.toLowerCase().includes($('taskSearch').value.toLowerCase())).map(row).join('')||'<div class="empty">لا توجد مهام مطابقة.</div>';
}
async function refreshTasks() { const data=await api('/api/tasks');state.tasks=data.tasks||[];renderTaskLists(); }
let homeMode='build';let pendingHomePrompt=null;
let preparedStudio=null;
installStudioBridge({frame:$('embedFrame'),navigate:id=>{location.hash='#/studios/'+id;},prepare:(studio,prompt)=>{
  preparedStudio=studio;
  pendingHomePrompt={mode:studio.mode,text:`${studio.title}\n\n${prompt}`};
  location.hash='#/modes/'+studio.mode;
}});
$('homeForm').onsubmit=event=>{event.preventDefault();pendingHomePrompt={mode:homeMode,text:$('homePrompt').value.trim()};if(pendingHomePrompt.text)location.hash='#/modes/'+homeMode;};
$('collapseBtn').onclick=()=>{$('sidebar').classList.add('collapsed');$('sidebar').classList.remove('open');$('menuToggle').setAttribute('aria-expanded','false');$('menuToggle').focus();};
function updateHomeMode(){const mode=modeById(homeMode);if(mode)$('activeModeHero').innerHTML=`<span class="am-icon">${icon(mode.id)}</span><span class="am-text"><b>${esc(mode.labelAr)}</b><small>${esc(mode.tagline)}</small></span>`;}
$('sideSearch').oninput=renderTaskLists;
$('navBack').onclick=()=>history.back();$('navFwd').onclick=()=>history.forward();
$('homeAttach').onclick=()=>{pendingHomePrompt={mode:homeMode,text:$('homePrompt').value.trim()};location.hash='#/modes/'+homeMode;};
$('homePrompt').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('homeForm').requestSubmit();}});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();$('sidebar').classList.remove('collapsed');$('sidebar').classList.add('open');$('menuToggle').setAttribute('aria-expanded','true');$('sideSearch').focus();}});
$('sidebarModel').onchange=run(async()=>{const value=$('sidebarModel').value;await post('/api/settings',{model:value});$('model').value=value;notice('تم حفظ نموذج التنفيذ.');});
function renderModes() {
  $('homeModes').innerHTML=state.modes.map(m=>`<button type="button" class="mchip" data-home-mode="${esc(m.id)}" aria-pressed="${m.id===homeMode}"><span class="mc-ic">${icon(m.id)}</span><span class="mc-t">${esc(m.labelAr)} · ${esc(m.tagline)}</span></button>`).join('');
  $('homeModes').onclick=event=>{const button=event.target.closest('[data-home-mode]');if(!button)return;homeMode=button.dataset.homeMode;document.querySelectorAll('[data-home-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));updateHomeMode();};
  updateHomeMode();
  const buildCard={route:'modes/build',icon:'build',color:'cyan',tag:'LOAM BUILD',title:'هندسة التطبيقات والمشاريع (Loam Build)',description:'ابنِ مشروعك، حرّر الكود واختبره داخل مساحة مستقلة، مع معاينة مباشرة لنتيجة العمل.',foot:'Build · Preview · Test'};
  $('modeCards').innerHTML=[buildCard,...studios.map(s=>({...s,route:'studios/'+s.id}))].map(s=>`<a class="mode-card f-card" href="#/${s.route}"><div class="f-card-head"><span class="f-icon ${s.color}">${icon(s.id||s.icon)}</span><span class="f-tag" dir="ltr">${s.tag}</span></div><h3 class="f-card-title">${s.title}</h3><p class="f-card-desc">${s.description}</p><div class="f-card-foot" dir="ltr">${s.foot}</div></a>`).join('');
}
const workflows={ask:['سؤال واضح','قراءة وفهم','إجابة موثقة'],research:['حدّد السؤال','قارن المصادر','وثّق النتائج'],build:['صف المشروع','ابنِ واختبر','عاين الناتج'],write:['ضع الموجز','حرّر المحتوى','احفظ المستند'],data:['أرفق البيانات','حدّد المقاييس','تحقق من الحسابات'],media:['ارسم الفكرة','حدّد الأسلوب','عاين التصميم'],automate:['حدّد الخطوات','اضبط الحدود','راجع التنفيذ']};
const toolLabels={file_read:'قراءة الملفات',file_list:'استعراض ملفات المهمة',file_search:'بحث داخل الملفات',file_stat:'فحص خصائص الملف',file_extract_text:'استخراج النصوص',file_view_image:'فحص الصور',file_write:'حفظ ملف',file_edit:'تحرير ملف',file_mkdir:'تنظيم المجلدات',file_move:'نقل ملف',file_delete:'حذف ملف',loam_studio:'Loam · الاستوديو المباشر',loam_document:'Loam · محرّر المستندات',loam_dataset:'Loam · تحليل الجداول',loam_canvas:'Loam · لوحة التصميم',shell_run:'تشغيل واختبار المشروع',web_search:'البحث في الويب',web_fetch:'قراءة المصادر',preview_serve:'معاينة المشروع',preview_stop:'إيقاف المعاينة',browser_open:'فتح متصفح',browser_goto:'الانتقال إلى صفحة',browser_snapshot:'قراءة الصفحة',browser_click:'اختيار عنصر',browser_type:'إدخال النص',browser_screenshot:'توثيق الصفحة',browser_close:'إغلاق المتصفح',browser_table:'فحص عناصر الصفحة'};
function toolLabel(name) {return toolLabels[name] || name.replace(/^browser_/,'متصفح · ').replace(/_/g,' ');}
function renderMode(id) {
  const mode=modeById(id); if(!mode)throw new Error('هذه المساحة غير متاحة. اختر مساحة من البداية.');
  state.mode=mode;state.draft=null;state.attachments=[];state.task=null;resetWorkspace();
  show('mode',mode.labelAr);$('modePage').className=`page mode-page mode-${mode.id}`;
  const tools=mode.availableTools || mode.tools || [];
  const fieldHTML=(mode.fields||[]).map((field,index)=>`<div class="form-field ${index?'secondary-field':''}"><label for="field-${esc(field.id)}">${esc(field.label)}</label>${field.multiline?`<textarea id="field-${esc(field.id)}" data-field="${esc(field.label)}" placeholder="${esc(field.placeholder)}" ${index?'':'required'}></textarea>`:`<input id="field-${esc(field.id)}" data-field="${esc(field.label)}" placeholder="${esc(field.placeholder)}" ${index?'':'required'}>`}</div>`).join('');
  const extra=mode.id==='data'?'<p class="source-note">ابدأ بملف CSV. سيبقى داخل مساحة التحليل وحدها، ولن يُضمَّن أي ملف من مهمة أخرى.</p>':mode.id==='research'?'<p class="source-note">اذكر الفترة والمصادر المفضلة. تظهر أدلة البحث في النتيجة وسجل التنفيذ.</p>':mode.id==='media'?'<div class="palette" aria-label="ألوان إلهام من هوية Loam"><i></i><i></i><i></i><i></i></div>':mode.id==='build'?'<p class="source-note">المشروع يبدأ في مجلد مستقل. أرفق الملفات التي تريد البناء عليها صراحةً.</p>':mode.id==='automate'?'<p class="source-note">حدّد الإجراءات الخارجية التي تسمح بها بوضوح قبل بدء التنفيذ.</p>':mode.id==='ask'?'<p class="source-note">أدوات هذا النمط للقراءة فقط. أرفق ما تريد السؤال عنه دون تغيير ملفاتك.</p>':'<p class="source-note">من الموجز إلى مسودة قابلة للتحرير، مع ملف مستقل لكل مهمة.</p>';
  $('modePage').innerHTML=`<div class="mode-heading"><div class="eyebrow">${esc(mode.label)}</div><h1>${esc(mode.tagline)}</h1><p class="lede">${esc(mode.description)}</p></div><div class="workflow-strip">${(workflows[id]||[]).map(s=>`<span>${esc(s)}</span>`).join('')}</div><div class="mode-layout"><form id="modeForm" class="mode-form"><div class="form-card">${extra}${fieldHTML}<div id="modeAttachments" class="attachments"></div><div class="form-footer"><button class="btn" id="modeAttach" type="button"><loam-icon name="plus"></loam-icon> إرفاق ملف</button><button class="primary" id="modeSubmit" type="submit">ابدأ ${esc(mode.labelAr)} ←</button></div></div><div><h3>نقطة بداية</h3><div class="starters">${(mode.starters||[]).map((s,i)=>`<button class="starter" type="button" data-starter="${i}">${esc(s.label)}</button>`).join('')}</div></div></form><aside class="context-card"><div class="eyebrow">أدوات ${esc(mode.labelAr)} فقط</div><h2>ما الذي تتيحه هذه المساحة؟</h2><div class="mode-tools">${tools.map(name=>`<div class="tool-item" data-tool="${esc(name)}"><strong>${esc(toolLabel(name))}</strong><small>متاحة لهذا النمط</small></div>`).join('')||'<p>لا أدوات متصلة حاليًا.</p>'}</div>${mode.unavailableTools?.length?`<p class="muted">${mode.unavailableTools.length} أدوات اختيارية غير متاحة في هذا التشغيل.</p>`:''}<p class="source-note">${esc(mode.outputHint)}</p></aside></div>`;
  if(id==='build') {
    const layout=$('modePage').querySelector('.mode-layout');
    const context=layout.querySelector('.context-card');
    const details=document.createElement('details');details.className='build-tools';details.innerHTML='<summary>الأدوات المتاحة</summary>';context.replaceWith(details);details.append(context);$('modeForm').append(details);
    layout.insertAdjacentHTML('beforeend', '<section class="build-start-stage" aria-label="معاينة التطبيق"><div class="build-preview-toolbar"><span class="build-preview-label"><loam-icon name="eye"></loam-icon> المعاينة</span><span class="build-address" dir="ltr">/</span></div><div class="build-placeholder"><span class="build-mark" aria-hidden="true"><loam-icon name="build"></loam-icon></span><h2>فكرتك، أمامك.</h2><p>صف التطبيق في المحادثة لبدء البناء.<br>ستظهر معاينته هنا عندما يصبح جاهزًا.</p><span class="build-placeholder-note">مساحة معاينة التطبيق</span></div></section>');
  }
  if(id==='media'){const layout=$('modePage').querySelector('.mode-layout'),context=layout.querySelector('.context-card');const details=document.createElement('details');details.className='office-tools';details.innerHTML='<summary>أدوات هذه المساحة</summary>';context.replaceWith(details);details.append(context);$('modeForm').append(details);creativeStudio.mount(layout,{mode:id,key:'mode:'+id+':'+state.sequence});}
  if(['write','data'].includes(id)){const layout=$('modePage').querySelector('.mode-layout'),context=layout.querySelector('.context-card');const details=document.createElement('details');details.className='office-tools';details.innerHTML='<summary>أدوات هذه المساحة</summary>';context.replaceWith(details);details.append(context);$('modeForm').append(details);officeStudio.mount(layout,{mode:id,key:'mode:'+id+':'+state.sequence});}
  $('modeForm').onsubmit=run(async event=>{event.preventDefault(); const fields=[...document.querySelectorAll('#modeForm [data-field]')]; const prompt=fields.map(f=>`${f.dataset.field}: ${f.value.trim()}`).filter((_,i)=>fields[i].value.trim()).join('\n\n');await submitTask(prompt,true);});
  if(pendingHomePrompt?.mode===id){$('modeForm').querySelector('[data-field]').value=pendingHomePrompt.text;pendingHomePrompt=null;$('homePrompt').value='';
    if(preparedStudio){$('modeForm').insertAdjacentHTML('afterbegin',`<div class="studio-task-context"><a href="#/studios/${preparedStudio.id}">← العودة إلى ${esc(preparedStudio.title)}</a><p>راجع الطلب والأدوات المتاحة أدناه، ثم ابدأ المهمة الفعلية. محتوى المعاينة التجريبي لا يُرسل مع طلبك.</p></div>`);preparedStudio=null;}
  }
  $('modeAttach').onclick=()=>pickFiles('mode');
  document.querySelectorAll('[data-starter]').forEach(button=>button.onclick=()=>{const input=$('modeForm').querySelector('[data-field]');input.value=mode.starters[Number(button.dataset.starter)].prompt;input.focus();});
}
let draftCreation=null;
async function ensureDraft(context={sequence:state.sequence,mode:state.mode,projectId:state.projectId}) {
  const seq=context.sequence;
  if(seq===state.sequence&&state.draft)return state.draft;
  if(draftCreation?.sequence===seq)return draftCreation.promise;
  const body={title:context.mode?.labelAr ? context.mode.labelAr+' · مهمة جديدة':'مهمة جديدة',mode:context.mode?.id || 'build',projectId:context.projectId||undefined};
  const promise=post('/api/tasks/draft',body).then(data=>{if(seq===state.sequence)state.draft=data.task;return data.task;});
  draftCreation={sequence:seq,promise};
  try{return await promise;}finally{if(draftCreation?.promise===promise)draftCreation=null;}
}
let uploadContext='mode';
function pickFiles(context){uploadContext=context;$('uploadPicker').click();}
function renderAttachments(){const html=state.attachments.map((a,i)=>`<span class="attachment">${esc(a.name||a.path)}<button type="button" data-remove-attachment="${i}" aria-label="إزالة المرفق من الطلب"><loam-icon name="close"></loam-icon></button></span>`).join('');const target=uploadContext==='mode'?$('modeAttachments'):$('chatAttachments');if(target)target.innerHTML=html;}
$('uploadPicker').onchange=run(async()=>{
  const files=[...$('uploadPicker').files];$('uploadPicker').value='';if(!files.length)return;
  const seq=state.sequence;state.uploading=true;renderTaskState();if($('modeSubmit'))$('modeSubmit').disabled=true;
  try {const task=uploadContext==='chat'?state.task:await ensureDraft();if(!task)throw new Error('افتح مهمة أولًا.');
    for(const file of files){const data=await api(`/api/upload?taskId=${encodeURIComponent(task.id)}&name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'content-type':'application/octet-stream'},body:file});if(seq!==state.sequence)return;state.attachments.push(data);renderAttachments();}
    notice('أُضيفت المرفقات إلى مساحة هذه المهمة.');
  } finally {state.uploading=false;renderTaskState();if($('modeSubmit'))$('modeSubmit').disabled=false;}
});
document.addEventListener('click',event=>{const remove=event.target.closest('[data-remove-attachment]');if(remove){state.attachments.splice(Number(remove.dataset.removeAttachment),1);renderAttachments();}const copy=event.target.closest('.md-copy-btn');if(copy)navigator.clipboard.writeText(copy.dataset.copyCode||'').then(()=>notice('تم نسخ النص.')).catch(()=>notice('تعذّر النسخ.',true));const copyMsg=event.target.closest('[data-copy-message]');if(copyMsg){const body=copyMsg.closest('.log-entry')?.querySelector('.log-body');navigator.clipboard.writeText(body?.textContent??'').then(()=>notice('تم نسخ النص.')).catch(()=>notice('تعذّر النسخ.',true));return;}const retryMsg=event.target.closest('[data-retry-message]');if(retryMsg){void retryLastTurn(retryMsg.dataset.retryMessage,retryMsg);return;}});
async function submitTask(prompt,newTask=false) {
  if(!prompt.trim() || state.launching || state.posting.has(state.task?.id) || state.uploading)return;
  if(!newTask && busy(state.task))throw new Error('انتظر اكتمال المهمة أو أوقفها قبل إرسال التوجيه.');
  state.launching=true;notice('');if($('modeSubmit'))$('modeSubmit').disabled=true;
  let taskId;const seq=state.sequence;
  try {
    const task=newTask?await ensureDraft():state.task;if(seq!==state.sequence)return;if(!task)throw new Error('لم تُحدد المهمة.');taskId=task.id;state.posting.add(taskId);
    const attachments=state.attachments.slice();const mode=newTask?state.mode?.id:task.mode;
    const studioPrompt=['write','data'].includes(mode)?await officeStudio.prepare(prompt,taskId):mode==='media'?await creativeStudio.prepare(prompt,taskId):prompt;if(seq!==state.sequence)return;officeStudio.adopt(taskId);if(mode==='media')creativeStudio.adopt(taskId);
    stopStream();state.task={...task,status:'queued',title:newTask?prompt.split('\n')[0].slice(0,80):task.title,mode};
    state.attachments=[];$('chatAttachments').replaceChildren();resetWorkspace();show('chat',state.task.title);$('timeline').replaceChildren();appendLog({type:'user',text:prompt});taskView.reset({prompt,status:'queued'});$('taskRecovery').replaceChildren();renderTaskState();
    history.replaceState(null,'',`#/tasks/${encodeURIComponent(taskId)}`);
    const response=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:studioPrompt,taskId,mode,title:state.task.title,projectId:(newTask?state.projectId:task.projectId)||undefined,attachments,model:$('model').value||undefined})});
    if(!response.ok || !response.body){let error;try{error=await response.json();}catch{}throw new Error(error?.error||`تعذّر بدء المهمة (${response.status})`);}
    state.launching=false;
    $('promptChat').value='';
    const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
    for(;;){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let index;while((index=buffer.indexOf('\n\n'))>=0){const raw=buffer.slice(0,index);buffer=buffer.slice(index+2);const line=raw.split('\n').find(l=>l.startsWith('data:'));if(!line)continue;let event;try{event=JSON.parse(line.slice(5));}catch{continue;}if(seq===state.sequence && state.task?.id===taskId)receiveEvent(event);}}
  } catch(error){ if(seq===state.sequence){notice(error.message,true);taskView.event({type:'error',message:error.message});} }
  finally {state.launching=false;state.posting.delete(taskId);if(seq===state.sequence && state.task?.id===taskId)await loadTask(taskId,true).catch(error=>notice(error.message,true));await refreshTasks().catch(()=>{});renderTaskState();if($('modeSubmit'))$('modeSubmit').disabled=false;}
}
function appendLog(event) {
  const div=document.createElement(event.type==='tool_call'?'details':'div');div.className=`log-entry ${event.type==='user'?'user':''}`;
  const descriptions={plan:'الخطة',critique:'مراجعة الخطوة',verify:'التحقق النهائي',error:'تنبيه',cancelled:'أُوقفت المهمة',done:'انتهى التنفيذ',revise:'تعديل الخطوة',replan:'تحديث الخطة',mode:'نمط التنفيذ'};
  if(event.type==='user')div.innerHTML=`<div class="log-label">أنت</div><div>${renderMarkdown(event.text)}</div>`;
  else if(event.type==='assistant_message')div.innerHTML=`<div class="log-entry-head"><span class="log-label">Loam</span><span class="log-entry-actions"><button type="button" class="msg-action" data-copy-message title="نسخ النص">نسخ</button><button type="button" class="msg-action" data-retry-message="${encodeURIComponent(state.task?.id||'')}" title="إعادة تشغيل آخر رسالة">إعادة</button></span></div><div class="log-body">${renderMarkdown(event.text)}</div>`;
  else if(event.type==='tool_call')div.innerHTML=`<summary>${esc(toolLabel(event.name))}</summary><pre>${esc(JSON.stringify(event.args||{},null,2))}</pre>`;
  else if(event.type==='tool_result')div.innerHTML=`<div class="log-label">${event.ok?'اكتملت الأداة':'تعذّرت الأداة'} · ${esc(toolLabel(event.name))}</div><details><summary>عرض التفاصيل</summary><pre>${esc(event.summary||'')}</pre></details>`;
  else if(event.type==='plan')div.innerHTML=`<div class="log-label">الخطة</div><ol>${(event.steps||[]).map(s=>`<li>${esc(s.title)}</li>`).join('')}</ol>`;
  else if(descriptions[event.type])div.innerHTML=`<div class="log-label">${descriptions[event.type]}</div><p>${esc(event.reason||event.message||event.labelAr||'')}</p>`;
  else return;
  const log=$('timeline');const nearBottom=log.scrollHeight-log.scrollTop-log.clientHeight<100;log.appendChild(div);if(nearBottom)log.scrollTop=log.scrollHeight;
}
function receiveEvent(event) {
  if(!event)return;
  if(event.type==='step-record')return receiveEvent(event.step?.data);
  taskView.event(event);appendLog(event);
  if(event.type==='task-status')state.task.status=event.status;
  if(event.type==='done')state.task.status='done';if(event.type==='cancelled')state.task.status='cancelled';
  renderTaskState();
}
async function loadTask(id,refresh=false) {
  const seq=state.sequence;const data=await api(`/api/tasks/${encodeURIComponent(id)}`);if(seq!==state.sequence)return;
  state.task=data.task;state.mode=modeById(data.task.mode);if(!refresh){state.attachments=[];resetWorkspace();$('chatAttachments').replaceChildren();}
  if(data.task.agentId && !findChatAgent(data.task.agentId))await loadChatAgents();
  applyChatAccent(data.task.agentId ?? null);
  const showBuildConversation=data.task.mode==='build' && (!refresh || $('activityTab').getAttribute('aria-selected')==='true');
  show('chat',data.task.title);taskView.reset(data.task,data.recovery);renderTaskState();renderRecovery(data.recovery);
  if(showBuildConversation)$('activityTab').click();
  $('timeline').replaceChildren();
  const steps=data.task.steps||[];const hasAnswers=steps.some(s=>s.data?.type==='assistant_message');
  const records=[...(data.task.messages||[]).filter(m=>m.role==='user'||(!hasAnswers&&m.role==='assistant')).map(m=>({at:m.at,data:{type:m.role==='user'?'user':'assistant_message',text:m.content}})),...steps].sort((a,b)=>String(a.at).localeCompare(String(b.at)));
  for(const record of records)appendLog(record.data||{});
  if(data.task.mode==='build')void refreshBuildPreview();
  stopStream();if(busy(data.task)){
    let skip=steps.length;const stream=new EventSource(`/api/tasks/${encodeURIComponent(id)}/stream`);state.stream=stream;
    stream.onmessage=message=>{if(state.task?.id!==id||state.sequence!==seq)return;let event;try{event=JSON.parse(message.data);}catch{return;}if(event.type==='step-record'&&skip>0){skip--;return;}receiveEvent(event);if(['done','cancelled'].includes(event.type)){stream.close();void refreshTasks();void loadTask(id,true);}};
    stream.onerror=()=>{stream.close();if(state.task?.id===id)notice('انقطع البث. نتحقق من الحالة المحفوظة تلقائيًا.');};
  }
  if(!document.querySelector('.sidepanel').hidden)void loadFiles();
}
function renderRecovery(recovery) {
  const box=$('taskRecovery');box.replaceChildren();if(!recovery?.resumable)return;
  const p=document.createElement('p');p.textContent=`تم حفظ ${recovery.completedSteps||0} خطوة. ${recovery.requiresConfirmation?'قد تكون الخطوة المتوقفة أحدثت أثرًا. راجع السجل قبل تكرارها.':'يمكن متابعة المهمة من نقطة الحفظ.'}`;
  const button=document.createElement('button');button.className='primary';button.textContent='استئناف المهمة';button.onclick=run(async()=>{const id=state.task.id;if(recovery.requiresConfirmation && !await confirmAction('استئناف خطوة انقطعت','قد تكون الخطوة نُفّذت جزئيًا. تأكد من أثرها في السجل والملفات قبل إعادة المحاولة.'))return;button.disabled=true;try{await post(`/api/tasks/${encodeURIComponent(id)}/resume`,{retryInterruptedStep:!!recovery.requiresConfirmation});await loadTask(id,true);}finally{button.disabled=false;}});box.append(p,button);
}
async function stopTask(){const id=state.task?.id;if(!id)return;await post(`/api/tasks/${encodeURIComponent(id)}/cancel`,{});notice('أُرسل طلب الإيقاف.');await loadTask(id,true);}
async function retryLastTurn(id,button){if(!id){notice('لا توجد مهمة لإعادة تشغيلها.',true);return;}if(busy(state.task)){notice('انتظر اكتمال المهمة أو أوقفها قبل إعادة التشغيل.',true);return;}button.disabled=true;try{await post(`/api/tasks/${encodeURIComponent(id)}/retry-last`,{});notice('أُعيد تشغيل آخر رسالة.');await loadTask(id,true);}catch(error){notice(error.message,true);}finally{button.disabled=false;}}
function taskQuery(id=state.task?.id){if(!id)throw new Error('اختر مهمة لعرض ملفاتها.');return `taskId=${encodeURIComponent(id)}`;}
// Per-bot chat accent (C20): tint the chat surface for a companion-owned task.
// The companion list is cached for the session so a reload keeps the same color.
// A task with no companion gets no custom properties at all, so the CSS falls
// back to the app accent via var(--chat-accent, var(--accent)).
let chatAgents=[];
let applyChatAccentToken=0;
function findChatAgent(id){return chatAgents.find(a=>a.id===id)||null;}
async function loadChatAgents(){try{const d=await api('/api/agents');chatAgents=d.agents||[];}catch{/* offline: the id hash still colors the chat */}}
function applyChatAccent(agentId){
  const view=$('view-chat');if(!view)return;
  const agent=agentId?findChatAgent(agentId):null;
  const setVars=(vars)=>{
    // `accentVars("")` returns null, which is exactly the "no accent" signal:
    // the vars are dropped and every CSS rule falls back to the app accent.
    view.dataset.chatAccent=vars?'bot':'';
    for(const name of ['--chat-accent','--chat-accent-2','--chat-accent-ink']){
      if(vars)view.style.setProperty(name,vars[name]);
      else view.style.removeProperty(name);
    }
  };
  applyChatAccentToken=(applyChatAccentToken??0)+1;
  const token=applyChatAccentToken;
  // `chatAccentFor` samples an `avatarImage` asynchronously and returns the
  // id-hash fallback for the first paint; the callback paints the extracted
  // color as soon as it lands, so a cold cache does not wait for a re-open.
  // The token drops a late sample that belongs to a task already left.
  const color=chatAccentFor(agent??(agentId?{id:agentId}:null),{onAccent:(c)=>{
    if(token!==applyChatAccentToken||!c)return;
    setVars(accentVars(c,'auto'));
  }});
  setVars(color?accentVars(color,'auto'):null);
}
async function loadFiles(){const id=state.task?.id;if(!id)return;const data=await api(`/api/files?${taskQuery(id)}&max=400`);if(state.task?.id!==id)return;const entries=data.entries||[];$('filesList').innerHTML=entries.filter(f=>!f.dir).map(f=>`<button class="file-row" data-file="${esc(f.path)}" dir="auto">${esc(f.path)}</button>`).join('')||'<div class="empty">لا ملفات في هذه المهمة بعد.</div>';}
async function openFile(path){
  const id=state.task?.id;if(!id)return;document.querySelector('.sidepanel').hidden=false;$('taskWorkspace').setAttribute('aria-expanded','true');$('previewFrame').hidden=true;await loadFiles();if(id!==state.task?.id)return;
  const box=$('fileView');box.hidden=false;box.replaceChildren();const title=document.createElement('h3');title.textContent=path;const download=document.createElement('a');download.className='btn';download.textContent='تنزيل الملف';download.href='/api/media?'+taskQuery(id)+'&path='+encodeURIComponent(path);download.download=path.split(/[\\/]/).pop();box.append(title,download);
  if(/\.(png|jpe?g|webp|gif|svg)$/i.test(path)){const img=document.createElement('img');img.src=download.href;img.alt=path;box.append(img);return;}
  if(/\.(mp4|webm|mp3|wav|ogg)$/i.test(path)){const media=document.createElement(/\.(mp3|wav|ogg)$/i.test(path)?'audio':'video');media.controls=true;media.src=download.href;box.append(media);return;}
  if(/\.(pdf|docx?|xlsx?|pptx?|zip|exe|dll|woff2?)$/i.test(path)){const p=document.createElement('p');p.textContent='نزّل الملف لفتحه في التطبيق المناسب.';box.append(p);return;}
  try {const data=await api('/api/file?'+taskQuery(id)+'&path='+encodeURIComponent(path));if(id!==state.task?.id||box.firstChild!==title)return;const pre=document.createElement('pre');pre.textContent=data.content??data.text??'';box.append(pre);}catch(error){if(id===state.task?.id&&box.firstChild===title){const p=document.createElement('p');p.textContent='المعاينة النصية غير متاحة. يمكنك تنزيل الملف. '+error.message;box.append(p);}}
}
$('taskWorkspace').onclick=run(async()=>{const panel=document.querySelector('.sidepanel');panel.hidden=!panel.hidden;$('taskWorkspace').setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden){$('closeWorkspace').focus();await loadFiles();}});
$('closeWorkspace').onclick=()=>{document.querySelector('.sidepanel').hidden=true;$('taskWorkspace').setAttribute('aria-expanded','false');livePreview?.destroy();livePreview=null;$('liveView').hidden=true;$('taskWorkspace').focus();};
$('refreshFiles').onclick=run(loadFiles);$('filesList').onclick=run(async event=>{const button=event.target.closest('[data-file]');if(button)await openFile(button.dataset.file);});
$('taskPreview').onclick=run(async()=>{const id=state.task?.id;const existing=await api('/api/preview?'+taskQuery(id));const data=existing.running?existing:await post('/api/preview',{taskId:id,dir:'.'});if(id!==state.task?.id)return;if(!/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(data.url||''))throw new Error('عنوان المعاينة غير صالح.');$('previewFrame').src=data.url;$('previewFrame').hidden=false;$('fileView').hidden=true;});
$('taskLiveView').onclick=run(()=>{const panel=$('liveView');if(!panel.hidden){livePreview?.destroy();livePreview=null;panel.hidden=true;$('filesList').hidden=false;$('fileView').hidden=true;$('previewFrame').hidden=true;return;}const id=state.task?.id;if(!id){notice('اختر مهمة لعرض شاشتها.',true);return;}panel.hidden=false;$('filesList').hidden=true;$('fileView').hidden=true;$('previewFrame').hidden=true;livePreview?.destroy();livePreview=mountLivePreview(panel,{getTaskId:()=>state.task?.id});});
$('chatForm').onsubmit=run(async event=>{event.preventDefault();await submitTask($('promptChat').value);});$('attachChat').onclick=()=>pickFiles('chat');$('stopChat').onclick=run(stopTask);
const services=[['integrations','Loam · التكاملات','تفعيل أدوات الخدمات الخارجية لكل مهمة','/integrations.html'],['site-apis','Loam · واجهات المواقع','عمليات المواقع التي تعلّمها Loam وتعمل بجلستك','/api-anything.html'],['skills','Loam · المهارات','قدرات قابلة لإعادة الاستخدام','/skills.html'],['memory','Loam · الذاكرة','المعرفة المحفوظة المشتركة بإدارة مستقلة','/memory.html'],['brain','Loam · المعرفة','مراجعة المعرفة والخبرات المتراكمة','/brain.html'],['learning','Loam · التقييم','الاختبارات وجودة النتائج','/learning.html'],['companions','Loam · المساعدون','إدارة المساعدين ومحادثاتهم','/companions.html'],['screen','Loam · الشاشة','مشاركة شاشة الجهاز صراحةً','/screen.html']];
$('serviceLinks').innerHTML=services.map(([id,name,description])=>`<a class="service-card" href="#/services/${id}"><h3>${icon(id)} ${name}</h3><p>${description}</p><span>فتح القسم <loam-icon name="back"></loam-icon></span></a>`).join('');
async function refreshCodegraphPanel(){const d=await api('/api/codegraph/status');const r=d.runtime||{};
$('codegraphState').textContent=d.install?.running?`جارٍ التثبيت: ${d.install.step||''}`:r.state==='ready'?`المحرك جاهز (${r.version})${d.enabled?'':' · فعّل الميزة من config.json ثم أعد تشغيل Loam'}`:r.state==='broken'?`المحرك تالف: ${r.detail||''}`:'المحرك غير مثبّت (يحتاج اتصالاً بالإنترنت مرة واحدة، نحو 300 ميغابايت)';
$('codegraphInstall').hidden=r.state==='ready'&&!d.install?.running;
$('codegraphRemove').hidden=r.state==='not-installed';
if(d.install?.running)setTimeout(()=>refreshCodegraphPanel().catch(()=>{}),2000);}
$('codegraphInstall').onclick=run(async()=>{await post('/api/codegraph/runtime/install',{});notice('بدأ تثبيت محرك خريطة الكود.');await refreshCodegraphPanel();});
async function refreshSandboxPanel(){const d=await api('/api/sandbox');const st=d.status||{};
$('sandboxState').textContent=!st.pinVerified?'تعذّر التحقق من ملف العزل — أعد تشغيل مثبّت Loam (node scripts/install-srt.mjs)':st.windowsInstalled===true?'العزل جاهز':st.windowsInstalled==='n/a'?'غير مدعوم على هذا النظام':'يلزم التثبيت مرة واحدة (زر «تثبيت عزل النظام»)'+(st.windowsMessage?' — '+esc(st.windowsMessage):'');
$('sandboxInstall').hidden=st.windowsInstalled===true;
$('sandboxMode').value=d.mode||'off';$('sandboxDomains').value=(d.allowedDomains||[]).join(', ');if($('sandboxAck'))$('sandboxAck').checked=!!d.supplyChainAck;}
$('sandboxInstall').onclick=run(async()=>{notice('ستظهر نافذة صلاحية المدير (UAC) للموافقة مرة واحدة…');const r=await post('/api/sandbox/install',{});notice(r.message||'تم');await refreshSandboxPanel();});
$('sandboxSave').onclick=run(async()=>{const domains=($('sandboxDomains').value||'').split(',').map(x=>x.trim()).filter(Boolean);await post('/api/settings',{sandboxMode:$('sandboxMode').value,sandboxAllowedDomains:domains,sandboxSupplyChainAck:$('sandboxAck').checked});notice('تم حفظ إعدادات العزل.');await refreshSandboxPanel();});
$('codegraphRemove').onclick=run(async()=>{if(!await confirmAction('إزالة المحرك','سيُحذف محرك خريطة الكود. هل تريد حذف الخرائط المحفوظة أيضاً؟'))return;await api('/api/codegraph/runtime?purgeGraphs=1',{method:'DELETE'});await refreshCodegraphPanel();});
const cgAnswer=(fn)=>run(async()=>{const id=state.task?.id;if(!id)return;(state.codegraphAsked??=new Set()).add(id);$('codegraphConsent').hidden=true;await fn(id);});
$('codegraphYes').onclick=cgAnswer(async id=>{await post('/api/codegraph/project/optin',{taskId:id});notice('بدأ بناء خريطة الكود في الخلفية.');});
$('codegraphLater').onclick=cgAnswer(async()=>{});
$('codegraphNever').onclick=cgAnswer(async id=>{await post('/api/codegraph/project/optout',{taskId:id,decline:true});});
async function showServices(){
  show('services','الخدمات والإعدادات');$('serviceCards').innerHTML='<div class="empty">جارٍ فحص الخدمات…</div>';
  const checks=[['خادم Loam','/api/config'],['النماذج المحلية','/api/models'],['طابور التنفيذ','/api/queue'],['ذاكرة Loam','/api/memory/status'],['مهارات Loam','/api/skills'],['تقييم Loam','/api/eval/suites'],['اتصالات MCP','/api/mcp/status'],['خريطة الكود','/api/codegraph/status']];
  const results=await Promise.allSettled(checks.map(async([,path])=>api(path)));
  if(location.hash!=='#/services')return;
  $('serviceCards').innerHTML=results.map((result,index)=>{let success=result.status==='fulfilled';const data=success?result.value:null;let detail=success?'استجاب مسار الخدمة للفحص.':result.reason.message;if(index===1&&success)detail=`${data.models?.length||0} نماذج متاحة. لم يُختبر توليد الإجابات بهذا الفحص.`;if(index===2&&success)detail=`${data.queued?.length||0} في الانتظار · ${data.active?'تنفيذ جارٍ':'لا تنفيذ جارٍ'}`;if(index===6&&success)detail=(data.servers||[]).map(s=>s.name+': '+(s.connected?'متصل · '+s.toolCount+' أدوات':'غير متصل')).join(' · ');if(index===6&&success&&(!data.servers?.length||data.servers.some(s=>!s.connected)))success=false;if(index===7&&success){const r=data.runtime||{};detail=!data.enabled?(r.state==='ready'?'المحرك مثبّت · الميزة معطّلة في الإعدادات':'معطّلة · المحرك غير مثبّت'):r.state==='ready'?`جاهز · الإصدار ${esc(r.version||'')}`:r.state==='broken'?'المحرك تالف — أعد التثبيت':'المحرك غير مثبّت';if(data.install?.running)detail=`جارٍ التثبيت… (${esc(data.install.step||'')})`;success=!!data.ok;}if(index===0&&success)detail=`${data.mcpServers?.length||0} اتصالات إضافية مهيأة؛ يلزم اختبار اتصال كل منها.`;return `<div class="service-card"><span class="pill ${success?'done':'error'}">${success?'استجاب للفحص':'غير متاح'}</span><h3>${checks[index][0]}</h3><p>${esc(detail)}</p></div>`;}).join('');
  const models=results[1];if(models.status==='fulfilled'){const selected=$('model').value;$('model').innerHTML=(models.value.models||[]).map(m=>`<option>${esc(typeof m==='string'?m:m.name)}</option>`).join('');if(selected)$('model').value=selected;}
  refreshCodegraphPanel().catch(()=>{});
  refreshSandboxPanel().catch(()=>{});
}
$('refreshServices').onclick=run(showServices);$('saveModel').onclick=run(async()=>{if(!$('model').value)throw new Error('لا يوجد نموذج متاح.');await post('/api/settings',{model:$('model').value});$('sidebarModel').value=$('model').value;notice('تم حفظ نموذج التنفيذ.');});
async function showCollection(kind){
  show('list',kind==='projects'?'المشاريع':'المواعيد');$('listTitle').textContent=kind==='projects'?'المشاريع':'المواعيد';$('taskSearch').hidden=true;
  const data=await api(`/api/${kind}`);if(location.hash!==`#/${kind}`)return;const items=data[kind]||[];
  $('listBody').innerHTML=items.map(item=>`<div class="task-row"><div><strong>${esc(item.name||item.prompt)}</strong><small>${esc(item.instruction|| (item.intervalSeconds?`كل ${item.intervalSeconds} ثانية`:''))}</small></div>${kind==='projects'?`<button class="btn" data-project="${esc(item.id)}">بدء مهمة</button>`:''}<button class="btn" data-delete="${esc(item.id)}">حذف</button></div>`).join('')||'<div class="empty">لا عناصر بعد.</div>';
  $('listActions').innerHTML=`<form id="collectionForm"><input name="name" placeholder="${kind==='projects'?'اسم المشروع':'نص المهمة المتكررة'}" aria-label="${kind==='projects'?'اسم المشروع':'نص المهمة المتكررة'}" required>${kind==='projects'?'<input name="instruction" placeholder="تعليمات المشروع" aria-label="تعليمات المشروع">':'<input name="interval" type="number" min="60" value="3600" aria-label="الفاصل بالثواني">'}<button class="primary">إضافة</button></form>`;
  $('collectionForm').onsubmit=run(async event=>{event.preventDefault();const f=new FormData(event.target);await post(`/api/${kind}`,kind==='projects'?{name:f.get('name'),instruction:f.get('instruction')}:{prompt:f.get('name'),intervalSeconds:Number(f.get('interval'))});await showCollection(kind);});
  $('listBody').onclick=run(async event=>{const del=event.target.closest('[data-delete]');const project=event.target.closest('[data-project]');if(del && await confirmAction('حذف العنصر','هل تريد حذف هذا العنصر؟')){await api(`/api/${kind}/${encodeURIComponent(del.dataset.delete)}`,{method:'DELETE'});await showCollection(kind);}if(project){state.projectId=project.dataset.project;location.hash='#/modes/build';}});
}
async function route(){
  updateNavigation('جارٍ فتح الصفحة…');
  state.sequence++;stopStream();notice('');state.task=null;state.attachments=[];state.draft=null;resetWorkspace();$('chatAttachments').replaceChildren();$('embedFrame').src='about:blank';
  const path=(location.hash.replace(/^#\/?/,'')||'home').split('/');document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===path.slice(0,2).join('/')||a.dataset.nav===path[0]));
  if(path[0]==='studios'){
    if(path[1]==='office'){renderMode('write');return;}
    if(path[1]==='creative'){renderMode('media');return;}
    const studio=studioById(path[1]);if(!studio)throw new Error('مساحة الاستديو غير موجودة.');
    const mobileUrl=new URL('/mobile.html',location.origin);if(studio.id==='mobile'){if(!$('sidebar').classList.contains('collapsed'))$('collapseBtn').click();const params=new URL(location.href).searchParams;for(const [from,to]of [['mobileTask','taskId'],['mobileScreen','screenId']]){const value=params.get(from);if(value)mobileUrl.searchParams.set(to,value);}}
    show('embed',studio.title);$('embedFrame').title=studio.title;$('embedFrame').src=studio.id==='mobile'?mobileUrl.pathname+mobileUrl.search:studio.id==='security'?'/security.html':studio.id==='swarm'?'/swarm.html':studio.id==='realswarm'?'/realswarm.html':'/studios/index.html#'+studio.id;return;
  }
  if(path[0]==='modes')return renderMode(decodeURIComponent(path[1]||''));
  if(path[0]==='tasks'&&path[1])return loadTask(decodeURIComponent(path[1]));
  if(path[0]==='tasks'){show('list','مهامي');$('listTitle').textContent='مهامي';$('taskSearch').hidden=false;$('listActions').replaceChildren();$('listBody').onclick=null;await refreshTasks();return;}
  if(path[0]==='projects'||path[0]==='schedules')return showCollection(path[0]);
  if(path[0]==='services'&&path[1]){const service=services.find(s=>s[0]===path[1]);if(!service)throw new Error('القسم غير موجود.');show('embed',service[1]);$('embedFrame').src=service[3]+'?embed=1';return;}
  if(path[0]==='services')return showServices();
  show('home','البداية');state.projectId=null;await refreshTasks();
}
$('taskSearch').oninput=renderTaskLists;
$('menuToggle').onclick=()=>{const sidebar=$('sidebar');const open=sidebar.classList.contains('collapsed')||!sidebar.classList.contains('open');sidebar.classList.remove('collapsed');sidebar.classList.toggle('open',open);$('menuToggle').setAttribute('aria-expanded',String(open));if(open)$('collapseBtn').focus();};
document.addEventListener('click',event=>{if($('sidebar').classList.contains('open')&&!$('sidebar').contains(event.target)&&!$('menuToggle').contains(event.target)){$('sidebar').classList.remove('open');$('menuToggle').setAttribute('aria-expanded','false');}});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){$('sidebar').classList.remove('open');$('menuToggle').setAttribute('aria-expanded','false');}});
$('theme').onclick=run(async()=>{const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;localStorage.setItem('loam-theme',theme);applyChatAccent(state.task?.agentId??null);await post('/api/settings',{theme});});
async function navigate(){
  const requestedRoute=location.hash;
  try{await route();}catch(error){
    if(location.hash!==requestedRoute)return;
    show('list','تعذّر فتح الصفحة');$('listTitle').textContent='تعذّر فتح الصفحة';$('taskSearch').hidden=true;$('listActions').replaceChildren();$('listBody').onclick=null;
    $('listBody').innerHTML=`<div class="empty"><p>${esc(error.message)}</p><button class="btn" type="button" data-retry-route>إعادة المحاولة</button> <a class="btn" href="#/home">العودة للرئيسية</a></div>`;
    $('listBody').querySelector('[data-retry-route]').onclick=()=>void navigate();
  }
}
window.addEventListener('hashchange',()=>void navigate());
async function boot(){
  const results=await Promise.allSettled([api('/api/modes'),api('/api/settings'),api('/api/models')]);
  void loadChatAgents();
  if(results[0].status==='fulfilled'){state.modes=results[0].value.modes||[];renderModes();$('connection').textContent='متصل محليًا';$('connection').classList.add('online');}else{notice('تعذّر تحميل مساحات Loam. تحقق من تشغيل الخادم ثم أعد تحميل الصفحة.',true);$('connection').textContent='غير متصل';}
  if(results[2].status==='fulfilled')$('model').innerHTML=(results[2].value.models||[]).map(m=>`<option>${esc(typeof m==='string'?m:m.name)}</option>`).join('');
  if(results[1].status==='fulfilled'&&results[1].value.model)$('model').value=results[1].value.model;
  $('sidebarModel').innerHTML=$('model').innerHTML;$('sidebarModel').value=$('model').value;
  await navigate();
  if(!state.modes.length){$('modeCards').innerHTML='<div class="empty">تعذّر تحميل المساحات. أعد تحميل الصفحة بعد التأكد من تشغيل الخادم.</div>';notice('خدمة الأنماط غير متاحة.',true);}
}
setInterval(()=>{if(document.hidden)return;void refreshTasks().then(()=>{const task=state.task;if(!task)return;const latest=state.tasks.find(t=>t.id===task.id);if(latest && latest.status!==task.status && !state.posting.has(task.id))void loadTask(task.id,true).catch(()=>{});}).catch(()=>{$('connection').textContent='الاتصال غير متاح';$('connection').classList.remove('online');});},5000);
void boot().catch(error=>notice(error.message,true));
