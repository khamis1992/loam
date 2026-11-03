'use strict';
/* نتريو — real self-organizing swarm studio. Every rendered value comes from
 * /api/realswarm rows (board/mailbox/git-derived snapshot fields); nothing here
 * invents or hardcodes a metric. */
(() => {
  const $ = id => document.getElementById(id);
  const state = { runs: [], run: null, selected: null, board: '', busy: false, loading: false, timer: null, stopped: false };
  const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
  const labels = { queued:'في الانتظار', running:'قيد التنفيذ', idle:'خامل', completed:'مكتمل', failed:'تعذّر', cancelled:'ملغى', interrupted:'مقطوع' };
  const runLabels = { queued:'في الانتظار', running:'قيد التنفيذ', completed:'مكتملة', failed:'فاشلة', cancelled:'ملغاة', interrupted:'مقطوعة' };
  function element(tag, className, text) { const el=document.createElement(tag); if(className) el.className=className; if(text!==undefined) el.textContent=String(text); return el; }
  function date(value) { const d=new Date(value); return Number.isNaN(d.getTime())?'':d.toLocaleString('ar',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }
  function notice(message) { $('notice').textContent=message || ''; $('notice').hidden=!message; }
  function connected(ok) { $('connection').textContent=ok?'متصل بالخادم':'تعذّر الاتصال · ستتم المحاولة تلقائيًا'; $('connection').classList.toggle('online',ok); }
  async function api(path, options={}) { const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),30000); try { const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...options.headers},signal:controller.signal}); const payload=await response.json().catch(()=>({})); if(!response.ok) throw new Error(typeof payload.error==='string'?payload.error:payload.error?.message||payload.message||`تعذّر الطلب (${response.status})`); return payload; } catch(error) { if(error.name==='AbortError') throw new Error('انتهت مهلة الاتصال بالخادم.'); throw error; } finally { clearTimeout(timeout); } }
  const post=(path,data={})=>api(path,{method:'POST',body:JSON.stringify(data)});
  // Known server messages shown in Arabic; anything else passes through as-is.
  const AR_MESSAGES={'unknown run':'العملية المحددة لم تعد موجودة','goal is required':'الهدف مطلوب','too many active runs; wait for one to finish':'عمليات نشطة كثيرة — انتظر انتهاء واحدة قبل بدء عملية جديدة','engine unavailable':'خدمة السرب غير مفعّلة على هذا الخادم'};
  const arMessage=(error)=>{const key=String(error?.payload?.error||error?.message||'');return AR_MESSAGES[key]||error.message;};

  function selectRun(id) { state.selected=id; state.run=null; state.board=''; try{localStorage.setItem('loam-realswarm-run',id);}catch{} const url=new URL(location.href);url.searchParams.set('run',id);history.replaceState(null,'',url);renderRun();void refresh(); }
  function renderHistory() {
    $('metric-total').textContent=state.runs.length;
    $('metric-active').textContent=state.runs.filter(r=>['queued','running'].includes(r.status)).length;
    $('metric-done').textContent=state.runs.filter(r=>r.status==='completed').length;
    const list=$('history');list.replaceChildren();
    if(!state.runs.length){list.append(element('p','empty','لا توجد عمليات بعد.'));return;}
    for(const run of state.runs){const button=element('button','history-item'+(run.id===state.selected?' selected':''));button.type='button';button.setAttribute('aria-pressed',String(run.id===state.selected));button.append(element('strong','',run.goal||run.id));const meta=element('small');meta.append(element('span','',runLabels[run.status]||run.status),element('span','',`${date(run.createdAt)} · ${run.maxWorkers||0} عمال`));button.append(meta);button.onclick=()=>selectRun(run.id);list.append(button);}
  }
  function chip(box,label,value){ box.append(element('span','',label), (()=>{const s=element('span');const b=element('b','',String(value));s.append(b);return s;})()); }
  function renderRun() {
    const run=state.run;
    if(!run){ $('run-title').textContent=state.selected?'تحميل العملية…':'السرب جاهز'; $('run-meta').textContent=state.selected?'جارٍ استعادة آخر حالة محفوظة.':'اكتب هدفًا لإطلاق أول عملية.'; $('run-status').textContent='بانتظار طلبك'; $('run-status').className='badge'; $('run-goal').hidden=true; $('chips').hidden=true; $('cancel').hidden=true; $('task-link').hidden=true; $('run-error').hidden=true; $('workers').replaceChildren(element('div','welcome','ستظهر بطاقات العمال هنا فور بدء العملية.')); $('board').textContent='لم تبدأ أي عملية بعد.'; $('merges').replaceChildren(element('p','empty','لا دموج بعد.')); $('merge-count').textContent='0 دمجًا'; $('timeline').replaceChildren(element('li','empty','لم يبدأ النشاط بعد.')); $('event-count').textContent='0 أحداث'; $('metric-claims').textContent='0'; return; }
    $('run-title').textContent='فريق البرمجة · '+run.id.slice(0,14);
    $('run-meta').textContent=`${date(run.createdAt)} · ${run.maxWorkers} عمال · ${run.model||'النموذج الافتراضي'} · مهلة ${Math.round(run.deadlineMs/60000)} دقيقة`;
    if(run.usage) $('run-meta').textContent+=` · رموز ${run.usage.promptTokens||0}/${run.usage.completionTokens||0} · ${run.usage.modelCalls||0} استدعاء نموذج · ${Math.round((run.usage.durationMs||0)/1000)}ث`;
    const reasons={deadline:'توقّف بالمهلة',quiescent:'اكتمل بهدوء (هدف مُتحقّق)',cancelled:'أُلغي',all_workers_failed:'فشل كل العمال',turn_limit:'حد الأدوار'};
    if(run.completionReason) $('run-meta').textContent+=` · ${reasons[run.completionReason]||run.completionReason}`;
    $('run-status').textContent=runLabels[run.status]||run.status;
    $('run-status').className='badge '+run.status;
    $('run-goal').textContent=run.goal; $('run-goal').hidden=false;
    $('cancel').hidden=terminal.has(run.status); $('task-link').hidden=!run.taskId;
    $('retry').hidden=!['failed','cancelled','interrupted'].includes(run.status);
    $('resume').hidden=!(run.status==='interrupted'&&(run.shared?.checkpoints===true));
    if(run.taskId)$('task-link').href='/#/tasks/'+encodeURIComponent(run.taskId);
    $('run-error').textContent=run.error||''; $('run-error').hidden=!run.error;
    const m=run.metrics||{}; const chips=$('chips'); chips.replaceChildren(); chips.hidden=false;
    chip(chips,'مطالبات',`${m.claimsActive??0}/${m.claimsOpened??0}`); chip(chips,'مُتحقّقة',m.patchVerified??0);
    chip(chips,'مُبطلة',m.patchInvalidated??0); chip(chips,'إخفاقات',m.failsRecorded??0);
    chip(chips,'دموج',m.mergesLanded??0); chip(chips,'تعارضات حُلّت',m.conflictsResolved??0);
    chip(chips,'ارتكاسات main',m.mainCommits??0); chip(chips,'رسائل',`${m.messagesChannel??0}ق/${m.messagesDirect??0}م`);
    if(run.shared) chip(chips,'قدرات النواة',[run.shared.progress&&'تقدّم',run.shared.checkpoints&&'تفتيش',run.shared.selection&&'انتقاء',run.shared.tracing&&'تتبع'].filter(Boolean).join('، ')||'لا شيء');
    $('metric-claims').textContent=String(m.claimsActive??0);
    const board=$('workers'); board.replaceChildren();
    for(const w of run.workers||[]){
      const card=element('article','agent-card '+(w.status||''));
      const top=element('div','agent-top');
      const title=element('div'); title.append(element('div','agent-role','عامل متساوٍ'), element('h4','agent-title',w.id));
      top.append(title, element('span','badge '+(w.status||''), labels[w.status]||w.status));
      card.append(top);
      card.append(element('p','worker-claim',w.currentClaimLabel?('المطالبة الحالية: '+w.currentClaimLabel):'لا مطالبة مفتوحة'));
      const meta=element('div','agent-meta');
      meta.append(element('span','',`${w.turns||0} دورًا`), element('span','',`${w.toolCalls||0} استدعاء أداة`), element('span','',`${(w.usage?.promptTokens||0)+(w.usage?.completionTokens||0)} رمزًا`), element('span','',w.lastActivityAt?('آخر نشاط '+date(w.lastActivityAt)):''));
      card.append(meta);
      if(w.error) card.append(element('p','run-error',w.error));
      board.append(card);
    }
    if(!(run.workers||[]).length) board.append(element('p','empty','جارٍ إطلاق العمال…'));
    $('board').textContent=state.board||run.boardFinal||'(لا محتوى لوحة بعد)';
    const merges=$('merges'); merges.replaceChildren(); $('merge-count').textContent=`${(run.merges||[]).length} دمجًا`;
    for(const mg of run.merges||[]){ const row=element('div','merge-row'); row.append(element('b','',mg.branch), element('span','',`${mg.changedFiles} ملفًا${mg.conflictsResolved?.length?` · حُلّ ${mg.conflictsResolved.length} تعارض`:''}`), element('small','',date(mg.mergedAt))); merges.append(row); }
    if(!(run.merges||[]).length) merges.append(element('p','empty','لا دموج بعد.'));
    const events=run.events||[]; $('event-count').textContent=`${events.length} أحداث`;
    const timeline=$('timeline'); timeline.replaceChildren();
    for(const event of events.slice(-100).reverse()){ const li=element('li'); li.append(element('time','',date(event.at)), element('span','',(event.worker?event.worker+' · ':'')+(event.message||event.type))); timeline.append(li); }
    if(!events.length) timeline.append(element('li','empty','لم يبدأ النشاط بعد.'));
  }
  async function refresh() {
    if(state.stopped||state.loading)return; state.loading=true; clearTimeout(state.timer); const id=state.selected;
    try{
      const data=await api('/api/realswarm/runs'); state.runs=data.runs||[]; renderHistory();
      if(id){
        try{
          const detail=await api('/api/realswarm/runs/'+encodeURIComponent(id));
          if(state.selected===id){ state.run=detail.run; if(state.run && ['running','queued'].includes(state.run.status)){ try{ const b=await api('/api/realswarm/runs/'+encodeURIComponent(id)+'/board'); if(state.selected===id) state.board=b.rendered||''; }catch{ state.board=''; } } else state.board=''; renderRun(); }
        }catch(detailError){
          // A run deleted since it was selected (restored from storage) must not
          // show as a connection failure every poll - drop the selection.
          if(state.selected===id && String(detailError.payload?.error||'')==='unknown run'){
            state.selected=null; state.run=null; state.board='';
            try{localStorage.removeItem('loam-realswarm-run');}catch{}
            history.replaceState(null,'',new URL(location.href).pathname);
            renderRun(); notice('العملية المحددة لم تعد موجودة — تم مسح الاختيار.');
          } else throw detailError;
        }
      }
      connected(true);
    }catch(error){ connected(false); if(String(error.payload?.error||error.message)!=='engine unavailable') notice(arMessage(error)); }
    finally{ state.loading=false; if(!state.stopped) state.timer=setTimeout(()=>void refresh(), 3000); }
  }
  async function action(callback){ if(state.busy)return; state.busy=true; for(const id of ['start','cancel','retry','resume'])$(id).disabled=true; notice(''); try{ await callback(); }catch(error){ notice(error.message); }finally{ state.busy=false; for(const id of ['start','cancel','retry','resume'])$(id).disabled=false; } }
  $('goal-form').addEventListener('submit',event=>{ event.preventDefault(); if(!$('goal-form').reportValidity())return; void action(async()=>{ const goal=$('goal').value.trim(); if(goal.length<10) throw new Error('اكتب هدفًا أوضح، لا يقل عن 10 أحرف.'); const request={goal, maxWorkers:Number($('workers').value), deadlineMs:Number($('deadline').value)}; if($('model').value) request.model=$('model').value; const data=await post('/api/realswarm/runs',request); if(!data.run?.id) throw new Error('لم يُرجع الخادم معرّف العملية.'); selectRun(data.run.id); state.run=data.run; renderRun(); }); });
  $('cancel').onclick=()=>void action(async()=>{ const id=state.selected; const data=await post('/api/realswarm/runs/'+encodeURIComponent(id)+'/cancel'); if(state.selected===id){ state.run=data.run; renderRun(); } await refresh(); });
  $('retry').onclick=()=>void action(async()=>{ const id=state.selected; const data=await post('/api/realswarm/runs/'+encodeURIComponent(id)+'/retry'); if(state.selected===id){ state.run=data.run; renderRun(); } await refresh(); });
  $('resume').onclick=()=>void action(async()=>{ const id=state.selected; const data=await post('/api/realswarm/runs/'+encodeURIComponent(id)+'/resume'); if(state.selected===id){ state.run=data.run; renderRun(); } await refresh(); });
  $('refresh').onclick=()=>{ notice(''); void refresh(); };
  window.addEventListener('pagehide',()=>{state.stopped=true;clearTimeout(state.timer);});
  window.addEventListener('pageshow',()=>{if(state.stopped){state.stopped=false;void refresh();}});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
  async function boot(){
    state.selected=new URL(location.href).searchParams.get('run');
    if(!state.selected){ try{ state.selected=localStorage.getItem('loam-realswarm-run'); }catch{} }
    const result=await Promise.allSettled([api('/api/models'),api('/api/config')]);
    if(result[0].status==='fulfilled'){ for(const item of result[0].value.models||[]){ const name=typeof item==='string'?item:item.name; if(name){ const option=element('option','',name); option.value=name; $('model').append(option); } } }
    if(result[1].status==='fulfilled'&&[...$('model').options].some(o=>o.value===result[1].value.model)) $('model').value=result[1].value.model;
    renderRun(); await refresh();
  }
  void boot().catch(error=>notice(error.message));
})();
