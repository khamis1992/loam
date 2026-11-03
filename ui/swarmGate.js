'use strict';
// BUILD_SPEC §5.3: lifecycle surfaces for the company page — intake questions, plan approval,
// stage checkpoints with non-destructive rollback, and the opt-in static cloud launch.
// Independent of swarm.js internals: it reads the selected run id from the URL (?run=).
(() => {
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = String(text); return e; };
  let lastKey = '';
  window.loamSwarmProfile = () => ({
    effort: $('effort')?.value || 'auto', intake: 'auto', approval: $('approval')?.value || 'required',
    review: 'two-stage', taskGraph: true, spec: 'ears', projectGuide: true, webResearch: true, visualGate: 'advisory',
  });
  async function call(path, method, body) {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `تعذّر الطلب (${res.status})`);
    return data;
  }
  function show(box, message, isError) { const p = el('p', isError ? 'run-error' : 'hint', message); box.append(p); }
  function renderIntake(box, run) {
    const a = run.intake.assessment;
    box.append(el('h2', '', a.verdict === 'stop' ? 'تقييم الفكرة: يُنصح بالتوقف' : 'أسئلة قبل البدء'));
    if (a.summary) box.append(el('p', 'muted', a.summary));
    const form = el('form');
    for (const q of a.questions) {
      const label = el('label', '', q.prompt); const id = `gate-q-${q.id}`; label.htmlFor = id;
      const input = q.options?.length ? el('select') : el('input');
      input.id = id; input.dataset.qid = q.id;
      if (q.options?.length) { input.append(el('option', '', '')); for (const o of q.options) { const opt = el('option', '', o.label ?? o); opt.value = o.label ?? o; input.append(opt); } }
      form.append(label, input);
    }
    const note = el('textarea'); note.rows = 3; note.placeholder = 'ملاحظة إضافية (اختياري)'; form.append(note);
    const go = el('button', 'primary', 'أرسل الإجابات وتابع'); go.type = 'submit';
    const stop = el('button', '', 'أوقف العملية'); stop.type = 'button';
    form.append(go, stop);
    const send = decision => { const answers = {}; for (const i of form.querySelectorAll('[data-qid]')) if (i.value.trim()) answers[i.dataset.qid] = i.value.trim(); return call(`/api/swarm/runs/${run.id}/clarify`, 'POST', { decision, answers, note: note.value }).then(() => { lastKey = ''; }).catch(e => show(box, e.message, true)); };
    form.onsubmit = e => { e.preventDefault(); void send('continue'); };
    stop.onclick = () => void send('stop');
    box.append(form);
  }
  function renderApproval(box, run) {
    const plan = run.approval.summary;
    box.append(el('h2', '', `اعتماد الخطة (الجولة ${run.approval.round})`));
    const pre = el('pre', 'agent-output');
    pre.textContent = [`حجم العملية: ${plan.effort}`, `المتطلبات: ${plan.requirementCount}`, ...plan.requirements.slice(0, 12).map(r => `- ${r.id}: ${r.text}`), ...(plan.tasks.length ? [`المهام (${plan.tasks.length}):`, ...plan.tasks.map(t => `- ${t.id} ${t.title} — ${t.files.join(', ')}`)] : []), `أمر التحقق: ${plan.verificationCommand ?? 'يحدده التنفيذ'}`, `المراحل: ${plan.stages.join(' → ')}`].join('\n');
    box.append(pre);
    const feedback = el('textarea'); feedback.rows = 3; feedback.placeholder = 'ما الذي تريد تغييره في الخطة؟';
    const approve = el('button', 'primary', 'اعتمد وابدأ التنفيذ'); approve.type = 'button';
    const revise = el('button', '', 'اطلب تعديل الخطة'); revise.type = 'button';
    const cancel = el('button', '', 'ألغِ'); cancel.type = 'button';
    const decide = (decision) => call(`/api/swarm/runs/${run.id}/approve`, 'POST', { decision, feedback: feedback.value }).then(() => { lastKey = ''; }).catch(e => show(box, e.message, true));
    approve.onclick = () => void decide('approve'); revise.onclick = () => void decide('revise'); cancel.onclick = () => void decide('cancel');
    box.append(feedback, approve, revise, cancel);
  }
  async function renderTerminal(box, run) {
    const { checkpoints = [] } = await call(`/api/swarm/runs/${run.id}/checkpoints`, 'GET').catch(() => ({}));
    if (!checkpoints.length && run.status !== 'completed') return false;
    box.append(el('h2', '', 'نقاط الاستعادة والإطلاق'));
    if (checkpoints.length) {
      const select = el('select'); for (const c of checkpoints.slice(-30).reverse()) { const o = el('option', '', `${c.stage} · ${c.sha.slice(0, 8)}`); o.value = JSON.stringify({ stage: c.stage, sha: c.sha }); select.append(o); }
      const back = el('button', '', 'افتح فرعًا عند هذه النقطة'); back.type = 'button';
      back.onclick = () => call(`/api/swarm/runs/${run.id}/rollback`, 'POST', JSON.parse(select.value)).then(r => show(box, `تم إنشاء الفرع ${r.rollback.branch}؛ الفروع السابقة لم تتغير.`)).catch(e => show(box, e.message, true));
      box.append(select, back);
    }
    if (run.status === 'completed') {
      const target = el('select'); for (const t of ['vercel', 'netlify']) { const o = el('option', '', t); o.value = t; target.append(o); }
      const launch = el('button', '', 'انشر نسخة ثابتة علنًا'); launch.type = 'button';
      launch.onclick = () => { if (!confirm('سيصبح الموقع متاحًا للعامة. هل تريد المتابعة؟')) return; void call(`/api/swarm/runs/${run.id}/launch`, 'POST', { target: target.value, confirm: true, production: false }).then(r => show(box, r.launch.message)).catch(e => show(box, e.message, true)); };
      box.append(target, launch);
    }
    return true;
  }
  async function tick() {
    const box = $('swarm-gate'); const id = new URL(location.href).searchParams.get('run');
    if (!box || !id) { if (box) box.hidden = true; return; }
    try {
      const { run } = await call(`/api/swarm/runs/${encodeURIComponent(id)}`, 'GET');
      const key = `${run.id}:${run.status}:${run.pendingGate || ''}:${run.approval?.round || 0}:${(run.checkpoints || []).length}`;
      if (key === lastKey) return; lastKey = key;
      box.replaceChildren();
      if (run.pendingGate === 'intake' && run.intake) renderIntake(box, run);
      else if (run.pendingGate === 'approval' && run.approval) renderApproval(box, run);
      else if (['completed', 'failed', 'cancelled'].includes(run.status)) { if (!(await renderTerminal(box, run))) { box.hidden = true; return; } }
      else { box.hidden = true; return; }
      box.hidden = false;
    } catch { /* swarm.js already reports connectivity */ }
  }
  setInterval(() => void tick(), 3000); void tick();
})();
