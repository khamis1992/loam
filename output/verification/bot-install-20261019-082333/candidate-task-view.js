// The overview describes the latest request; earlier turns remain in the log.
const labels = { queued: 'في قائمة الانتظار', running: 'جارٍ التنفيذ', done: 'اكتملت المهمة', error: 'تعذّر إكمال المهمة', interrupted: 'انقطع التشغيل', cancelled: 'أُوقفت المهمة' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function applyTaskEvent(model, event) {
  if (!event) return;
  if (event.type === 'plan') {
    const previous = model.plan;
    model.plan = (event.steps || []).map(step => ({...step, phase: previous.find(p => p.id === step.id && p.title === step.title)?.phase || 'waiting'}));
  }
  if (event.type === 'plan_step') {
    const step = model.plan.find(s => s.id === event.id);
    if (step) step.phase = event.phase === 'start' ? 'running' : 'executed';
  }
  if (event.type === 'critique') {
    const step = model.plan.find(s => s.id === event.id);
    if (step) { step.phase = event.verdict; step.reason = event.reason; }
  }
  if (event.type === 'verification_progress') model.verificationProgress = event.stage;
  if (['verify', 'error', 'cancelled', 'done'].includes(event.type)) model.verificationProgress = null;
  if (event.type === 'verify') model.verification = event;
  if (event.type === 'assistant_message') model.result = event.text || '';
  if (event.type === 'error') model.error = event.message;
  if (event.type === 'task-status') model.status = event.status;
  if (event.type === 'done') model.status = 'done';
  if (event.type === 'cancelled') model.status = 'cancelled';
  if (event.type === 'tool_call') {
    const queue = model.pending[event.name] ||= [];
    queue.push(event.args || {});
  }
  if (event.type === 'tool_result') {
    const args = model.pending[event.name]?.shift();
    if (event.ok && event.name === 'loam_dataset' && typeof args?.output === 'string') model.files.add(args.output);
    if (event.ok && ['file_write', 'file_edit', 'write_file', 'edit_file', 'loam_document', 'loam_canvas'].includes(event.name) && typeof args?.path === 'string') model.files.add(args.path);
  }
}
export function createTaskModel(task = {}, recovery = {}) {
  const messages = task.messages || [];
  const user = messages.findLast(m => m.role === 'user');
  const model = { status: task.status || 'queued', request: user?.content || task.prompt || '', plan: [], result: '', verification: null, error: '', pending: Object.create(null), files: new Set(), recovery };
  for (const step of task.steps || []) {
    if (!user?.at || (step.at && step.at >= user.at)) applyTaskEvent(model, step.data);
  }
  model.status = task.status || 'queued'; // Persisted state takes precedence over historic events.
  const answer = messages.findLast(m => m.role === 'assistant' && (!user?.at || m.at >= user.at));
  if (!model.result && answer) model.result = answer.content;
  return model;
}
export function mountTaskView({ markdown, stop, followup, openFile }) {
  const $ = id => document.getElementById(id);
  let model = createTaskModel();
  const put = (id, html) => { if ($(id).innerHTML !== html) $(id).innerHTML = html; };
  function selectTab(name) {
    for (const button of document.querySelectorAll('[data-task-tab]')) {
      const selected = button.dataset.taskTab === name;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    $('taskOverview').hidden = name !== 'overview';
    $('timeline').hidden = name !== 'activity';
  }
  for (const button of document.querySelectorAll('[data-task-tab]')) {
    button.onclick = () => selectTab(button.dataset.taskTab);
    button.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll('[data-task-tab]')];
      const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[1] : tabs.find(b => b !== button);
      target.click(); target.focus();
    };
  }
  $('taskAction').onclick = () => ['queued', 'running'].includes(model.status) ? stop() : followup();
  $('taskCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(model.result); $('taskCopy').textContent = 'تم النسخ'; }
    catch { $('taskCopy').textContent = 'تعذّر النسخ'; }
  };
  $('taskFiles').onclick = event => {
    const button = event.target.closest('[data-output]');
    if (button) openFile(button.dataset.output);
  };
  function render() {
    const active = ['queued', 'running'].includes(model.status);
    $('taskSummary').textContent = labels[model.status] || model.status;
    $('taskAction').textContent = active ? (model.status === 'queued' ? 'إلغاء الانتظار' : 'إيقاف التنفيذ') : 'إضافة توجيه';
    $('taskRequest').textContent = model.request;
    $('taskResultTitle').textContent = model.status === 'done' ? 'النتيجة' : 'النتيجة حتى الآن';
    put('taskResult', model.result ? markdown(model.result) : '<p class="muted">' + (active ? 'ستظهر الإجابة هنا عند توفرها. يمكنك متابعة الخطوات أو فتح سجل التنفيذ.' : 'لا توجد إجابة محفوظة لهذا الطلب. راجع السجل لمعرفة ما حدث.') + '</p>');
    $('taskCopy').hidden = !model.result;
    $('taskCopy').textContent = 'نسخ النتيجة';
    const phases = {waiting:'بانتظار التنفيذ', running:'قيد التنفيذ', executed:'نُفّذت — لم تُراجع', pass:'اجتازت المراجعة', revise:'تحتاج تعديلًا', fail:'لم تجتز المراجعة'};
    put('taskPlan', model.plan.length ? '<ol>' + model.plan.map(step => `<li><div class="task-step-title">${escape(step.title)} <span class="pill">${phases[step.phase] || escape(step.phase)}</span></div>${(step.successCriteria || step.success_criteria) ? `<p class="muted">معيار الإنجاز: ${escape((step.successCriteria || step.success_criteria))}</p>` : ''}${step.reason ? `<p>${escape(step.reason)}</p>` : ''}</li>`).join('') + '</ol>' : '<p class="muted">لم تُسجّل خطة لهذا الطلب بعد.</p>');
    const verification = model.verification;
    const verificationStages = {creative:'فحص المشهد بصريًا', application:'تشغيل اختبارات التطبيق والفحص البصري', independent_author:'إعداد اختبارات قبول مستقلة', independent_application:'تشغيل الاختبارات المستقلة والفحص البصري', final_review:'مراجعة النتائج قبل التسليم'};
    const progress = active && verificationStages[model.verificationProgress];
    $('taskVerification').textContent = progress ? `جارٍ ${progress} — لم يُعتمد اكتمال المهمة بعد.` : verification ? `${verification.verdict === 'pass' ? 'اجتاز التحقق النهائي' : 'التحقق يتطلب مراجعة'} — ${verification.reason || ''}` : 'لم يُسجّل تحقق نهائي لهذا الطلب.';
    $('taskIssue').hidden = !model.error;
    $('taskIssue').textContent = model.error ? `تنبيه من التنفيذ: ${model.error}` : '';
    put('taskFiles', model.files.size ? [...model.files].map(path => `<button class="task-output" data-output="${escape(path)}"><span dir="auto">${escape(path)}</span><span>فتح الملف <loam-icon name="back"></loam-icon></span></button>`).join('') : '<p class="muted">لم يُسجّل حفظ أو تعديل ملفات بأدوات الملفات لهذا الطلب.</p>');
  }
  return {
    reset(task, recovery) { model = createTaskModel(task, recovery); selectTab('overview'); render(); },
    event(event) { applyTaskEvent(model, event); if (event.type !== 'assistant_token') render(); },
  };
}
