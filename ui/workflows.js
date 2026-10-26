/* مسارات العمل studio: list definitions, inspect nodes, run with inputs, poll the durable run state. */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const notice = (msg, bad = true) => {
    const n = $("notice");
    n.textContent = msg;
    n.classList.toggle("bad", bad);
    n.hidden = !msg;
  };
  const api = async (p) => {
    const r = await fetch(p, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
    return r.json();
  };
  const post = (p, body) => fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 202) throw new Error(d.error ?? r.statusText);
    return d;
  });

  const state = { defs: [], selected: null, runId: null, poll: null };

  function renderList() {
    const el = $("wf-list");
    if (!state.defs.length) { el.innerHTML = '<p class="empty">لا توجد مسارات محفوظة.</p>'; return; }
    el.innerHTML = state.defs.map((w) => `<button type="button" class="run-item${state.selected === w.id ? " selected" : ""}" data-id="${esc(w.id)}"><strong>${esc(w.title)}</strong><span class="small-tag">${esc(w.source)}</span></button>`).join("");
    for (const b of el.querySelectorAll("button[data-id]")) b.onclick = () => selectDef(b.dataset.id);
    const sel = $("wf-id");
    sel.innerHTML = state.defs.map((w) => `<option value="${esc(w.id)}">${esc(w.title)}</option>`).join("");
  }

  async function selectDef(id) {
    state.selected = id;
    renderList();
    try {
      const { workflow } = await api("/api/workflows/" + encodeURIComponent(id));
      $("wf-title").textContent = workflow.title;
      $("wf-desc").textContent = workflow.description ?? "";
      $("nodes").innerHTML = workflow.nodes.map((n) => `<article class="card"><header><strong>${esc(n.id)}</strong><span class="small-tag">${esc(n.kind)}</span>${n.outputKey ? `<span class="small-tag">${esc(n.outputKey)}</span>` : ""}</header><p class="hint">${esc(n.kind === "agent" ? (n.agent?.prompt ?? "").slice(0, 140) : n.kind === "tool" ? n.tool?.name : n.kind === "human" ? n.human?.question : n.kind === "vote" ? "تصويت: " + (n.vote?.from ?? []).join("، ") : n.kind === "condition" ? "شرط" : n.kind === "subworkflow" ? n.subworkflow?.workflowId : "تحويل")}</p>${(workflow.edges ?? []).filter((e) => e.from === n.id).map((e) => `<span class="small-tag">${esc(e.to)}${e.when ? " (" + e.when + ")" : ""}</span>`).join(" ")}</article>`).join("");
      const props = workflow.inputs?.properties ?? {};
      $("inputs-fields").innerHTML = Object.entries(props).map(([k, v]) => `<label for="in-${esc(k)}">${esc(k)}${workflow.inputs?.required?.includes(k) ? " *" : ""}</label><input id="in-${esc(k)}" data-input="${esc(k)}" ${v.type === "number" ? 'type="number"' : 'type="text"'}>`).join("") || '<p class="hint">لا مدخلات لهذا المسار.</p>';
    } catch (e) {
      notice("تعذّر فتح المسار: " + e.message);
    }
  }

  async function refresh() {
    try {
      const data = await api("/api/workflows");
      state.defs = data.workflows ?? [];
      renderList();
      $("connection").textContent = "متصل";
      if (state.selected && state.defs.some((w) => w.id === state.selected)) await selectDef(state.selected);
      else if (state.defs[0]) await selectDef(state.defs[0].id);
    } catch (e) {
      $("connection").textContent = "غير متصل";
      notice("تعذّر تحميل المسارات: " + e.message);
    }
  }

  $("refresh").onclick = () => void refresh();

  $("run-form").addEventListener("submit", (event) => {
    event.preventDefault();
    notice("", false);
    void (async () => {
      const id = $("wf-id").value;
      const inputs = {};
      for (const input of document.querySelectorAll("[data-input]")) inputs[input.dataset.input] = input.value;
      const d = await post("/api/workflows/" + encodeURIComponent(id) + "/run", { inputs });
      if (!d.runId) throw new Error("لم يُرجع الخادم معرّف التشغيل.");
      state.runId = d.runId;
      $("run-out").hidden = false;
      $("run-out").textContent = "runId: " + d.runId + " — taskId: " + d.taskId;
      $("run-status").textContent = "قيد التشغيل";
      poll();
    })().catch((e) => notice(e.message));
  });

  function poll() {
    if (state.poll) clearInterval(state.poll);
    state.poll = setInterval(() => void (async () => {
      try {
        const { run } = await api("/api/workflows/runs/" + encodeURIComponent(state.runId));
        $("run-status").textContent = ({ running: "قيد التشغيل", waiting: "بانتظار موافقتك", succeeded: "اكتمل", failed: "فشل", cancelled: "ملغى" })[run.status] ?? run.status;
        $("run-state").textContent = JSON.stringify({ status: run.status, superstep: run.superstep, frontier: run.frontier, state: run.state, error: run.error, waiting: run.waitingInterrupt }, null, 2);
        if (run.status !== "running") clearInterval(state.poll);
      } catch { /* transient */ }
    })(), 2000);
  }

  void refresh();
})();
