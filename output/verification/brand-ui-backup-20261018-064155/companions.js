const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const state = {
  taskId: null,
  es: null,
  streaming: false,
  assistantBody: null,
  pendingTool: null,
  planEl: null,
  agents: [],
  agentId: (localStorage.getItem("loam-companion") ?? localStorage.getItem("grok-agent")) || "",
  mic: null,
  editingId: null,
  attached: [],
  tools: [],
  modes: [],
};

const SEND_ICON = '<loam-icon name="send"></loam-icon>';

/* ---------------- helpers ---------------- */
const thread = () => $("rkThread");
const stick = () => {
  const t = thread();
  return t.scrollHeight - t.scrollTop - t.clientHeight < 160;
};
const scroll = () => {
  const t = thread();
  t.scrollTop = t.scrollHeight;
};
function toast(text, ms = 2800) {
  const el = $("rkToast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}
function showWelcome(text) {
  thread().innerHTML = `<div class="rk-welcome"><div class="big"><loam-icon name="companions"></loam-icon> رفقاء Loam</div><div class="sub">${text}</div></div>`;
}
function clearWelcome() {
  const w = thread().querySelector(".rk-welcome");
  if (w) w.remove();
}
const activeAgent = () => state.agents.find((a) => a.id === state.agentId) || null;

/* ---------------- rendering (Rakazo bubbles) ---------------- */
function addMsg(role, text) {
  clearWelcome();
  const wrap = document.createElement("div");
  wrap.className = `rk-msg ${role}`;
  const b = document.createElement("div");
  b.className = "rk-bubble";
  b.textContent = text;
  wrap.appendChild(b);
  thread().appendChild(wrap);
  if (stick()) scroll();
  return b;
}
function assistantBubble() {
  if (!state.assistantBody) state.assistantBody = addMsg("assistant", "");
  return state.assistantBody;
}
function addTool(name, args) {
  clearWelcome();
  const div = document.createElement("div");
  div.className = "rk-tools";
  div.innerHTML = `<div class="rk-tool"><span class="rk-tool-head"><span><loam-icon name="creative"></loam-icon></span><span class="nm">${esc(name)}</span></span><span class="st"></span><pre></pre></div>`;
  const chip = div.querySelector(".rk-tool");
  chip.dataset.args = JSON.stringify(args ?? {}, null, 1).slice(0, 2000);
  chip.onclick = () => {
    chip.classList.toggle("open");
    if (chip.classList.contains("open")) {
      const pre = chip.querySelector("pre");
      pre.hidden = false;
      pre.textContent = chip.dataset.args;
    }
  };
  state.pendingTool = chip;
  thread().appendChild(div);
  if (stick()) scroll();
}
function finishTool(name, ok, summary, ms) {
  const chip = state.pendingTool;
  if (!chip) return;
  chip.classList.add(ok ? "ok" : "err");
  chip.querySelector(".nm").textContent = name;
  chip.querySelector("pre").textContent = `${summary ?? ""}${ms ? ` (${ms}ms)` : ""}`;
  state.pendingTool = null;
  if (stick()) scroll();
}
function addNote(text, kind) {
  clearWelcome();
  const div = document.createElement("div");
  div.className = `rk-note ${kind || ""}`.trim();
  div.textContent = text;
  thread().appendChild(div);
  if (stick()) scroll();
}
function addPlan(ev) {
  clearWelcome();
  const div = document.createElement("div");
  div.className = "rk-plan";
  div.innerHTML = `<div class="h">الخطة${ev.trivial ? " (تنفيذ مباشر)" : ""} — ${esc(ev.goal)}</div>${(ev.steps || [])
    .map((s) => `<div class="st" data-pid="${esc(s.id)}">• ${esc(s.title || s.id)}</div>`)
    .join("")}`;
  state.planEl = div;
  thread().appendChild(div);
  if (stick()) scroll();
}
function planStep(ev) {
  const el = state.planEl?.querySelector(`[data-pid="${CSS.escape(ev.id)}"]`);
  if (el) {
    el.classList.toggle("done", ev.phase === "done");
    const title = el.dataset.title || el.textContent.replace(/^[•▸✔]\s*/, "");
    el.dataset.title = title;
    el.innerHTML = `<loam-icon name="${ev.phase === "done" ? "check" : "play"}"></loam-icon> ${esc(title)}`;
  }
}
const verdictLabel = (v) => (v === "pass" ? "مقبول" : v === "fail" ? "فشل" : "يحتاج مراجعة");
function renderEvent(ev) {
  if (!ev || !ev.type) return;
  switch (ev.type) {
    case "step":
      state.assistantBody = null;
      break;
    case "assistant_token":
      assistantBubble().textContent += ev.text;
      if (stick()) scroll();
      break;
    case "assistant_message":
      assistantBubble().textContent = ev.text;
      state.assistantBody = null;
      if (stick()) scroll();
      break;
    case "tool_call":
      addTool(ev.name, ev.args);
      break;
    case "tool_result":
      finishTool(ev.name, ev.ok, ev.summary, ev.ms);
      break;
    case "plan":
      addPlan(ev);
      break;
    case "plan_step":
      planStep(ev);
      break;
    case "critique":
      addNote(`الناقد: ${verdictLabel(ev.verdict)} — ${ev.reason}`, ev.verdict === "pass" ? "ok" : "err");
      break;
    case "revise":
      addNote(`إعادة محاولة (${ev.attempt})`, "");
      break;
    case "replan":
      addNote(`إعادة تخطيط #${ev.round}: ${ev.reason}`, "");
      break;
    case "verify":
      addNote(`التحقق النهائي: ${verdictLabel(ev.verdict)} — ${ev.reason}`, ev.verdict === "pass" ? "ok" : "");
      break;
    case "cancelled":
      addNote("⏹ أُوقفت المهمة", "err");
      break;
    case "error":
      addNote(`خطأ: ${ev.message}`, "err");
      break;
    default:
      break;
  }
}

/* ---------------- sidebar (agents list) ---------------- */
function renderSidebar() {
  const box = $("rkBots");
  box.innerHTML = "";

  const base = document.createElement("button");
  base.className = `rk-bot ${state.agentId === "" ? "active" : ""}`;
  base.innerHTML = `<span class="av"><loam-icon name="companions"></loam-icon></span><span class="nm"><span class="t">الوكيل العام</span><span class="s">النموذج والإعدادات العامة</span></span>`;
  base.onclick = () => void selectAgent("");
  box.appendChild(base);

  for (const a of state.agents) {
    const el = document.createElement("button");
    el.className = `rk-bot ${state.agentId === a.id ? "active" : ""}`;
    const meta = [a.description, a.model ? a.model.replace(/^orcarouter\//, "") : "", a.mode === "ask" ? "استكشاف" : a.mode === "build" ? "إنجاز" : ""]
      .filter(Boolean)
      .join(" • ");
    el.innerHTML = `<span class="av">${a.emoji && a.emoji!=="🤖" ? esc(a.emoji) : '<loam-icon name="companions"></loam-icon>'}</span><span class="nm"><span class="t">${esc(a.name)}</span><span class="s">${esc(meta.slice(0, 60) || "وكيل مخصص")}</span></span><span class="ed" data-ed="${esc(a.id)}" title="تعديل"><loam-icon name="write"></loam-icon></span>`;
    el.onclick = (e) => {
      if (e.target.closest("[data-ed]")) {
        openModal(a.id);
        return;
      }
      void selectAgent(a.id);
    };
    box.appendChild(el);
  }

  const add = document.createElement("button");
  add.className = "rk-newbot";
  add.innerHTML = `<span style="font-size:15px"><loam-icon name="plus"></loam-icon></span> وكيل جديد`;
  add.onclick = () => openModal(null);
  box.appendChild(add);
}

function renderHeader() {
  const a = activeAgent();
  $("rkHeadAv").innerHTML = a?.emoji && a.emoji!=="🤖" ? esc(a.emoji) : '<loam-icon name="companions"></loam-icon>';
  $("rkHeadName").textContent = a ? a.name : "الوكيل العام";
  const toolSummary = (agent) => {
    const total = state.tools.length;
    if (!agent || !agent.disabledTools || agent.disabledTools.length === 0) return total > 0 ? `الأدوات المتاحة حسب النمط (${total} في الكتالوج)` : "أدوات حسب النمط";
    return `أدوات: ${Math.max(0, total - agent.disabledTools.length)}/${total}`;
  };
  $("rkHeadSub").textContent = a
    ? [a.description || "وكيل مخصص", a.model ? a.model.replace(/^orcarouter\//, "") : "", a.mode === "ask" ? "Ask" : a.mode === "build" ? "Build" : "", toolSummary(a)]
        .filter(Boolean)
        .join(" • ")
    : `Loam — يعمل على جهازك • ${toolSummary(null)}`;
  const ta = $("rkPrompt");
  ta.placeholder = a ? `راسل ${a.name}…` : "راسل الوكيل…";
}

/* ---------------- agent selection + per-agent thread ---------------- */
async function selectAgent(id) {
  if (state.streaming) {
    toast("يوجد تشغيل جارٍ — أوقفه أولاً");
    return;
  }
  state.attached = [];
  renderChips();
  state.agentId = id;
  localStorage.setItem("loam-companion", id);
  renderSidebar();
  renderHeader();
  await loadThreadForAgent();
}

async function loadThreadForAgent() {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  state.taskId = null;
  state.assistantBody = null;
  let tasks = [];
  try {
    const q = state.agentId ? `?agentId=${encodeURIComponent(state.agentId)}` : "?agentId=none";
    tasks = (await (await fetch(`/api/tasks${q}`)).json()).tasks ?? [];
  } catch {
    /* offline */
  }
  const latest = tasks.find((t) => (t.agentId ?? null) === (state.agentId || null)) ?? tasks[0];
  if (latest) {
    await openTask(latest.id);
  } else {
    thread().innerHTML = "";
    showWelcome(
      activeAgent()
        ? `ابدأ أول رسالة إلى <b>${esc(activeAgent().name)}</b>.`
        : "اختر وكيلًا من القائمة أو ابدأ مباشرة مع الوكيل العام.",
    );
  }
}

async function openTask(id) {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  state.taskId = id;
  state.assistantBody = null;
  thread().innerHTML = "";
  try {
    const { task } = await (await fetch(`/api/tasks/${encodeURIComponent(id)}`)).json();
    const hasAssistantEvents = (task.steps ?? []).some((s) => s.data?.type === "assistant_message");
    for (const m of task.messages ?? []) if (m.role === "user" || !hasAssistantEvents) addMsg(m.role === "user" ? "user" : "assistant", m.content);
    for (const s of task.steps ?? []) renderEvent(s.data);
    state.assistantBody = null;
    state.streaming = ["running", "queued"].includes(task.status);
    setRunState();
    if (state.streaming) subscribe(id, (task.steps ?? []).length);
  } catch {
    showWelcome("تعذّر تحميل المحادثة.");
  }
  scroll();
}

function subscribe(id, replayCount = 0) {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  const es = new EventSource(`/api/tasks/${encodeURIComponent(id)}/stream`);
  state.es = es;
  let remainingReplay = replayCount;
  let connected = false;
  es.onopen = () => {
    if (connected) { es.close(); void openTask(id); }
    connected = true;
  };
  es.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    if (ev.type === "step-record") {
      if (remainingReplay > 0) { remainingReplay -= 1; return; }
      renderEvent(ev.step?.data);
    }
    else renderEvent(ev);
    if (ev.type === "done" || ev.type === "cancelled" || (ev.type === "task-status" && !["running", "queued"].includes(ev.status))) {
      if (state.streaming) {
        state.streaming = false;
        setRunState();
      }
    }
  };
}

/* ---------------- composer ---------------- */
function setRunState() {
  const running = state.streaming;
  $("rkSend").hidden = running;
  $("rkStop").hidden = !running;
  const ta = $("rkPrompt");
  $("rkSend").disabled = ta.value.trim().length === 0;
  $("rkMic").hidden = ta.value.trim().length > 0 || running;
  $("rkMic").classList.remove("rk-rec");
}

async function send() {
  const ta = $("rkPrompt");
  const text = (ta.value || "").trim();
  if (state.streaming) return;
  if (!text) return toast("اكتب رسالتك أولاً");
  if (state.es) { state.es.close(); state.es = null; }
  ta.value = "";
  ta.style.height = "auto";
  state.streaming = true;
  state.assistantBody = null;
  state.pendingTool = null;
  setRunState();
  addMsg("user", text);
  scroll();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: text,
        taskId: state.taskId ?? undefined,
        agentId: state.agentId || undefined,
        mode: activeAgent()?.mode || "build",
        title: state.taskId ? undefined : text.slice(0, 60),
        ...(state.attached.length > 0 ? { attachments: state.attached } : {}),
      }),
    });
    if (!res.ok || !res.body) {
      toast("فشل الاتصال بالخادم");
      state.streaming = false;
      setRunState();
      return;
    }
    state.attached = [];
    renderChips();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (ev.type === "task") {
          state.taskId = ev.taskId;
          // The POST stream already delivers every event; a second subscription duplicates it.
        } else renderEvent(ev);
        if (ev.type === "done" || ev.type === "cancelled") {
          state.streaming = false;
          setRunState();
        }
      }
    }
  } catch {
    toast("تعذّر الاتصال بالخادم");
  }
  state.streaming = false;
  setRunState();
}

async function stop() {
  if (!state.taskId) return;
  await fetch(`/api/tasks/${encodeURIComponent(state.taskId)}/cancel`, { method: "POST" }).catch(() => null);
  toast("⏳ جارٍ إيقاف المهمة…");
}

function renderChips() {
  const box = $("rkChips");
  if (state.attached.length === 0) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.innerHTML = state.attached
    .map((p) => `<span class="rk-chip"><loam-icon name="attach"></loam-icon> ${esc(p)}<button data-rm="${esc(p)}"><loam-icon name="close"></loam-icon></button></span>`)
    .join("");
  box.querySelectorAll("[data-rm]").forEach((b) => {
    b.onclick = () => {
      state.attached = state.attached.filter((x) => x !== b.dataset.rm);
      renderChips();
    };
  });
}

/* ---------------- controls ---------------- */
function setupComposer() {
  const ta = $("rkPrompt");
  ta.addEventListener("input", () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    setRunState();
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });
  $("rkSend").onclick = () => void send();
  $("rkStop").onclick = () => void stop();
  $("rkNewChat").onclick = () => {
    if (state.streaming) return toast("يوجد تشغيل جارٍ — أوقفه أولاً");
    if (state.es) {
      state.es.close();
      state.es = null;
    }
    state.taskId = null;
    state.attached = [];
    renderChips();
    state.assistantBody = null;
    thread().innerHTML = "";
    showWelcome(activeAgent() ? `ابدأ رسالة جديدة إلى <b>${esc(activeAgent().name)}</b>.` : "ابدأ رسالة جديدة.");
    ta.focus();
  };
  $("rkAttach").onclick = () => {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.multiple = true;
    picker.onchange = async () => {
      if (!state.taskId) {
        try {
          const draft = await fetch("/api/tasks/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: state.agentId || undefined, title: "مهمة رفيق جديدة" }) });
          const data = await draft.json();
          if (!draft.ok || !data.task?.id) throw new Error(data.error || "تعذر إنشاء مساحة المهمة");
          state.taskId = data.task.id;
        } catch (error) { toast(error.message); return; }
      }
      for (const f of [...(picker.files ?? [])]) {
        toast(`جارٍ رفع ${f.name}…`);
        try {
          const res = await fetch(`/api/upload?taskId=${encodeURIComponent(state.taskId)}&name=${encodeURIComponent(f.name)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: f });
          const d = await res.json();
          if (d.path) state.attached.push(d.path);
        } catch {
          toast("فشل الرفع");
        }
      }
      renderChips();
      if (state.attached.length > 0) toast(`أُرفق ${state.attached.length} ملف — ستُرفق تلقائياً بالرسالة`);
    };
    picker.click();
  };
  $("rkMic").onclick = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = $("rkMic");
    if (!SR) return toast("الإدخال الصوتي غير متاح في هذه البيئة");
    if (state.mic) {
      try {
        state.mic.stop();
      } catch {
        /* ignore */
      }
      return;
    }
    const rec = new SR();
    rec.lang = "ar";
    rec.interimResults = false;
    rec.continuous = true;
    state.mic = rec;
    btn.classList.add("rk-rec");
    toast("سامِعك — ابدأ الكلام (انقر مجدداً للإنهاء)");
    const base = ta.value.length;
    rec.onresult = (ev) => {
      let text = "";
      for (const res of ev.results) text += res[0].transcript ?? "";
      ta.value = (base > 0 ? ta.value + " " : "") + String(text).trim();
      ta.dispatchEvent(new Event("input"));
      ta.focus();
    };
    rec.onerror = () => toast("فشل الإدخال الصوتي");
    rec.onend = () => {
      state.mic = null;
      btn.classList.remove("rk-rec");
      setRunState();
    };
    try {
      rec.start();
    } catch (err) {
      state.mic = null;
      btn.classList.remove("rk-rec");
      toast("تعذّر بدء الإدخال الصوتي: " + String(err instanceof Error ? err.message : err));
    }
  };
}

/* ---------------- agents CRUD ---------------- */
async function loadAgents() {
  try {
    const d = await (await fetch("/api/agents")).json();
    state.agents = d.agents ?? [];
  } catch {
    state.agents = [];
  }
  if (state.agentId && !state.agents.some((a) => a.id === state.agentId)) state.agentId = "";
  renderSidebar();
  renderHeader();
}

async function fillModelSelect() {
  const sel = $("rkModelSel");
  if (sel.dataset.ready === "1") return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const d = await (await fetch("/api/models", { signal: ctrl.signal })).json();
    clearTimeout(timer);
    const o0 = document.createElement("option");
    o0.value = "";
    o0.textContent = "(النموذج العام)";
    sel.appendChild(o0);
    for (const m of d.models ?? []) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      sel.appendChild(o);
    }
  } catch {
    if (sel.options.length === 0) {
      const o0 = document.createElement("option");
      o0.value = "";
      o0.textContent = "(النموذج العام)";
      sel.appendChild(o0);
    }
  }
  sel.dataset.ready = "1";
}

async function loadTools(force = false) {
  if (!force && state.tools.length > 0) return;
  try {
    const [d, catalog] = await Promise.all([fetch("/api/tools").then(r=>r.json()), fetch("/api/modes").then(r=>r.json())]);
    state.tools = d.tools ?? [];
    state.modes = catalog.modes ?? [];
    const select = $("rkModeSel");
    const previous = select.value;
    select.innerHTML = state.modes.map(m => `<option value="${esc(m.id)}">${esc(m.labelAr || m.label || m.id)}</option>`).join("");
    select.value = state.modes.some(m => m.id === previous) ? previous : "build";
  } catch {
    state.tools = [];
  }
}

function selectedDisabledTools() {
  const disabled = [];
  for (const row of $("rkToolsList").querySelectorAll(".rk-tool-row")) {
    const cb = row.querySelector("input");
    if (cb && !cb.checked) disabled.push(cb.dataset.tool);
  }
  return disabled;
}

function renderToolsList(disabledSet) {
  const box = $("rkToolsList");
  box.innerHTML = "";
  const mode = state.modes.find(m => m.id === $("rkModeSel").value);
  const allowed = new Set(mode?.availableTools ?? []);
  for (const t of state.tools.filter(t => allowed.has(t.name))) {
    const row = document.createElement("label");
    row.className = "rk-tool-row";
    row.innerHTML = `<input type="checkbox" data-tool="${esc(t.name)}" ${disabledSet.has(t.name) ? "" : "checked"} /><span class="tn">${esc(t.name)}</span><span class="td" title="${esc(t.description)}">${esc(t.description)}</span>`;
    row.querySelector("input").addEventListener("change", syncMaster);
    box.appendChild(row);
  }
  syncMaster();
}

function syncMaster() {
  const cbs = [...$("rkToolsList").querySelectorAll("input")];
  const checked = cbs.filter((c) => c.checked).length;
  $("rkToolsAll").checked = cbs.length > 0 && checked === cbs.length;
  $("rkToolsCount").textContent =
    cbs.length === 0
      ? "لا توجد أدوات متاحة لهذا النمط حالياً"
      : checked === cbs.length
        ? `مفعّلة: كل الأدوات (${cbs.length})`
        : `مفعّلة: ${checked} من ${cbs.length} — المعطّلة لن يستطيع الوكيل استخدامها`;
}

async function openModal(id) {
  state.editingId = id;
  void fillModelSelect();
  await loadTools();
  let disabledSet = new Set();
  if (id) {
    let a = state.agents.find((x) => x.id === id);
    try {
      a = (await (await fetch(`/api/agents/${encodeURIComponent(id)}`)).json()).agent ?? a;
    } catch {
      /* offline */
    }
    disabledSet = new Set(a?.disabledTools ?? []);
    $("rkModalTitle").textContent = "تعديل الوكيل";
    $("rkEmoji").value = a?.emoji ?? "";
    $("rkName").value = a?.name ?? "";
    $("rkDesc").value = a?.description ?? "";
    $("rkInstr").value = a?.instructions ?? "";
    $("rkModelSel").value = a?.model ?? "";
    $("rkModeSel").value = a?.mode ?? "build";
    $("rkEffortSel").value = a?.effort ?? "";
    $("rkDelete").hidden = false;
  } else {
    $("rkModalTitle").textContent = "وكيل جديد";
    $("rkEmoji").value = "";
    $("rkName").value = "";
    $("rkDesc").value = "";
    $("rkInstr").value = "";
    $("rkModelSel").value = "";
    $("rkModeSel").value = "build";
    $("rkEffortSel").value = "";
    $("rkDelete").hidden = true;
  }
  renderToolsList(disabledSet);
  $("rkModal").hidden = false;
  $("rkName").focus();
}

function setupModal() {
  $("rkAddAgent").onclick = () => void openModal(null);
  $("rkModeSel").addEventListener("change", () => renderToolsList(new Set(selectedDisabledTools())));
  $("rkCancel").onclick = () => ($("rkModal").hidden = true);
  $("rkModal").addEventListener("click", (e) => {
    if (e.target === $("rkModal")) $("rkModal").hidden = true;
  });
  $("rkToolsAll").addEventListener("change", () => {
    const on = $("rkToolsAll").checked;
    for (const cb of $("rkToolsList").querySelectorAll("input")) cb.checked = on;
    syncMaster();
  });
  $("rkToolsReload").addEventListener("click", async () => {
    await loadTools(true);
    renderToolsList(new Set(selectedDisabledTools()));
    toast("حُدّثت قائمة أدوات النظام");
  });
  $("rkSave").onclick = async () => {
    if (!state.modes.some(m => m.id === $("rkModeSel").value)) return toast("تعذر تحميل الأنماط؛ حدّث قائمة الأدوات وأعد المحاولة.");
    const name = $("rkName").value.trim();
    if (!name) return toast("اسم الوكيل مطلوب");
    const disabledTools = selectedDisabledTools();
    const body = {
      name,
      emoji: $("rkEmoji").value.trim() || "",
      description: $("rkDesc").value.trim(),
      instructions: $("rkInstr").value.trim(),
      model: $("rkModelSel").value || null,
      mode: $("rkModeSel").value || null,
      effort: $("rkEffortSel").value || null,
      disabledTools,
    };
    const id = state.editingId;
    try {
      const r = await fetch(id ? `/api/agents/${encodeURIComponent(id)}` : "/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok || d.error) return toast(d.error || "فشل حفظ الوكيل");
      $("rkModal").hidden = true;
      await loadAgents();
      if (!id && d.agent) {
        await selectAgent(d.agent.id);
        toast(`أُنشئ الوكيل "${name}" وهو الآن النشط`);
      } else {
        toast(disabledTools.length > 0 ? `حُدّث الوكيل — ${disabledTools.length} أداة معطّلة` : "حُدّث الرفيق — تُطبّق صلاحيات النمط");
        if (id === state.agentId) renderHeader();
      }
    } catch {
      toast("تعذّر الاتصال بالخادم");
    }
  };
  $("rkDelete").onclick = async () => {
    const id = state.editingId;
    if (!id) return;
    try {
      await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (state.agentId === id) {
        state.agentId = "";
        localStorage.setItem("loam-companion", "");
      }
      $("rkModal").hidden = true;
      await loadAgents();
      await loadThreadForAgent();
      toast("حُذف الوكيل");
    } catch {
      toast("تعذّر الحذف");
    }
  };
}

/* ---------------- boot ---------------- */
(async () => {
  setupComposer();
  setupModal();
  await loadTools();
  await loadAgents();
  await loadThreadForAgent();
  setRunState();
  $("rkPrompt").focus();
})();
