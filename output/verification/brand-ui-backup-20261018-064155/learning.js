const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function payloadPreview(item) {
  const p = item.payload || {};
  if (item.kind === "memory_store") return String(p.text ?? "");
  if (item.kind === "skill_create") return `# ${p.name}\n${p.description ?? ""}\n\n${p.content ?? ""}`;
  if (item.kind === "skill_patch") return p.content ? String(p.content) : `- ${p.old_string ?? ""}\n+ ${p.new_string ?? ""}`;
  if (item.kind === "skill_delete") return `delete ${p.name}`;
  return JSON.stringify(p);
}

async function approve(id) {
  await fetch(`/api/pending/${encodeURIComponent(id)}/approve`, { method: "POST" });
  void load();
}

async function reject(id) {
  await fetch(`/api/pending/${encodeURIComponent(id)}/reject`, { method: "POST" });
  void load();
}

function renderPending(items) {
  $("pendCount").textContent = String(items.length);
  const el = $("pending");
  el.innerHTML = "";
  if (!items.length) {
    el.innerHTML = `<div class="card"><div class="meta">لا شيء بانتظار الموافقة — كل التغييرات تُطبَّق تلقائياً.</div></div>`;
    return;
  }
  for (const it of items) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="meta"><span class="kind">${esc(it.kind)}</span> ${esc(it.id)} • ${esc((it.at || "").slice(0, 16))}</div>
      <div>${esc(it.summary)}</div>
      <pre class="body">${esc(payloadPreview(it))}</pre>`;
    const btns = document.createElement("div");
    btns.className = "btns";
    const ok = document.createElement("button");
    ok.className = "primary";
    ok.textContent = "موافقة";
    ok.onclick = () => void approve(it.id);
    const no = document.createElement("button");
    no.className = "ghost";
    no.textContent = "رفض";
    no.onclick = () => void reject(it.id);
    btns.appendChild(ok);
    btns.appendChild(no);
    card.appendChild(btns);
    el.appendChild(card);
  }
}

/* ---------- self-evaluation ---------- */

let pollTimer = null;
let currentDraft = null;

async function loadEvalSuites() {
  try {
    const data = await (await fetch("/api/eval/suites")).json();
    const sel = $("evalSuite");
    sel.innerHTML = "";
    for (const s of data.suites || []) {
      const opt = document.createElement("option");
      opt.value = s.source === "draft" ? s.path : s.id;
      let label = `${s.id} (${s.cases} حالات${s.source === "draft" ? " • مسودة" : ""})`;
      if (s.lastRun && s.lastRun.summary) label += ` • آخر: ${Math.round(s.lastRun.summary.passRate * 100)}%`;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    if (data.active && data.active.suiteId) $("evalInfo").textContent = `تشغيل جارٍ: ${data.active.suiteId}…`;
    if (data.busy && !data.active) $("evalInfo").textContent = "يوجد تشغيل جارٍ…";
  } catch {
    /* ignore */
  }
}

function caseChips(cases) {
  return (cases || [])
    .map((c) => `<span class="chip ${esc(c.status)}" title="${esc(c.id)}${c.error ? ` — ${esc(c.error)}` : ""}">${esc(c.id)}</span>`)
    .join(" ");
}

function caseDetails(cases) {
  const failing = (cases || []).filter((c) => c.status !== "pass");
  if (!failing.length) return "";
  return failing
    .map((c) => {
      const checkpoints = (c.checkpoints || [])
        .map((p) => `${p.ok ? 'نجح' : 'فشل'} ${esc(p.type)}: ${esc(p.detail)}`)
        .join("<br>");
      const critique = c.critique
        ? `<div class="meta">نقد: ${esc((c.critique.failureCauses || []).join("؛ "))}${c.critique.betterPlan ? ` — ${esc(c.critique.betterPlan)}` : ""}</div>`
        : "";
      return `<details><summary>${esc(c.id)} — ${esc(c.status)}</summary><div class="meta">${checkpoints}</div>${critique}</details>`;
    })
    .join("");
}

function renderRunCard(run) {
  const s = run.summary || {};
  return `<div class="card">
    <div class="meta"><span class="kind">${esc(run.suiteId)}</span> ${esc(run.id)} • ${esc((run.startedAt || "").slice(0, 16))}${run.status === "running" ? " • قيد التشغيل…" : ""}</div>
    <div>pass ${s.pass || 0} • fail ${s.fail || 0} • error ${s.error || 0} • ${Math.round((s.passRate || 0) * 100)}%</div>
    <div>${caseChips(run.cases)}</div>
    ${caseDetails(run.cases)}
  </div>`;
}

async function loadEvalRuns() {
  try {
    const { runs } = await (await fetch("/api/eval/runs?limit=10")).json();
    const el = $("evalRuns");
    if (!runs || !runs.length) {
      el.innerHTML = `<div class="card"><div class="meta">لا توجد عمليات تقييم بعد.</div></div>`;
      return;
    }
    el.innerHTML = runs.map((r) => renderRunCard(r)).join("");
  } catch {
    /* ignore */
  }
}

async function pollRun(runId) {
  try {
    const res = await fetch(`/api/eval/runs/${encodeURIComponent(runId)}`);
    const data = await res.json();
    if (data.run) {
      $("evalRuns").innerHTML = renderRunCard(data.run);
      $("evalInfo").textContent = data.running
        ? `قيد التشغيل… (${(data.run.cases || []).length} حالة انتهت)`
        : `انتهى — passRate ${Math.round((data.run.summary?.passRate || 0) * 100)}%`;
    }
    if (data.running) {
      pollTimer = setTimeout(() => void pollRun(runId), 2500);
    } else {
      await loadEvalSuites();
      await loadEvalRuns();
    }
  } catch {
    pollTimer = setTimeout(() => void pollRun(runId), 4000);
  }
}

function renderLog(entries) {
  const el = $("log");
  if (!entries.length) {
    el.innerHTML = `<div class="card"><div class="meta">لا تعلّم مسجّل بعد.</div></div>`;
    return;
  }
  el.innerHTML = entries
    .map(
      (e) => `
    <div class="card">
      <div class="meta">${esc((e.at || "").slice(0, 16))}</div>
      <div>${esc((e.applied || []).join(" | ") || e.raw || "")}</div>
      ${e.task ? `<div class="meta">${esc(e.task)}</div>` : ""}
    </div>`,
    )
    .join("");
}

async function loadMemory() {
  try {
    const st = await (await fetch("/api/memory/status")).json();
    $("memInfo").textContent = `• الذاكرة: ${st.count} عنصر${st.enabled ? "" : " (معطّل)"}`;
  } catch {
    /* ignore */
  }
}

async function load() {
  const [p, l] = await Promise.all([
    (await fetch("/api/pending")).json(),
    (await fetch("/api/learning?limit=100")).json(),
  ]);
  renderPending(p.items || []);
  renderLog(l.entries || []);
  void loadMemory();
  void loadEvalSuites();
  void loadEvalRuns();
}

$("approveAll").onclick = async () => {
  const { items } = await (await fetch("/api/pending")).json();
  for (const it of items || []) await fetch(`/api/pending/${encodeURIComponent(it.id)}/approve`, { method: "POST" });
  void load();
};
$("rejectAll").onclick = async () => {
  const { items } = await (await fetch("/api/pending")).json();
  for (const it of items || []) await fetch(`/api/pending/${encodeURIComponent(it.id)}/reject`, { method: "POST" });
  void load();
};
$("curate").onclick = async () => {
  const r = await (await fetch("/api/memory/curate", { method: "POST" })).json();
  $("curateInfo").textContent = `أُزيل ${r.removed ?? 0} • المتبقي ${r.count ?? "?"}`;
  void loadMemory();
};

$("evalRun").onclick = async () => {
  if (pollTimer) clearTimeout(pollTimer);
  const suiteRef = $("evalSuite").value;
  $("evalInfo").textContent = "بدأ التشغيل…";
  try {
    const res = await fetch("/api/eval/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ suite: suiteRef }),
    });
    const data = await res.json();
    if (!res.ok) {
      $("evalInfo").textContent = data.error || "تعذّر بدء التشغيل";
      return;
    }
    void pollRun(data.runId);
  } catch (err) {
    $("evalInfo").textContent = String(err);
  }
};

$("evalSelfplay").onclick = async () => {
  $("evalInfo").textContent = "يولّد حالات من الفشل… (قد يستغرق دقيقة)";
  try {
    const res = await fetch("/api/eval/selfplay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok) {
      $("evalInfo").textContent = data.error || "تعذّر التوليد";
      return;
    }
    currentDraft = data.draftPath;
    const info = $("evalInfo");
    info.textContent = `مسودة: ${data.suiteId} (${data.cases} حالة) من ${data.sourceFailures.length} فشل — `;
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = "اعتماد المسودة";
    btn.onclick = async () => {
      const r = await fetch("/api/eval/drafts/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: currentDraft }),
      });
      const d = await r.json();
      $("evalInfo").textContent = r.ok ? `اعتُمدت: ${d.id}` : d.error || "تعذّر الاعتماد";
      await loadEvalSuites();
    };
    info.appendChild(btn);
    $("evalRuns").innerHTML = `<div class="card"><div class="meta">معاينة الحالات المولّدة</div>${(data.preview || [])
      .map((p) => `<div>• ${esc(p.prompt)}</div>`)
      .join("")}</div>`;
  } catch (err) {
    $("evalInfo").textContent = String(err);
  }
};

$("evalExport").onclick = async () => {
  $("evalInfo").textContent = "يصدّر بيانات التدريب…";
  try {
    const res = await fetch("/api/eval/export", { method: "POST" });
    const data = await res.json();
    $("evalInfo").textContent = res.ok
      ? `بيانات التدريب: sft=${data.sft} • pref=${data.pref} → ${data.dir}`
      : data.error || "تعذّر التصدير";
  } catch (err) {
    $("evalInfo").textContent = String(err);
  }
};

void load();
