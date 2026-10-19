const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const state = {
  taskId: null,
  es: null,
  streaming: false,
  queuedMessage: null,
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
  workModes: [],
  services: [],
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

/* ---------------- tabs + execution location (21) ---------------- */
const tabs = { current: "chat" };
function switchTab(name) {
  tabs.current = name;
  document.querySelectorAll(".rk-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  for (const panel of ["tasks", "device", "files", "memory", "skills", "perms"]) {
    const el = $("rkPanel-" + panel);
    if (el) el.hidden = panel !== name;
  }
  const composerEl = document.querySelector(".rk-composer");
  const showChat = name === "chat";
  const threadEl = thread();
  if (threadEl) threadEl.style.display = showChat ? "" : "none";
  if (composerEl) composerEl.style.display = showChat ? "" : "none";
  const vb = $("rkVoiceBar");
  const vt = $("rkVoiceTranscript");
  if (vb) vb.hidden = !showChat;
  if (vt) vt.hidden = !showChat || vt.dataset.forceOpen !== "1";
  if (name === "tasks") void tasksRender();
  if (name === "device") void deviceTabRender();
  if (name === "files") void filesRender();
  if (name === "memory") void memoryTabRender();
  if (name === "skills") void skillsRender();
  if (name === "perms") void permsRender();
}
function setupTabs() {
  document.querySelectorAll(".rk-tab").forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });
  $("rkFilesUp").onclick = () => { const p = $("rkFilesPath").value.trim(); $("rkFilesPath").value = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) || "." : "."; void filesRender(); };
  $("rkFilesGo").onclick = () => void filesRender();
  $("rkFilesList").addEventListener("click", (e) => {
    const row = e.target.closest("[data-file]");
    if (!row) return;
    if (row.dataset.dir === "1") { $("rkFilesPath").value = ($("rkFilesPath").value === "." ? "" : $("rkFilesPath").value) + "/" + row.dataset.file; void filesRender(); }
  });
  $("rkTaskCreate").onclick = async () => {
    const title = $("rkNewTaskTitle").value.trim();
    if (!title || !activeAgent()) return toast("اكتب عنوان المهمة");
    try {
      const res = await fetch("/api/tasks/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, agentId: state.agentId }) });
      if (!res.ok) throw new Error((await res.json()).error || "HTTP " + res.status);
      $("rkNewTaskTitle").value = "";
      toast("أُنشئت المهمة لدى هذا الرفيق");
      await tasksRender();
    } catch (e) { toast(e.message); }
  };
}
function updateExecBar() {
  const wm = $("rkWorkModeSel")?.value ?? activeAgent()?.workMode ?? "loam";
  const def = state.workModes.find((m) => m.id === wm);
  const dot = $("rkExecDot");
  $("rkExecWhere").textContent = def ? "ينفّذ: " + def.labelAr : "ينفّذ داخل Loam";
  dot.className = "rk-exec-dot" + (wm === "own_device" ? " device" : wm === "user_device" ? " host" : "");
  $("rkExecDevice").textContent = dev.device ? "جهازه: " + (dev.device.state === "running" ? "يعمل" : dev.device.state === "provisioning" ? "قيد التجهيز" : dev.device.state) : "";
}
async function tasksRender() {
  if (!activeAgent()) return;
  try {
    const { tasks } = await (await fetch("/api/tasks?agentId=" + encodeURIComponent(state.agentId))).json();
    $("rkTasksList").innerHTML = (tasks ?? []).slice(0, 40).map((t) => {
      const stColor = t.status === "done" ? "#2da44e" : t.status === "error" ? "var(--err)" : t.status === "running" ? "#d29922" : "var(--muted)";
      return '<div class="rk-task-row"><span class="st" style="color:' + stColor + ";border-color:" + stColor + '">' + esc(t.status) + '</span><span class="grow">' + esc(t.title ?? "") + '</span><a class="rk-btn" href="/#/tasks" target="_blank">فتح</a></div>';
    }).join("") || '<div class="rk-tools-count">لا مهام بعد</div>';
  } catch (e) { $("rkTasksList").innerHTML = '<div class="rk-tools-count">' + esc(e.message) + "</div>"; }
}
async function deviceTabRender() {
  const box = $("rkDeviceTabBody");
  if (!activeAgent()) { box.innerHTML = '<div class="rk-tools-count">اختر رفيقًا أولًا</div>'; return; }
  await devRefresh();
  const d = dev.device;
  box.innerHTML = d
    ? '<div class="rk-dev-state"><b>' + esc(d.name) + '</b> <span class="st ' + esc(d.state) + '">' + esc(stateLabel[d.state] ?? d.state) + '</span> <span>' + esc(templateLabel[d.template] ?? d.template) + " • " + d.resources.cpus + " أنوية / " + Math.round(d.resources.memoryMB / 1024) + "GB</span></div>" +
      '<div class="rk-row rk-dev-actions" style="margin-top:10px"><button class="rk-btn primary" id="rkTabDevOpen">اللوحة الكاملة + البث الحي</button><button class="rk-btn" id="rkTabDevSnap">نقطة استعادة الآن</button></div>' +
      '<div class="rk-tools-count" style="margin-top:8px">' + (d.snapshots ?? []).length + " نقطة استعادة • " + (d.lastError ? "آخر خطأ: " + esc(d.lastError) : "بلا أخطاء") + "</div>"
    : '<div class="rk-tools-count">لا جهاز بعد — أنشئه من اللوحة الكاملة.</div><div class="rk-row" style="margin-top:8px"><button class="rk-btn primary" id="rkTabDevCreate">إنشاء جهاز (اللوحة الكاملة)</button></div>';
  $("rkTabDevOpen")?.addEventListener("click", () => { $("rkDeviceBtn").click(); $("rkGuiOpen")?.click(); });
  $("rkTabDevSnap")?.addEventListener("click", async () => {
    if (!dev.device) return;
    try { await devApi("/" + encodeURIComponent(dev.device.id) + "/snapshot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "من تبويب الجهاز" }) }); toast("أُنشئت نقطة استعادة"); await deviceTabRender(); } catch (e) { toast(e.message); }
  });
  $("rkTabDevCreate")?.addEventListener("click", () => $("rkDeviceBtn").click());
  updateExecBar();
}
async function filesRender() {
  if (!activeAgent()) return;
  try {
    const tasks = (await (await fetch("/api/tasks?agentId=" + encodeURIComponent(state.agentId))).json()).tasks ?? [];
    const latest = tasks[0];
    if (!latest) { $("rkFilesList").innerHTML = '<div class="rk-tools-count">لا مساحة مهمة بعد لهذا الرفيق</div>'; return; }
    const rel = $("rkFilesPath").value.trim() || ".";
    const res = await fetch("/api/tasks/" + encodeURIComponent(latest.id) + "/files?path=" + encodeURIComponent(rel === "." ? "" : rel));
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "HTTP " + res.status);
    $("rkFilesList").innerHTML = (d.files ?? []).map((f) => '<div class="rk-file-row' + (f.dir ? " dir" : "") + '" data-file="' + esc(f.name) + '" data-dir="' + (f.dir ? 1 : 0) + '">' + (f.dir ? "📁" : "📄") + " " + esc(f.name) + (f.dir ? "" : ' <span style="color:var(--muted);margin-inline-start:auto">' + f.bytes + "B</span>") + "</div>").join("") || '<div class="rk-tools-count">مجلد فارغ — ملفات آخر مهمة («' + esc(latest.title ?? "") + "»)</div>";
  } catch (e) { $("rkFilesList").innerHTML = '<div class="rk-tools-count">' + esc(e.message) + "</div>"; }
}
async function memoryTabRender() {
  const box = $("rkMemoryTabBody");
  if (!activeAgent()) { box.innerHTML = '<div class="rk-tools-count">اختر رفيقًا أولًا</div>'; return; }
  box.innerHTML = '<div class="rk-row"><button class="rk-btn primary" id="rkTabMemOpen">فتح لوحة الذاكرة الكاملة (مصدر/ثقة/استبدال/تصدير)</button></div><div class="rk-dev-list" id="rkTabMemList" style="margin-top:10px"></div>';
  $("rkTabMemOpen").onclick = () => $("rkMemoryBtn").click();
  try {
    const { entries } = await (await fetch("/api/agents/" + encodeURIComponent(state.agentId) + "/memory")).json();
    $("rkTabMemList").innerHTML = (entries ?? []).slice(0, 12).map((e) => '<div class="rk-mem-row"><span class="grow"><b>' + esc(e.text.slice(0, 90)) + "</b><span class=\"rk-tools-count\">" + esc(kindLabel[e.kind] ?? e.kind) + " • " + (e.source === "user" ? "قاله المستخدم" : "استنتاج") + " • ثقة " + Number(e.confidence).toFixed(2) + "</span></span></div>").join("") || '<div class="rk-tools-count">ذاكرته فارغة بعد</div>';
  } catch { /* offline */ }
}
async function skillsRender() {
  if (!activeAgent()) return;
  try {
    const { skills } = await (await fetch("/api/skills")).json();
    $("rkSkillsList").innerHTML = (skills ?? []).slice(0, 40).map((s) => '<div class="rk-skill-row">🧩 <b style="direction:ltr;display:inline-block">' + esc(s.name) + "</b> — " + esc(String(s.description ?? "").slice(0, 90)) + "</div>").join("") || '<div class="rk-tools-count">لا مهارات مثبتة — وما يتعلّمه هذا الرفيق من طريقة عملك يظهر هنا موسومًا باسمه</div>';
  } catch (e) { $("rkSkillsList").innerHTML = '<div class="rk-tools-count">' + esc(e.message) + "</div>"; }
}
async function permsRender() {
  const box = $("rkPermsTabBody");
  const agent = activeAgent();
  if (!agent) { box.innerHTML = '<div class="rk-tools-count">اختر رفيقًا أولًا — الصلاحيات لكل مساعد</div>'; return; }
  try {
    const { capabilities } = await (await fetch("/api/agents/" + encodeURIComponent(agent.id))).json();
    box.innerHTML =
      '<div class="rk-dev-note">قدرات هذا الرفيق فعليًا حسب نمطه الافتراضي (' + esc(agent.mode ?? "build") + ") ووضع عمله (" + esc(agent.workMode ?? "loam") + ") — " + capabilities.allow.length + " أداة مسموحة</div>" +
      '<div class="rk-dev-list" style="margin-top:10px;max-height:220px">' + (capabilities.services ?? []).map((s2) => '<div class="rk-perm-row"><span class="grow">' + esc(s2.labelAr) + '</span><span class="chip ' + (s2.status === "allowed" ? "ok" : "no") + '">' + (s2.status === "allowed" ? "مسموح" : s2.status === "blocked_workmode" ? "مسحوب بالوضع" : s2.status === "blocked_service" ? "غير ممنوح" : "غير متاح") + "</span></div>").join("") + "</div>" +
      '<div class="rk-row" style="margin-top:10px"><button class="rk-btn primary" id="rkTabPermsEdit">تعديل المنح والوضع</button><button class="rk-btn" id="rkTabPermsSecrets">الأسرار</button></div>';
    $("rkTabPermsEdit").onclick = () => openModal(agent.id);
    $("rkTabPermsSecrets").onclick = () => $("rkSecretsBtn").click();
  } catch (e) { box.innerHTML = '<div class="rk-tools-count">' + esc(e.message) + "</div>"; }
}

/* ---------------- voice (section 13): per-companion speech ---------------- */
function speakText(text, btn) {
  const synth = window.speechSynthesis;
  if (!synth) return toast("محرك النطق غير متاح في هذه البيئة");
  if (synth.speaking) { synth.cancel(); return; }
  const agent = activeAgent();
  const u = new SpeechSynthesisUtterance(text.slice(0, 1200));
  const voices = synth.getVoices();
  const chosen = voices.find((v) => agent?.voice && v.name === agent.voice) ?? voices.find((v) => v.lang?.startsWith("ar")) ?? voices[0];
  if (chosen) u.voice = chosen;
  u.lang = chosen?.lang || "ar";
  u.rate = agent?.voiceRate || 1;
  if (btn) { u.onstart = () => btn.classList.add("rk-rec"); u.onend = () => btn.classList.remove("rk-rec"); }
  synth.speak(u);
}
function fillVoiceSelect(selected) {
  const sel = $("rkVoiceSel");
  const voices = (window.speechSynthesis?.getVoices?.() ?? []).slice(0, 60);
  const prev = selected ?? sel.value;
  sel.innerHTML = '<option value="">(صوت النظام العربي الأول)</option>' + voices.map((v) => '<option value="' + esc(v.name) + '">' + esc(v.name) + " — " + esc(v.lang) + "</option>").join("");
  if (prev && voices.some((v) => v.name === prev)) sel.value = prev;
}

/* ---------------- rendering (Rakazo bubbles) ---------------- */
function addMsg(role, text) {
  clearWelcome();
  const wrap = document.createElement("div");
  wrap.className = `rk-msg ${role}`;
  const b = document.createElement("div");
  b.className = "rk-bubble";
  b.textContent = text;
  wrap.appendChild(b);
  if (role === "assistant") {
    const sp = document.createElement("button");
    sp.className = "rk-speak";
    sp.title = "نطق بصوت المساعد";
    sp.textContent = "🔊";
    sp.onclick = () => speakText(b.textContent || "", sp);
    wrap.appendChild(sp);
    if (activeAgent()?.voiceAuto) speakText(b.textContent || "");
  }
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
      if (voice.active) { voice._tokensSeen = (voice._tokensSeen || 0) + 1; voiceEnqueueSentences(ev.text); }
      if (stick()) scroll();
      break;
    case "assistant_message":
      assistantBubble().textContent = ev.text;
      state.assistantBody = null;
      if (voice.active && ev.text) {
        // A reply that never streamed tokens has nothing queued yet — speak the full text.
        if (voice._tokensSeen) voiceEnqueueSentences("", true);
        else voiceEnqueueSentences(ev.text, true);
        voice._tokensSeen = 0;
        voiceLogTurn("companion", ev.text, "reply");
        voiceRenderTranscript();
      }
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
    case "workmode": {
      const note = addNote(`وضع العمل: ${ev.labelAr}${ev.deviceRequired ? " — ينفّذ على جهازه المستقل" : ""}`, "");
      if (ev.deviceId) {
        const btn = document.createElement("button");
        btn.className = "rk-btn";
        btn.style.cssText = "margin-top:6px;display:inline-flex;align-items:center;gap:6px";
        btn.innerHTML = '<loam-icon name="terminal"></loam-icon> افتح جهاز المساعد';
        btn.onclick = () => { $("rkDeviceBtn")?.click(); setTimeout(() => { if (!$("rkGuiWrap").hidden) return; $("rkGuiOpen")?.click(); }, 300); };
        note.appendChild(document.createElement("br"));
        note.appendChild(btn);
      }
      break;
    }
    case "plan_step":
      planStep(ev);
      break;
    case "approval_required":
      addNote(`⏳ ${ev.summary} — القرار من مركز الموافقات`, "");
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
    const wmLabel = state.workModes.find((m) => m.id === (a.workMode || "loam"))?.labelAr ?? "";
    const meta = [a.description, wmLabel, a.model ? a.model.replace(/^orcarouter\//, "") : "", a.mode === "ask" ? "استكشاف" : a.mode === "build" ? "إنجاز" : ""]
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
  const workModeLabel = (id) => state.workModes.find((m) => m.id === id)?.labelAr ?? "";
  if (a) void loadUsage(a.id);
  const chip = $("rkUsageChip"); if (chip) chip.textContent = "";
  $("rkHeadSub").textContent = a
    ? [a.description || "وكيل مخصص", workModeLabel(a.workMode || "loam"), a.model ? a.model.replace(/^orcarouter\//, "") : "", a.mode === "ask" ? "Ask" : a.mode === "build" ? "Build" : "", toolSummary(a)]
        .filter(Boolean)
        .join(" • ")
    : `Loam — ${workModeLabel("loam")} • ${toolSummary(null)}`;
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
  syncComposerWorkMode();
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
    else {
      // A queued message that never ran (crash/restart) surfaces here so it
      // isn't silently lost — offer the user to re-send it.
      const lastUser = (task.messages ?? []).filter((m) => m.role === "user").at(-1);
      const hasReply = (task.steps ?? []).some((s) => s.data?.type === "assistant_message") || (task.messages ?? []).some((m) => m.role === "assistant" && m.content.trim());
      if (lastUser && !hasReply && ["error", "cancelled", "interrupted"].includes(task.status)) {
        addNote(`آخر رسالة لم تُعالج (${task.status}) — انقر الإرسال لإعادة محاولة: «${lastUser.content.slice(0, 80)}»`, "");
        const ta = document.getElementById("rkPrompt");
        if (ta && !ta.value.trim()) ta.value = lastUser.content;
      }
    }
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
  if (state.streaming) {
    // Keep the typed message instead of discarding it; it goes out as soon as the current reply stops.
    if (!text) return toast("اكتب رسالتك أولاً");
    state.queuedMessage = text;
    ta.value = "";
    ta.style.height = "auto";
    setRunState();
    toast("ستُرسل رسالتك تلقائيًا بعد انتهاء الرد الجاري");
    return;
  }
  if (!text) return toast("اكتب رسالتك أولاً");
  if (state.es) { state.es.close(); state.es = null; }
  ta.value = "";
  ta.style.height = "auto";
  state.streaming = true;
  state.assistantBody = null;
  state.pendingTool = null;
  voice._tokensSeen = 0;
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
        workMode: $("rkWorkModeSel").value || activeAgent()?.workMode || "loam",
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
  const queued = state.queuedMessage;
  if (queued) {
    state.queuedMessage = null;
    $("rkPrompt").value = queued;
    void send();
  }
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
async function loadUsage(agentId) {
  try {
    const { usage } = await (await fetch(`/api/agents/${encodeURIComponent(agentId)}/usage`)).json();
    const el = $("rkUsageChip");
    if (el) el.textContent = usage.runs > 0 ? `جولات: ${usage.runs} • رموز: ${(usage.promptTokens + usage.completionTokens).toLocaleString("ar")}` : "لا جولات بعد";
  } catch { /* offline */ }
}

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

async function loadWorkModes(force = false) {
  if (!force && state.workModes.length > 0) return;
  try {
    const d = await (await fetch("/api/work-modes")).json();
    state.workModes = d.workModes ?? [];
    state.services = d.services ?? [];
  } catch {
    state.workModes = [];
    state.services = [];
    return;
  }
  const fill = (sel) => {
    const previous = sel.value;
    sel.innerHTML = state.workModes.map((m) => `<option value="${esc(m.id)}">${esc(m.labelAr)}</option>`).join("");
    if (state.workModes.some((m) => m.id === previous)) sel.value = previous;
  };
  fill($("rkWorkModeSel"));
  fill($("rkAgentWorkModeSel"));
  syncComposerWorkMode();
}

function syncComposerWorkMode() {
  const sel = $("rkWorkModeSel");
  if (!sel || state.workModes.length === 0) return;
  const agent = activeAgent();
  const wanted = agent?.workMode || "loam";
  if (state.workModes.some((m) => m.id === wanted)) sel.value = wanted;
  $("rkWorkModeSel").dispatchEvent(new Event("change"));
}

function updateWorkModeHint() {
  const sel = $("rkWorkModeSel");
  const hint = $("rkWorkModeHint");
  const def = state.workModes.find((m) => m.id === sel.value);
  hint.textContent = def ? def.description : "";
  hint.classList.toggle("requires-device", Boolean(def?.requiresDevice));
}

function selectedAllowedServices() {
  const selected = [];
  for (const row of $("rkServicesList").querySelectorAll(".rk-tool-row")) {
    const cb = row.querySelector("input");
    if (cb && cb.checked) selected.push(cb.dataset.service);
  }
  return selected;
}

function renderServicesList(allowedSet) {
  const box = $("rkServicesList");
  box.innerHTML = "";
  for (const s of state.services) {
    const row = document.createElement("label");
    row.className = "rk-tool-row";
    const toolsNote = s.availableToolCount > 0 ? `${s.availableToolCount}/${s.tools.length} أداة مسجلة` : "لا أدوات مسجلة بعد";
    row.innerHTML = `<input type="checkbox" data-service="${esc(s.id)}" ${allowedSet === null || allowedSet.has(s.id) ? "checked" : ""} /><span class="tn">${esc(s.labelAr)}</span><span class="td" title="${esc(s.description)}">${esc(s.description)}</span><span style="font-size:11px;color:var(--muted)">${esc(toolsNote)}</span>`;
    row.querySelector("input").addEventListener("change", syncServicesMaster);
    box.appendChild(row);
  }
  syncServicesMaster();
}

function syncServicesMaster() {
  const cbs = [...$("rkServicesList").querySelectorAll("input")];
  const checked = cbs.filter((c) => c.checked).length;
  $("rkServicesAll").checked = cbs.length > 0 && checked === cbs.length;
  $("rkServicesCount").textContent =
    cbs.length === 0
      ? "تعذر تحميل الخدمات"
      : checked === cbs.length
        ? `مسموح: كل الخدمات (${cbs.length})`
        : `مسموح: ${checked} من ${cbs.length} — الخدمات غير المحددة لن تصل إلى الرفيق`;
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
  await loadWorkModes();
  let disabledSet = new Set();
  let allowedSet = null;
  if (id) {
    let a = state.agents.find((x) => x.id === id);
    try {
      a = (await (await fetch(`/api/agents/${encodeURIComponent(id)}`)).json()).agent ?? a;
    } catch {
      /* offline */
    }
    disabledSet = new Set(a?.disabledTools ?? []);
    if (Array.isArray(a?.allowedServices) && a.allowedServices.length > 0) allowedSet = new Set(a.allowedServices);
    $("rkModalTitle").textContent = "تعديل الوكيل";
    $("rkEmoji").value = a?.emoji ?? "";
    $("rkName").value = a?.name ?? "";
    $("rkDesc").value = a?.description ?? "";
    $("rkInstr").value = a?.instructions ?? "";
    $("rkModelSel").value = a?.model ?? "";
    $("rkModeSel").value = a?.mode ?? "build";
    $("rkEffortSel").value = a?.effort ?? "";
    $("rkAgentWorkModeSel").value = a?.workMode || "loam";
    fillVoiceSelect(a?.voice || "");
    $("rkVoiceAuto").checked = Boolean(a?.voiceAuto);
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
    $("rkAgentWorkModeSel").value = "loam";
    fillVoiceSelect("");
    $("rkVoiceAuto").checked = false;
    $("rkDelete").hidden = true;
  }
  renderToolsList(disabledSet);
  renderServicesList(allowedSet);
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
  $("rkServicesAll").addEventListener("change", () => {
    const on = $("rkServicesAll").checked;
    for (const cb of $("rkServicesList").querySelectorAll("input")) cb.checked = on;
    syncServicesMaster();
  });
  $("rkWorkModeSel").addEventListener("change", () => { updateWorkModeHint(); updateExecBar(); });
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
    const services = selectedAllowedServices();
    const allServices = state.services.length > 0 && services.length === state.services.length;
    const body = {
      name,
      emoji: $("rkEmoji").value.trim() || "",
      description: $("rkDesc").value.trim(),
      instructions: $("rkInstr").value.trim(),
      model: $("rkModelSel").value || null,
      mode: $("rkModeSel").value || null,
      effort: $("rkEffortSel").value || null,
      disabledTools,
      workMode: $("rkAgentWorkModeSel").value || "loam",
      voice: $("rkVoiceSel").value || null,
      voiceAuto: $("rkVoiceAuto").checked,
      allowedServices: allServices ? [] : services,
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

/* ---------------- companion device panel (stage 2) ---------------- */
const dev = {
  open: false,
  timer: null,
  device: null,
  providers: null,
};
const stateLabel = { provisioning: "قيد التجهيز", running: "يعمل", stopped: "موقوف", suspended: "معلّق", error: "خطأ" };
const templateLabel = { research: "بحث", coding: "برمجة", office: "أوفيس", design: "تصميم" };

async function devApi(path, opts) {
  const res = await fetch(`/api/companion-devices${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function devRefresh() {
  const agent = activeAgent();
  if (!agent) return;
  try {
    const root = await devApi("");
    dev.providers = root;
    const mine = (root.devices ?? []).find((d) => d.agentId === agent.id) ?? null;
    dev.device = mine;
    devRender();
    updateExecBar();
  } catch (error) {
    $("rkDevProviders").textContent = `تعذر تحميل حالة الأجهزة: ${error.message}`;
  }
}

function devRender() {
  const agent = activeAgent();
  $("rkDevTitle").textContent = `جهاز ${agent?.name ?? "المساعد"} المستقل`;
  const p = dev.providers;
  if (p) {
    const bits = [
      p.wsl ? "WSL2 متاح" : "WSL2 غير متاح",
      p.hyperv ? "Hyper-V متاح" : null,
      p.fake ? "وضع تحقق (محاكاة عدّاء)" : null,
      p.goldenReady ? "صورة الأساس جاهزة" : "صورة الأساس غير مُجهزة",
    ].filter(Boolean);
    $("rkDevProviders").textContent = bits.join(" • ");
  }
  const d = dev.device;
  $("rkDevNone").hidden = Boolean(d);
  $("rkDevInfo").hidden = !d;
  if (!d) {
    const sel = $("rkDevTemplate");
    if (sel.options.length === 0) {
      sel.innerHTML = (p?.templates ?? []).map((t) => `<option value="${esc(t.id)}">${esc(t.labelAr)} — ${esc(t.description)}</option>`).join("");
    }
    return;
  }
  const stateEl = $("rkDevState");
  stateEl.innerHTML = `<b>${esc(d.name)}</b> <span class="st ${esc(d.state)}">${esc(stateLabel[d.state] ?? d.state)}</span>
    <span>${esc(templateLabel[d.template] ?? d.template)} • ${d.environment === "linux" ? "Linux" : "Windows"} • ${d.resources.cpus} أنوية / ${Math.round(d.resources.memoryMB / 1024)}GB ذاكرة / ${d.resources.diskGB}GB قرص</span>
    ${d.controlHeldBy === "user" ? '<span class="st provisioning">المستخدم يتولى التحكم</span>' : ""}`;
  if (d.lastError) stateEl.innerHTML += `<div class="rk-tools-count" style="color:var(--err)">${esc(d.lastError)}</div>`;
  $("rkSnapList").innerHTML = (d.snapshots ?? [])
    .map(
      (s) =>
        `<div class="rk-dev-snap"><span class="grow" title="${esc(s.file)}">🧷 ${esc(s.label)} — ${esc(s.at.slice(0, 16).replace("T", " "))} (${Math.max(1, Math.round(s.bytes / 1024))}KB)</span><button class="rk-btn" data-restore="${esc(s.id)}">استعادة</button> <a class="rk-btn" href="/api/companion-devices/${encodeURIComponent(d.id)}/file?path=${encodeURIComponent("/home/loam")}" hidden></a></div>`,
    )
    .join("") || '<div class="rk-tools-count">لا نقاط استعادة بعد</div>';
  $("rkSnapList").querySelectorAll("[data-restore]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("ستُستبدل حالة الجهاز الحالية بنقطة الاستعادة — متابعة؟")) return;
      try {
        await devApi(`/${encodeURIComponent(d.id)}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ snapshotId: b.dataset.restore }) });
        toast("استُعيدت نقطة الاستعادة");
        await devRefresh();
      } catch (error) { toast(error.message); }
    };
  });
}

async function devPollStats() {
  const d = dev.device;
  if (!dev.open || !d || d.state !== "running") return;
  try {
    const { stats, costNote } = await devApi(`/${encodeURIComponent(d.id)}/stats`);
    $("rkDevStats").textContent = `الذاكرة: ${stats.memoryFreeMB ?? "?"}MB حرة من ${stats.memoryTotalMB ?? "?"}MB • القرص: ${stats.disk ?? "?"} • ${costNote}`;
  } catch {
    $("rkDevStats").textContent = "";
  }
}

function setupDevicePanel() {
  $("rkDeviceBtn").onclick = async () => {
    if (!activeAgent()) return toast("اختر رفيقًا من القائمة أولًا — الجهاز يُنشأ لمساعد محدد");
    dev.open = true;
    $("rkDeviceModal").hidden = false;
    $("rkDevTemplate").innerHTML = "";
    await devRefresh();
    await devPollStats();
    await devBrowse();
    await devJournal();
    clearInterval(dev.timer);
    dev.timer = setInterval(() => { void devRefresh(); void devPollStats(); }, 4000);
  };
  $("rkDevClose").onclick = () => {
    dev.open = false;
    clearInterval(dev.timer);
    $("rkDeviceModal").hidden = true;
  };
  $("rkDeviceModal").addEventListener("click", (e) => {
    if (e.target === $("rkDeviceModal")) $("rkDevClose").onclick();
  });
  $("rkDevCreate").onclick = async () => {
    try {
      await devApi("", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: state.agentId, template: $("rkDevTemplate").value || "coding", name: $("rkDevName").value.trim() || undefined }) });
      toast("بدأ تجهيز الجهاز — تُحدَّث الحالة تلقائيًا");
      await devRefresh();
    } catch (error) { toast(error.message); }
  };
  const lifecycle = async (action) => {
    if (!dev.device) return;
    try { await devApi(`/${encodeURIComponent(dev.device.id)}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); await devRefresh(); }
    catch (error) { toast(error.message); }
  };
  $("rkDevStart").onclick = () => void lifecycle("start");
  $("rkDevStop").onclick = () => void lifecycle("stop");
  $("rkDevSuspend").onclick = () => void lifecycle("suspend");
  $("rkDevResume").onclick = () => void lifecycle("resume");
  $("rkDevDelete").onclick = async () => {
    if (!dev.device) return;
    if (!confirm("حذف الجهاز سيُلغي تسجيله ويمحو كل ملفاته ونقاط استعادته نهائيًا — متابعة؟")) return;
    try {
      await devApi(`/${encodeURIComponent(dev.device.id)}?confirm=true`, { method: "DELETE" });
      toast("حُذف الجهاز");
      await devRefresh();
    } catch (error) { toast(error.message); }
  };
  $("rkSnapCreate").onclick = async () => {
    if (!dev.device) return;
    try {
      await devApi(`/${encodeURIComponent(dev.device.id)}/snapshot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: $("rkSnapLabel").value.trim() }) });
      toast("أُنشئت نقطة الاستعادة");
      await devRefresh();
    } catch (error) { toast(error.message); }
  };
  $("rkDevBrowse").onclick = () => void devBrowse();
  $("rkDevUpload").onclick = () => {
    if (!dev.device) return;
    const picker = document.createElement("input");
    picker.type = "file";
    picker.onchange = async () => {
      const f = picker.files?.[0];
      if (!f) return;
      try {
        const res = await fetch(`/api/companion-devices/${encodeURIComponent(dev.device.id)}/file?path=${encodeURIComponent(f.name)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: f });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        toast(`رُفع ${f.name} → ${data.path}`);
        await devBrowse();
      } catch (error) { toast(`فشل الرفع: ${error.message}`); }
    };
    picker.click();
  };
  $("rkDevTake").onclick = async () => {
    if (!dev.device) return;
    const holding = dev.device.controlHeldBy === "user";
    try {
      await devApi(`/${encodeURIComponent(dev.device.id)}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ take: !holding }) });
      toast(holding ? "أُعيد التحكم للمساعد" : "تولّيت التحكم — أوامر المساعد مؤجلة");
      await devRefresh();
    } catch (error) { toast(error.message); }
  };
  // ---- live screen viewer (MJPEG stream + manual input under control hold) ----
  const guiSend = async (payload) => {
    if (!dev.device) return false;
    try {
      const res = await fetch(`/api/companion-devices/${encodeURIComponent(dev.device.id)}/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast(data.error || `HTTP ${res.status}`); return false; }
      return true;
    } catch (error) { toast(error.message); return false; }
  };
  $("rkGuiOpen").onclick = async () => {
    if (!dev.device) return toast("لا يوجد جهاز بعد");
    toast("جارٍ تشغيل سطح المكتب داخل الجهاز…");
    try {
      await devApi(`/${encodeURIComponent(dev.device.id)}/gui-ensure`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    } catch (error) { return toast(error.message); }
    $("rkGuiWrap").hidden = false;
    $("rkGuiInputRow").hidden = false;
    $("rkGuiStop").hidden = false;
    $("rkGuiImg").src = `/api/companion-devices/${encodeURIComponent(dev.device.id)}/stream?intervalMs=1200&r=${Date.now()}`;
    void guiWindowsLoad();
  };
  $("rkGuiStop").onclick = () => {
    $("rkGuiImg").src = "";
    $("rkGuiWrap").hidden = true;
    $("rkGuiInputRow").hidden = true;
    $("rkGuiStop").hidden = true;
  };
  $("rkGuiRefresh").onclick = () => {
    if (!dev.device) return;
    $("rkGuiWrap").hidden = false;
    $("rkGuiImg").src = `/api/companion-devices/${encodeURIComponent(dev.device.id)}/screen?r=${Date.now()}`;
  };
  $("rkGuiImg").onclick = (e) => {
    const img = $("rkGuiImg");
    if (!img.naturalWidth || !dev.device) return;
    const rect = img.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * img.naturalWidth);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * img.naturalHeight);
    void guiSend({ type: e.button === 2 ? "rightclick" : e.shiftKey ? "doubleclick" : "click", x, y });
  };
  $("rkGuiImg").oncontextmenu = (e) => e.preventDefault();
  $("rkGuiTypeSend").onclick = () => {
    const text = $("rkGuiType").value;
    if (!text.trim()) return;
    void guiSend({ type: "type", text }).then((ok) => { if (ok) $("rkGuiType").value = ""; });
  };
  $("rkGuiKeySend").onclick = () => {
    const key = $("rkGuiKey").value.trim();
    if (!key) return;
    void guiSend({ type: "key", key });
  };
  const guiWindowsLoad = async () => {
    if (!dev.device) return;
    try {
      const { windows } = await devApi(`/${encodeURIComponent(dev.device.id)}/windows`);
      const box = $("rkGuiWindows");
      box.hidden = false;
      box.innerHTML = (windows ?? []).map((w) => `<div>🪟 ${esc(w.title)} <span style="color:var(--muted)">(desktop ${w.desktop})</span></div>`).join("") || '<div class="rk-tools-count">لا نوافذ مفتوحة</div>';
    } catch { /* offline */ }
  };
  $("rkGuiWindowsBtn").onclick = () => void guiWindowsLoad();
  $("rkDevRun").onclick = async () => {
    if (!dev.device) return;
    const command = $("rkDevCmd").value.trim();
    if (!command) return;
    try {
      const { result } = await devApi(`/${encodeURIComponent(dev.device.id)}/exec`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command }) });
      $("rkDevConsole").textContent = `$ ${command}\n${[result.stdout, result.stderr].filter(Boolean).join("\n") || "(لا مخرجات)"}\n(exit ${result.code})`;
      await devJournal();
    } catch (error) { $("rkDevConsole").textContent = `$ ${command}\n✗ ${error.message}`; }
  };
}

async function devBrowse() {
  if (!dev.device) return;
  try {
    const { listing } = await devApi(`/${encodeURIComponent(dev.device.id)}/files?path=${encodeURIComponent($("rkDevPath").value.trim() || "/home/loam")}`);
    $("rkDevListing").textContent = listing;
    $("rkDevListing").querySelectorAll?.("");
  } catch (error) {
    $("rkDevListing").textContent = error.message;
  }
}

async function devJournal() {
  if (!dev.device) return;
  try {
    const { journal } = await devApi(`/${encodeURIComponent(dev.device.id)}`);
    $("rkDevJournal").innerHTML = (journal ?? [])
      .slice(-25)
      .reverse()
      .map((e) => `<div>${e.ok ? "✔" : "✗"} <span style="color:var(--muted)">${esc(e.at.slice(11, 19))}</span> [${esc(e.kind)}] ${esc(e.event)}${e.detail ? ` — ${esc(String(e.detail).slice(0, 90))}` : ""}</div>`)
      .join("") || '<div class="rk-tools-count">لا سجل بعد</div>';
  } catch {
    /* ignore */
  }
}

/* ---------------- approvals center + secrets vault (section 18) ---------------- */
async function approvalsRender() {
  try {
    const { approvals } = await (await fetch("/api/approvals")).json();
    const badge = $("rkApprovalsBadge");
    badge.hidden = (approvals ?? []).length === 0;
    badge.textContent = String((approvals ?? []).length);
    const box = $("rkApprovalsList");
    box.innerHTML = (approvals ?? []).map((a) =>
      '<div class="rk-mem-row" data-id="' + esc(a.id) + '"><span class="grow"><b>' + esc(a.tool) + "</b><span class=\"rk-tools-count\">" + esc(a.summary) + " • " + esc(a.createdAt.slice(11, 19)) + "</span></span>" +
      '<button class="rk-btn primary" data-approve="' + esc(a.id) + '">موافقة</button>' +
      '<button class="rk-btn danger" data-deny="' + esc(a.id) + '">رفض</button></div>'
    ).join("") || '<div class="rk-tools-count">لا قرارات معلّقة</div>';
    box.querySelectorAll("[data-approve]").forEach((b) => { b.onclick = async () => { await fetch("/api/approvals/" + encodeURIComponent(b.dataset.approve), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approve" }) }); toast("وُافق — سيتابع المساعد الإجراء"); await approvalsRender(); }; });
    box.querySelectorAll("[data-deny]").forEach((b) => { b.onclick = async () => { await fetch("/api/approvals/" + encodeURIComponent(b.dataset.deny), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "deny" }) }); toast("رُفض الإجراء"); await approvalsRender(); }; });
  } catch { /* offline */ }
}
function setupApprovalsPanel() {
  $("rkApprovalsBtn").onclick = async () => { $("rkApprovalsModal").hidden = false; await approvalsRender(); };
  $("rkApprovalsClose").onclick = () => ($("rkApprovalsModal").hidden = true);
  $("rkApprovalsModal").addEventListener("click", (e) => { if (e.target === $("rkApprovalsModal")) $("rkApprovalsClose").onclick(); });
  setInterval(() => void approvalsRender(), 5000);
}
async function secretsRender() {
  if (!activeAgent()) return;
  try {
    const { secrets } = await (await fetch("/api/agents/" + encodeURIComponent(state.agentId) + "/secrets")).json();
    const box = $("rkSecretsList");
    box.innerHTML = (secrets ?? []).map((s) =>
      '<div class="rk-mem-row"><span class="grow"><b style="direction:ltr;display:inline-block">' + esc(s.name) + '</b><span class="rk-tools-count">أُضيف ' + esc(s.at.slice(0, 10)) + " — القيمة محفوظة مشفرة ولا تُعرض</span></span>" +
      '<button class="rk-btn danger" data-del="' + esc(s.name) + '">حذف</button></div>'
    ).join("") || '<div class="rk-tools-count">لا أسرار بعد — أضف رموز الوصول التي يحتاجها هذا المساعد داخل جهازه.</div>';
    box.querySelectorAll("[data-del]").forEach((b) => { b.onclick = async () => { if (!confirm("حذف هذا السر نهائيًا؟")) return; await fetch("/api/agents/" + encodeURIComponent(state.agentId) + "/secrets?name=" + encodeURIComponent(b.dataset.del), { method: "DELETE" }); await secretsRender(); }; });
  } catch (error) { $("rkSecretsList").innerHTML = '<div class="rk-tools-count">' + esc(error.message) + "</div>"; }
}
function setupSecretsPanel() {
  $("rkSecretsBtn").onclick = async () => {
    if (!activeAgent()) return toast("اختر رفيقًا أولًا");
    $("rkSecretsModal").hidden = false;
    await secretsRender();
  };
  $("rkSecretsClose").onclick = () => ($("rkSecretsModal").hidden = true);
  $("rkSecretsModal").addEventListener("click", (e) => { if (e.target === $("rkSecretsModal")) $("rkSecretsClose").onclick(); });
  $("rkSecretAdd").onclick = async () => {
    const name = $("rkSecretName").value.trim();
    const value = $("rkSecretValue").value;
    if (!name || !value) return toast("الاسم والقيمة مطلوبان");
    const res = await fetch("/api/agents/" + encodeURIComponent(state.agentId) + "/secrets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, value }) });
    const d = await res.json();
    if (!res.ok) return toast(d.error || "فشل الحفظ");
    $("rkSecretName").value = ""; $("rkSecretValue").value = "";
    toast("حُفظ السر مشفرًا — لن تظهر القيمة مجددًا");
    await secretsRender();
  };
}

/* ---------------- bidirectional voice conversation (section 13) ---------------- */
const voice = {
  active: false,
  rec: null,
  ttsQueue: [],
  speaking: false,
  lastPartialAt: 0,
  turnsRendered: 0,
};
function voiceLogTurn(speaker, text, end) {
  const body = { speaker, text, ...(end ? { end } : {}) };
  void fetch("/api/agents/" + encodeURIComponent(state.agentId || "none") + "/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
}
function voiceRenderTranscript() {
  const box = $("rkVoiceTranscript");
  if (!box || box.hidden) return;
  void (async () => {
    try {
      const { turns } = await (await fetch("/api/agents/" + encodeURIComponent(state.agentId || "none") + "/voice")).json();
      box.innerHTML = (turns ?? []).slice(-40).map((t) => '<div class="rk-voice-turn"><b>' + (t.speaker === "user" ? "🗣 المستخدم" : "🤖 " + esc(activeAgent()?.name ?? "المساعد")) + "</b> <span style=\"color:var(--muted)\">" + esc((t.at ?? "").slice(11, 19)) + (t.end ? " • " + esc(t.end) : "") + "</span><br/>" + esc(t.text) + "</div>").join("") || '<div class="rk-tools-count">لا تفريغ بعد</div>';
      box.dataset.forceOpen = "1";
    } catch { /* offline */ }
  })();
}
// Sentence-by-sentence TTS: speak completed sentences while tokens still stream.
function voiceEnqueueSentences(text, flush = false) {
  // Hold the trailing fragment until sentence punctuation (or the final message) completes it.
  voice._pendingSentence = (voice._pendingSentence || "") + String(text ?? "");
  const parts = voice._pendingSentence.split(/(?<=[.!?؟।])\s+/);
  voice._pendingSentence = flush ? "" : (parts.pop() || "");
  for (const p of parts) if (p.trim()) voice.ttsQueue.push(p.trim());
  if (flush && voice._pendingSentence.trim()) { voice.ttsQueue.push(voice._pendingSentence.trim()); voice._pendingSentence = ""; }
  void voicePump();
}
async function voicePump() {
  if (voice.speaking || voice.ttsQueue.length === 0) return;
  const sentence = voice.ttsQueue.shift();
  const synth = window.speechSynthesis;
  if (!synth || !sentence) return;
  voice.speaking = true;
  await new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(sentence);
    const agent = activeAgent();
    const voices = synth.getVoices();
    const chosen = voices.find((v) => agent?.voice && v.name === agent.voice) ?? voices.find((v) => v.lang?.startsWith("ar")) ?? voices[0];
    if (chosen) u.voice = chosen;
    u.lang = chosen?.lang || "ar";
    u.rate = agent?.voiceRate || 1;
    u.onend = resolve;
    u.onerror = resolve;
    synth.speak(u);
    voice._current = u;
  });
  voice.speaking = false;
  void voicePump();
}
function voiceBargeIn() {
  // The user started talking while the companion speaks (or the reply is still streaming)
  // → yield immediately and stop the run, even before the first spoken token.
  const audible = Boolean(window.speechSynthesis?.speaking || voice.speaking || voice.ttsQueue.length || voice._pendingSentence);
  if (audible) {
    window.speechSynthesis?.cancel();
    voice.ttsQueue = [];
    voice.speaking = false;
    voice._pendingSentence = "";
  }
  if (audible || state.streaming) {
    $("rkVoiceStatus").textContent = "تمت المقاطعة — أستمع إليك";
    if (state.streaming) { try { $("rkStop")?.click(); } catch { /* stop control optional */ } }
  }
}
function voiceStopAll() {
  voice.ttsQueue = [];
  voice.speaking = false;
  voice._pendingSentence = "";
  window.speechSynthesis?.cancel();
}
async function voiceSessionStart() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast("محرك التعرف الصوتي غير متاح في هذه البيئة");
  if (!activeAgent()) return toast("اختر رفيقًا أولًا");
  voice.active = true;
  $("rkVoiceBar").dataset.on = "1";
  $("rkVoiceBar").hidden = false;
  $("rkVoiceMicBtn").textContent = "⏹ إنهاء المحادثة الصوتية";
  $("rkVoiceMicBtn").classList.add("on");
  $("rkVoiceLive").hidden = false;
  $("rkVoiceTranscript").hidden = false;
  $("rkVoiceTranscript").dataset.forceOpen = "1";
  const rec = new SR();
  rec.lang = "ar";
  rec.continuous = true;
  rec.interimResults = true;
  voice.rec = rec;
  rec.onresult = (ev) => {
    let interim = "";
    let finalText = "";
    for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (interim.trim()) {
      voice.lastPartialAt = Date.now();
      voiceBargeIn(); // any speech from the user interrupts the companion
    }
    if (finalText.trim()) {
      const text = finalText.trim();
      $("rkVoiceStatus").textContent = "سمعتك: " + text.slice(0, 60);
      voiceLogTurn("user", text, "silence");
      const ta = $("rkPrompt");
      ta.value = text;
      void send();
      voiceRenderTranscript();
    } else if (interim.trim()) {
      $("rkVoiceStatus").textContent = "… " + interim.slice(-60);
    }
  };
  rec.onerror = () => { $("rkVoiceStatus").textContent = "خطأ ميكروفون — أعيد المحاولة"; };
  rec.onend = () => {
    if (voice.active) { try { rec.start(); } catch { /* restarted */ } }
  };
  try { rec.start(); $("rkVoiceStatus").textContent = "محادثة صوتية مفتوحة — تكلّم حرًّا، والمقاطعة توقف ردّي فورًا"; }
  catch (e) { toast("تعذّر بدء الميكروفون"); voiceSessionStop(); }
}
function voiceSessionStop() {
  voice.active = false;
  try { voice.rec?.stop(); } catch { /* ignore */ }
  voice.rec = null;
  voiceStopAll();
  $("rkVoiceMicBtn").textContent = "🎙 بدء محادثة صوتية";
  $("rkVoiceMicBtn").classList.remove("on");
  $("rkVoiceLive").hidden = true;
  $("rkVoiceStatus").textContent = "انتهت الجلسة الصوتية";
  delete $("rkVoiceTranscript").dataset.forceOpen;
}
function setupVoiceSession() {
  $("rkVoiceMicBtn").onclick = () => (voice.active ? voiceSessionStop() : void voiceSessionStart());
  $("rkVoiceTranscriptBtn").onclick = () => {
    const box = $("rkVoiceTranscript");
    box.hidden = !box.hidden;
    if (!box.hidden) { box.dataset.forceOpen = "1"; voiceRenderTranscript(); }
    else delete box.dataset.forceOpen;
  };
  $("rkVoiceClearBtn").onclick = async () => {
    if (!confirm("حذف تفريغ المحادثة الصوتية لهذا الرفيق؟")) return;
    await fetch("/api/agents/" + encodeURIComponent(state.agentId || "none") + "/voice", { method: "DELETE" }).catch(() => null);
    voiceRenderTranscript();
  };
}

/* ---------------- companion memory panel (stage 4a) ---------------- */
const mem = { open: false };
const kindLabel = { preference: "تفضيل", instruction: "تعليم", fact: "حقيقة", inference: "استنتاج" };

async function memApi(path, opts) {
  const res = await fetch(`/api/agents/${encodeURIComponent(state.agentId)}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function memRender() {
  const a = activeAgent();
  $("rkMemTitle").textContent = `ذاكرة ${a?.name ?? "المساعد"}`;
  try {
    const q = $("rkMemSearch").value.trim();
    const { entries } = await memApi(`/memory${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    $("rkMemList").innerHTML =
      (entries ?? [])
        .map(
          (e) => `<div class="rk-mem-row" data-id="${esc(e.id)}">
            <span class="grow">
              <b>${esc(e.text)}</b>
              <span class="rk-tools-count">${esc(kindLabel[e.kind] ?? e.kind)} • ${e.source === "user" ? "قاله المستخدم" : "استنتاج المساعد"} • ثقة ${Number(e.confidence).toFixed(2)} • ${esc(e.at.slice(0, 10))}${e.supersededBy ? " • مستبدلة" : ""}${e.expiresAt ? ` • تنتهي ${esc(e.expiresAt.slice(0, 10))}` : ""}</span>
            </span>
            <button class="rk-btn" data-edit="${esc(e.id)}" title="تعديل">✎</button>
            <button class="rk-btn" data-super="${esc(e.id)}" title="استبدال بذكرى جديدة (تعارض)">⇄</button>
            <button class="rk-btn danger" data-del="${esc(e.id)}" title="حذف">🗑</button>
          </div>`,
        )
        .join("") || '<div class="rk-tools-count">لا ذكريات بعد — أضف تفضيلات المستخدم ليتذكرها هذا المساعد في كل جولة.</div>';
    $("rkMemList").querySelectorAll("[data-edit]").forEach((b) => {
      b.onclick = async () => {
        const text = prompt("النص الجديد للذكرى:");
        if (!text) return;
        try { await memApi(`/memory/${encodeURIComponent(b.dataset.edit)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }); await memRender(); }
        catch (error) { toast(error.message); }
      };
    });
    $("rkMemList").querySelectorAll("[data-super]").forEach((b) => {
      b.onclick = async () => {
        const text = prompt("الذكرى الصحيحة الجديدة (ستُعلَّم القديمة كمستبدلة):");
        if (!text) return;
        try { await memApi(`/memory/supersede`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entryId: b.dataset.super, text }) }); toast("عُولج التعارض: حُفظت الذكرى الجديدة ووُسمت القديمة"); await memRender(); }
        catch (error) { toast(error.message); }
      };
    });
    $("rkMemList").querySelectorAll("[data-del]").forEach((b) => {
      b.onclick = async () => {
        if (!confirm("حذف هذه الذكرى نهائيًا؟")) return;
        try { await memApi(`/memory/${encodeURIComponent(b.dataset.del)}`, { method: "DELETE" }); await memRender(); }
        catch (error) { toast(error.message); }
      };
    });
  } catch (error) {
    $("rkMemList").innerHTML = `<div class="rk-tools-count">${esc(error.message)}</div>`;
  }
}

function setupMemoryPanel() {
  $("rkMemoryBtn").onclick = async () => {
    if (!activeAgent()) return toast("اختر رفيقًا أولًا — الذاكرة خاصة بكل مساعد");
    mem.open = true;
    $("rkMemoryModal").hidden = false;
    await memRender();
  };
  $("rkMemClose").onclick = () => {
    mem.open = false;
    $("rkMemoryModal").hidden = true;
  };
  $("rkMemoryModal").addEventListener("click", (e) => {
    if (e.target === $("rkMemoryModal")) $("rkMemClose").onclick();
  });
  $("rkMemSearch").addEventListener("input", () => {
    clearTimeout(setupMemoryPanel._t);
    setupMemoryPanel._t = setTimeout(() => void memRender(), 250);
  });
  $("rkMemAdd").onclick = async () => {
    const text = $("rkMemText").value.trim();
    if (!text) return;
    try {
      await memApi("/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, kind: $("rkMemKind").value }) });
      $("rkMemText").value = "";
      toast("حُفظت الذكرى في ذاكرة هذا المساعد");
      await memRender();
    } catch (error) { toast(error.message); }
  };
  $("rkMemExportBtn").onclick = () => { window.open(`/api/agents/${encodeURIComponent(state.agentId)}/memory/export`, "_blank"); };
  $("rkMemImportBtn").onclick = () => {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = ".json";
    picker.onchange = async () => {
      const f = picker.files?.[0];
      if (!f) return;
      try {
        const { imported, skipped } = await memApi("/memory/import", { method: "POST", headers: { "content-type": "application/json" }, body: await f.text() });
        toast(`استُوردت ${imported} ذكرى${skipped ? ` (تخطي ${skipped})` : ""}`);
        await memRender();
      } catch (error) { toast(error.message); }
    };
    picker.click();
  };
}

/* ---------------- boot ---------------- */
(async () => {
  setupComposer();
  setupTabs();
  setupVoiceSession();
  if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = () => fillVoiceSelect($("rkVoiceSel").value);
  for(const [name,setup] of [["modal",setupModal],["device",setupDevicePanel],["memory",setupMemoryPanel],["approvals",setupApprovalsPanel],["secrets",setupSecretsPanel]]){try{setup();}catch(error){console.warn("تعذّر تهيئة لوحة "+name+":",error);}}
  await loadTools();
  await loadWorkModes();
  await loadAgents();
  await loadThreadForAgent();
  switchTab("chat");
  setRunState();
  $("rkPrompt").focus();
})();
