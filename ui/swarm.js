'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const state = { runs: [], run: null, selected: null, busy: false, loading: false, timer: null, stopped: false, artifacts: [], artifactError: null, previewUrl: null };
  const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
  const labels = { queued:'في الانتظار', pending:'بانتظار التبعيات', blocked:'بانتظار التبعيات', running:'قيد التنفيذ', completed:'مكتمل', failed:'تعذّر التنفيذ', cancelled:'ملغى', interrupted:'توقف التنفيذ', skipped:'تم تخطيه' };
  function element(tag, className, text) { const el=document.createElement(tag); if(className) el.className=className; if(text!==undefined) el.textContent=String(text); return el; }
  function date(value) { const d=new Date(value); return Number.isNaN(d.getTime())?'':d.toLocaleString('ar',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }
  function notice(message) { $('notice').textContent=message || ''; $('notice').hidden=!message; }
  function connected(ok) { $('connection').textContent=ok?'متصل بالخادم':'تعذّر الاتصال · ستتم المحاولة تلقائيًا'; $('connection').classList.toggle('online',ok); }
  async function api(path, options={}) { const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),30000); try { const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...options.headers},signal:controller.signal}); const payload=await response.json().catch(()=>({})); if(!response.ok){ const failure=new Error(typeof payload.error==='string'?payload.error:payload.error?.message||payload.message||`تعذّر الطلب (${response.status})`); failure.payload=payload; throw failure; } return payload; } catch(error) { if(error.name==='AbortError')throw new Error('انتهت مهلة الاتصال بالخادم. تحقق من سجل العمليات قبل إعادة الطلب.'); throw error; } finally {clearTimeout(timeout);} }
  const post=(path,data={})=>api(path,{method:'POST',body:JSON.stringify(data)});
  function selectRun(id) { state.selected=id; state.run=null; state.artifacts=[]; state.artifactError=null; state.previewUrl=null; try{localStorage.setItem('loam-swarm-run',id);}catch{} const url=new URL(location.href);url.searchParams.set('run',id);history.replaceState(null,'',url);renderRun();void refresh(); }
  function renderHistory() {
    $('metric-total').textContent=state.runs.length; $('metric-active').textContent=state.runs.filter(r=>['queued','running'].includes(r.status)).length; $('metric-done').textContent=state.runs.filter(r=>r.status==='completed').length;
    const list=$('history');list.replaceChildren(); if(!state.runs.length){list.append(element('p','empty','لا توجد عمليات بعد.'));return;}
    for(const run of state.runs){const button=element('button','history-item'+(run.id===state.selected?' selected':''));button.type='button';button.setAttribute('aria-pressed',String(run.id===state.selected));button.append(element('strong','',run.brief||run.id));const meta=element('small');meta.append(element('span','',labels[run.status]||run.status),element('span','',date(run.createdAt)));button.append(meta);button.onclick=()=>selectRun(run.id);list.append(button);}
  }
  function renderRun() {
    const run=state.run; $('metric-agents').textContent=run?.nodes?.length||0;
    if(!run){$('run-title').textContent=state.selected?'تحميل العملية…':'مساحة الفريق جاهزة';$('run-meta').textContent=state.selected?'جارٍ استعادة آخر حالة محفوظة.':'اكتب طلبًا لبدء أول عملية.';$('run-status').textContent='بانتظار طلبك';$('run-status').className='badge';$('run-brief').hidden=true;$('verification').hidden=true;$('board').replaceChildren(element('p','empty',state.selected?'جارٍ تحميل فريق العملية…':'ستظهر هنا أدوار الفريق وتبعياته ومخرجاته فور إنشاء العملية.'));$('timeline').replaceChildren(element('li','empty','لم يتم تحميل نشاط عملية.'));$('event-count').textContent='0 أحداث';renderArtifacts();for(const id of ['cancel','retry','resume','preview','stop-preview','task-link','run-error','memory','deploy','stage-progress'])$(id).hidden=true;return;}
    $('run-title').textContent='فريق العمل · '+run.id.slice(0,12);$('run-meta').textContent=`${date(run.createdAt)} · ${run.model||'النموذج الافتراضي'} · تزامن ${run.concurrency||1}`;
    const actualModels=[...new Set((run.nodes||[]).map(node=>node.model).filter(Boolean))];if(actualModels.some(model=>model!==run.model))$('run-meta').textContent+=' · النماذج الفعلية: '+actualModels.join('، ');
    if(run.repairs)$('run-meta').textContent+=` · إصلاح ذاتي ×${run.repairs}${run.maxRepairIterations?` (الحد ${run.maxRepairIterations})`:''}`;
    if(run.usage)$('run-meta').textContent+=` · رموز ${run.usage.promptTokens||0}/${run.usage.completionTokens||0} · ${run.usage.modelCalls||0} استدعاء نموذج · ${Math.round((run.usage.durationMs||0)/1000)}ث`;
    renderVerification(run);renderMemory(run);renderDeploy(run);renderProgress(run);
    $('run-status').textContent=labels[run.status]||run.status;$('run-status').className='badge '+(Object.hasOwn(labels,run.status)?run.status:'');$('run-brief').textContent=run.brief;$('run-brief').hidden=false;
    $('cancel').hidden=terminal.has(run.status);$('retry').hidden=!['failed','interrupted'].includes(run.status);$('resume').hidden=run.status!=='interrupted';$('task-link').hidden=!run.taskId;if(run.taskId)$('task-link').href='/#/tasks/'+encodeURIComponent(run.taskId);
    const previewable=run.status==='completed'&&run.deploy?.previewable===true;
    $('preview').hidden=!previewable||!!state.previewUrl;$('stop-preview').hidden=!state.previewUrl;$('preview').disabled=!!state.previewUrl;
    $('run-error').textContent=run.error||'';$('run-error').hidden=!run.error;
    const opened=new Set([...$('board').querySelectorAll('details[open]')].map(el=>el.dataset.node));const board=$('board');board.replaceChildren();
    for(const node of run.nodes||[]){const card=element('article','agent-card '+(Object.hasOwn(labels,node.status)?node.status:''));card.dataset.nodeId=node.id;const top=element('div','agent-top');const title=element('div');title.append(element('div','agent-role',node.role),element('h4','agent-title',node.title||node.id));top.append(title,element('span','badge '+(Object.hasOwn(labels,node.status)?node.status:''),labels[node.status]||node.status));card.append(top);const meta=element('div','agent-meta');meta.append(element('span','',`${Array.isArray(node.toolCalls)?node.toolCalls.length:node.toolCalls||0} استدعاء أداة`),element('span','',`${node.steps||0} خطوة`));card.append(meta);if(node.model)card.append(element('p','agent-model','النموذج الفعلي: '+node.model));const deps=(node.dependsOn||[]).map(id=>(run.nodes||[]).find(n=>n.id===id)?.title||id);card.append(element('p','dependencies',deps.length?'يعتمد على: '+deps.join(' ← '):'نقطة بداية · لا توجد تبعيات'));const details=element('details');details.dataset.node=node.id;details.open=opened.has(node.id);details.append(element('summary','',node.error?'عرض الخطأ والمخرجات':'عرض مخرجات الوكيل'));if(node.error)details.append(element('p','run-error',node.error));details.append(element('pre','agent-output',node.output||'لم يسجّل الوكيل مخرجات نصية بعد.'));card.append(details);board.append(card);}
    if(!run.nodes?.length)board.append(element('p','empty','جارٍ إعداد فريق العملية…'));
    const events=run.events||[];$('event-count').textContent=`${events.length} أحداث`;const timeline=$('timeline');timeline.replaceChildren();for(const event of events.slice(-100).reverse()){const li=element('li');const time=element('time','',date(event.at));li.append(time,element('span','',(event.nodeId?`${event.nodeId} · `:'')+(event.message||event.type)));timeline.append(li);}if(!events.length)timeline.append(element('li','empty','لم يبدأ النشاط بعد.'));
    renderArtifacts();
  }
  function renderVerification(run){
    const box=$('verification');
    if(run.verification){
      box.hidden=false;const attempts=(run.verificationAttempts||[]).length;const lastDiff=(run.repairDiffs||[]).slice(-1)[0];
      const parts=[element('p','verify-command',run.verification.command),element('p','verify-note',attempts>1?`آخر جولة جودة: ${attempts} محاولات تحقق، آخرها ناجحة.`:'آخر جولة جودة: اجتاز التحقق من المحاولة المسجلة الأولى.'),element('p','verify-note',`زمن الدليل: ${date(run.verification.at)}${run.repairs?` · جولات إصلاح ذاتي مستخدمة: ${run.repairs}`:''}`)];
      if(lastDiff){const line=String(lastDiff.stat||'').trim().split('\n').pop()||'';parts.push(element('p','verify-note','آخر فرق كود لجولة إصلاح (git diff): '+line));}
      box.replaceChildren(...parts);
    } else if((run.verificationAttempts||[]).length){
      box.hidden=false;box.replaceChildren(element('p','verify-note',`محاولات تحقق مسجلة دون نجاح بعد: ${(run.verificationAttempts||[]).length}. راجع مخرجات الجودة.`));
    } else box.hidden=true;
  }
  function renderMemory(run){
    const box=$('memory');const mem=run?.memory;
    if(!mem){box.hidden=true;return;}
    box.hidden=false;const kinds=mem.kinds||{};
    const heading=element('h3','','ذاكرة المشروع');
    if(run.repoSeed)heading.append(element('span','seed-badge','مستودع مزروع'));
    box.replaceChildren(heading,element('p','memory-note',`الملفات: ${mem.files||0} · كود ${kinds.code||0} · اختبارات ${kinds.test||0} · توثيق/تقارير ${(kinds.doc||0)+(kinds.report||0)} · حواف اعتماد ${mem.edges||0}`));
  }
  function renderDeploy(run){
    const box=$('deploy');const deploy=run?.deploy;
    if(!deploy){box.hidden=true;return;}
    box.hidden=false;
    const health=deploy.healthCheck||{ok:false,detail:''};
    const healthLine=deploy.packageType==='http'&&health.ok
      ? `فحص الصحة: ناجح (GET ${health.endpoint||'/'} → ${health.statusCode||200})`
      : `فحص الصحة: ${health.ok?'ناجح':'فاشل'} — ${health.detail||'لا يوجد دليل جاهزية.'}`;
    const parts=[element('h3','','تجهيز النشر'),
      element('p','deploy-note','النوع: '+(deploy.packageType==='http'?'منتج HTTP قابل للتشغيل':'مكتبة — التحقق عبر مجموعة الاختبارات')),
      element('p','deploy-note',healthLine)];
    if(deploy.entry)parts.push(element('p','deploy-note','أمر التشغيل: '+(deploy.startCommand||`node ${deploy.entry}`)));
    parts.push(element('p','deploy-note','التراجع: git reset --hard '+(deploy.rollbackTag||'pre-deploy')));
    box.replaceChildren(...parts);
  }
  function renderProgress(run){
    const box=$('stage-progress');const nodes=run?.nodes||[];
    if(!nodes.length){box.hidden=true;return;}
    box.hidden=false;const done=nodes.filter(node=>node.status==='completed').length;
    const fill=element('span','fill');fill.style.width=`${Math.round(done/nodes.length*100)}%`;
    const bar=element('div','bar');bar.append(fill);
    box.replaceChildren(bar,element('p','progress-label',`المراحل المكتملة ${done}/${nodes.length}${run.repairs?` · إصلاح ذاتي ×${run.repairs}`:''}`));
  }
  function renderArtifacts(){const box=$('artifacts');box.replaceChildren();$('artifact-count').textContent=`${state.artifacts.length} ملفات`;if(state.artifactError){box.append(element('p','empty',state.artifactError));return;}if(!state.artifacts.length){box.append(element('p','empty','لا توجد ملفات حتى الآن.'));return;}for(const file of state.artifacts){const row=element('div','artifact');const link=element('a','',file.path);link.href='/api/media?taskId='+encodeURIComponent(state.run.taskId)+'&path='+encodeURIComponent(file.path);link.download=String(file.path).split(/[\\/]/).pop();link.title='تنزيل '+file.path;row.append(link,element('small','',Number.isFinite(file.size)?`${(file.size/1024).toFixed(1)} KB`:''));box.append(row);}}
  async function refresh() {
    if(state.stopped||state.loading)return;state.loading=true;clearTimeout(state.timer);const id=state.selected;
    try{const data=await api('/api/swarm/runs');state.runs=data.runs||[];renderHistory();if(id){const data=await api('/api/swarm/runs/'+encodeURIComponent(id));if(state.selected===id){state.run=data.run;try{const files=await api('/api/swarm/runs/'+encodeURIComponent(id)+'/artifacts');if(state.selected===id){state.artifacts=files.artifacts||[];state.artifactError=null;}}catch(error){if(state.selected===id)state.artifactError='تعذّر تحميل الملفات: '+error.message;}if(state.selected===id)renderRun();}}connected(true);}catch(error){connected(false);notice(error.message);}finally{state.loading=false;if(!state.stopped)state.timer=setTimeout(()=>void refresh(),state.selected!==id?0:3000);}
  }
  async function action(callback){if(state.busy)return;state.busy=true;for(const id of ['start','cancel','retry','resume','preview','stop-preview'])$(id).disabled=true;notice('');try{await callback();}catch(error){notice(error.message);}finally{state.busy=false;for(const id of ['start','cancel','retry','resume','preview','stop-preview'])$(id).disabled=false;}}
  $('brief-form').addEventListener('submit',event=>{event.preventDefault();if(!$('brief-form').reportValidity())return;void action(async()=>{const brief=$('brief').value.trim();if(brief.length<10)throw new Error('اكتب متطلبات أوضح، لا تقل عن 10 أحرف.');const request={brief,concurrency:Number($('concurrency').value),maxSteps:Number($('max-steps').value),maxRepairIterations:Number($('repair-budget').value),...(window.loamSwarmProfile?window.loamSwarmProfile():{})};if($('model').value)request.model=$('model').value;const data=await post('/api/swarm/runs',request);if(!data.run?.id)throw new Error('لم يُرجع الخادم معرّف العملية. حدّث السجل للتحقق من إنشائها.');selectRun(data.run.id);state.run=data.run;renderRun();});});
  $('cancel').onclick=()=>void action(async()=>{const id=state.selected;const data=await post('/api/swarm/runs/'+encodeURIComponent(id)+'/cancel');if(state.selected===id){state.run=data.run;renderRun();}await refresh();});
  $('retry').onclick=()=>void action(async()=>{const data=await post('/api/swarm/runs/'+encodeURIComponent(state.selected)+'/retry');selectRun(data.run.id);state.run=data.run;renderRun();});
  $('resume').onclick=()=>void action(async()=>{const data=await post('/api/swarm/runs/'+encodeURIComponent(state.selected)+'/resume');selectRun(data.run.id);state.run=data.run;renderRun();});
  $('preview').onclick=()=>void action(async()=>{
    const id=state.selected;if(!id)return;
    try{
      const data=await post('/api/swarm/runs/'+encodeURIComponent(id)+'/preview');
      const url=data?.preview?.url;
      if(!url)throw new Error('لم يُرجع الخادم عنوان المعاينة. تحقّق من حالة العملية ثم أعد المحاولة.');
      state.previewUrl=url;
      window.open(url,'_blank','noopener');
    }catch(error){
      if(!/already running/i.test(String(error.message||'')))throw error;
      const url=error.payload?.preview?.url||error.payload?.url||null;
      state.previewUrl=url||'running';
      notice('المعاينة قيد التشغيل بالفعل لهذه العملية. استخدم زر الإيقاف لإيقافها.');
    }
    renderRun();
  });
  $('stop-preview').onclick=()=>void action(async()=>{
    await post('/api/swarm/runs/'+encodeURIComponent(state.selected)+'/preview/stop',{});
    state.previewUrl=null;renderRun();
  });
  $('refresh').onclick=()=>{notice('');void refresh();};
  window.addEventListener('pagehide',()=>{state.stopped=true;clearTimeout(state.timer);});window.addEventListener('pageshow',()=>{if(state.stopped){state.stopped=false;void refresh();}});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
  async function boot(){state.selected=new URL(location.href).searchParams.get('run');if(!state.selected)try{state.selected=localStorage.getItem('loam-swarm-run');}catch{}const result=await Promise.allSettled([api('/api/models'),api('/api/config')]);if(result[0].status==='fulfilled'){for(const item of result[0].value.models||[]){const name=typeof item==='string'?item:item.name;if(name){const option=element('option','',name);option.value=name;$('model').append(option);}}}else{notice('تعذّر تحميل قائمة النماذج. يمكنك استخدام النموذج الافتراضي أو إعادة تحميل الصفحة.');}if(result[1].status==='fulfilled'&&[...$('model').options].some(o=>o.value===result[1].value.model))$('model').value=result[1].value.model;renderRun();await refresh();}
  void boot().catch(error=>notice(error.message));
})();



