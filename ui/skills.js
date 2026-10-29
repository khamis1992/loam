/* Skills page — creative rewrite.
 * Tabs (installed / catalog) + category chips + Loam icons + drawer editor + toasts.
 * Same API surface as before: /api/skills*, /api/skills/catalog, /api/skills/one. */

const $ = (id) => document.getElementById(id);
let editing = null;
let installed = [];
let catalogTotal = 0;

/* ---------- helpers ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(msg, kind) {
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function skeletons(box, n = 6) {
  box.innerHTML = Array.from({ length: n }, () => '<div class="skeleton"></div>').join("");
}

const emptyState = (title, sub, icon) =>
  `<div class="empty" style="grid-column:1/-1">
     <loam-icon name="skills"></loam-icon>
     <div style="font-weight:600;font-size:14px;color:var(--text)">${esc(title)}</div>
     <div style="font-size:12.5px;margin-top:4px">${esc(sub)}</div>
   </div>`;

/* ---------- tabs ---------- */
for (const b of document.querySelectorAll(".sk-tab")) {
  b.onclick = () => {
    document.querySelectorAll(".sk-tab").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === b.dataset.tab));
    if (b.dataset.tab === "catalog" && !$("catalogGrid").dataset.loaded) void loadCatalog();
  };
}

/* ---------- installed ---------- */
async function loadInstalled() {
  try {
    const r = await fetch("/api/skills");
    const data = await r.json();
    installed = data.skills ?? [];
    $("stInstalled").textContent = String(installed.length);
    renderInstalled();
  } catch (err) {
    toast("تعذّر تحميل المهارات: " + err.message, "err");
  }
}

function renderInstalled() {
  const q = ($("filterInstalled").value || "").trim().toLowerCase();
  const list = q ? installed.filter((s) => (s.name + " " + (s.description || "")).toLowerCase().includes(q)) : installed;
  const box = $("installedGrid");
  if (list.length === 0) {
    box.innerHTML = emptyState(
      installed.length === 0 ? "لا توجد مهارات بعد" : "لا نتائج",
      installed.length === 0 ? "أنشئ مهارة أو ثبّت واحدة من الكتالوج" : "جرّب كلمة أخرى",
      '<path d="M12 3v18M3 12h18" stroke-linecap="round" opacity=".4"/><circle cx="12" cy="12" r="9"/>',
    );
    return;
  }
  box.innerHTML = list
    .map(
      (s) => `
    <article class="sk-card">
      <div class="sk-head">
        <div class="avatar"><loam-icon name="skills"></loam-icon></div>
        <div style="min-width:0">
          <div class="sk-name">${esc(s.name)}</div>
          <div class="sk-id">skills/${esc(s.name)}</div>
        </div>
      </div>
      <div class="sk-desc">${esc(s.description || "بلا وصف")}</div>
      <div class="sk-actions">
        <button data-edit="${esc(s.name)}">تعديل</button>
        <button class="ghost" data-del="${esc(s.name)}">حذف</button>
      </div>
    </article>`,
    )
    .join("");
  box.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => void openEditor(b.dataset.edit)));
  box.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => void removeSkill(b.dataset.del)));
}

/* ---------- catalog ---------- */
async function loadCatalog(query = "", refresh = false) {
  const box = $("catalogGrid");
  skeletons(box, 6);
  try {
    const params = new URLSearchParams({ q: query, limit: "60", describe: "10" });
    if (refresh) params.set("refresh", "1");
    const data = await (await fetch("/api/skills/catalog?" + params.toString())).json();
    if (data.error) {
      box.innerHTML = emptyState("تعذّر الوصول للكتالوج", data.error, '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>');
      toast("الكتالوج: " + data.error, "err");
      return;
    }
    catalogTotal = data.total ?? 0;
    $("stCatalog").textContent = String(catalogTotal);
    box.dataset.loaded = "1";
    const skills = data.skills ?? [];
    if (skills.length === 0) {
      box.innerHTML = emptyState("لا نتائج", "جرّب كلمة أوسع مثل pdf أو web", '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>');
      return;
    }
    box.innerHTML = skills
      .map(
        (s) => `
      <article class="sk-card">
        <div class="sk-head">
          <div class="avatar"><loam-icon name="skills"></loam-icon></div>
          <div style="min-width:0">
            <div class="sk-name">${esc(s.id.split("/").pop() || s.id)}</div>
            <div class="sk-id">${esc(s.id)}</div>
          </div>
          <span class="badge" style="margin-inline-start:auto">${s.files ?? 0} ملف</span>
        </div>
        <div class="sk-desc">${esc(s.description || "")}</div>
        <div class="sk-actions"><button class="primary" data-install="${esc(s.id)}">تثبيت</button></div>
      </article>`,
      )
      .join("");
    box.querySelectorAll("[data-install]").forEach((b) => (b.onclick = () => void installSkill(b.dataset.install, b)));
  } catch (err) {
    box.innerHTML = emptyState("تعذّر الاتصال", "تأكّد من الإنترنت", '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>');
    toast("تعذّر الاتصال: " + err.message, "err");
  }
}

async function loadCategories() {
  try {
    const data = await (await fetch("/api/skills/catalog?limit=200&describe=0")).json();
    const counts = new Map();
    for (const s of data.skills ?? []) {
      const c = s.id.split("/")[0];
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
    $("cats").innerHTML =
      `<button class="cat active" data-cat="">الكل</button>` +
      top.map(([c, n]) => `<button class="cat" data-cat="${esc(c)}">${esc(c)}<span>${n}</span></button>`).join("");
    $("cats").querySelectorAll(".cat").forEach((b) => {
      b.onclick = () => {
        $("cats").querySelectorAll(".cat").forEach((x) => x.classList.toggle("active", x === b));
        $("catalogQuery").value = b.dataset.cat;
        void loadCatalog(b.dataset.cat);
      };
    });
    $("stCatalog").textContent = String(data.total ?? 0);
  } catch {
    /* leave chips empty */
  }
}

/* ---------- mutations ---------- */
async function installSkill(id, btn) {
  const label = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "جارٍ التثبيت…";
  }
  toast("جارٍ تثبيت " + id + " …");
  try {
    const data = await (
      await fetch("/api/skills/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      })
    ).json();
    if (data.error) {
      toast("خطأ: " + data.error, "err");
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
      return;
    }
    toast(`تم تثبيت ${id} (${(data.files ?? []).length} ملف)`, "ok");
    if (btn) btn.innerHTML = 'مثبّتة <loam-icon name="check"></loam-icon>';
    await loadInstalled();
  } catch (err) {
    toast("تعذّر الاتصال: " + err.message, "err");
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

async function removeSkill(name) {
  toast("جارٍ حذف " + name + " …");
  try {
    const data = await (
      await fetch("/api/skills/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      })
    ).json();
    if (!data.ok) return toast("خطأ: " + (data.message || "فشل الحذف"), "err");
    toast("أُزيلت " + name, "ok");
    if (editing === name) closeEditor();
    await loadInstalled();
  } catch (err) {
    toast("تعذّر الاتصال: " + err.message, "err");
  }
}

/* ---------- drawer editor ---------- */
function openEditor(name) {
  if (!name) {
    editing = null;
    $("drawerTitle").textContent = "مهارة جديدة";
    $("fName").value = "";
    $("fName").disabled = false;
    $("fDesc").value = "";
    $("fBody").value = "";
    $("drawerSave").textContent = "حفظ";
  } else {
    editing = name;
    $("drawerTitle").textContent = "تعديل: " + name;
    $("fName").value = name;
    $("fName").disabled = true;
    $("fDesc").value = "";
    $("fBody").value = "";
    $("drawerSave").textContent = "حفظ التعديل";
    void fetch("/api/skills/one?name=" + encodeURIComponent(name))
      .then((r) => r.json())
      .then((d) => {
        $("fDesc").value = d.description ?? "";
        $("fBody").value = d.body ?? "";
      })
      .catch(() => toast("تعذّر تحميل المهارة", "err"));
  }
  $("scrim").classList.add("on");
  $("drawer").classList.add("on");
  setTimeout(() => $("fName").focus(), 150);
}

function closeEditor() {
  $("scrim").classList.remove("on");
  $("drawer").classList.remove("on");
  editing = null;
}

async function saveSkill() {
  const name = ($("fName").value || "").trim();
  const description = ($("fDesc").value || "").trim();
  const body = $("fBody").value;
  if (!name) return toast("الاسم مطلوب", "err");
  if (!description) return toast("الوصف مطلوب", "err");
  $("drawerSave").disabled = true;
  try {
    const data = editing
      ? await (
          await fetch("/api/skills/update", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: editing, description, body }),
          })
        ).json()
      : await (
          await fetch("/api/skills", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, description, content: body, location: $("fLoc").value }),
          })
        ).json();
    if (!data.ok) return toast("خطأ: " + (data.message || "فشل الحفظ"), "err");
    toast(editing ? "تم تحديث " + editing : "أُنشئت " + name, "ok");
    closeEditor();
    await loadInstalled();
  } catch (err) {
    toast("تعذّر الاتصال: " + err.message, "err");
  } finally {
    $("drawerSave").disabled = false;
  }
}

/* ---------- wiring ---------- */
$("newSkill").onclick = () => openEditor(null);
$("filterInstalled").oninput = () => renderInstalled();
$("catalogRefresh").onclick = () => void loadCatalog($("catalogQuery").value.trim(), true);
$("drawerClose").onclick = closeEditor;
$("drawerCancel").onclick = closeEditor;
$("scrim").onclick = closeEditor;
$("drawerSave").onclick = () => void saveSkill();

let t = null;
$("catalogQuery").oninput = () => {
  clearTimeout(t);
  t = setTimeout(() => void loadCatalog($("catalogQuery").value.trim()), 350);
};
$("catalogQuery").addEventListener("keydown", (e) => {
  if (e.key === "Enter") void loadCatalog($("catalogQuery").value.trim());
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("drawer").classList.contains("on")) {
    e.stopPropagation();
    closeEditor();
  }
});

void loadInstalled();
void loadCategories();

/* ========================================================================
 * السوق — unified install grid (bridges + connectors + skills).
 * Phase-2 W6: additive section. Every action reuses the endpoint its own
 * surface already uses: /api/bridges* (integrations page bridges API),
 * /api/connectors* (connectors routes), /api/skills/catalog + install.
 * No new server endpoints.
 * ====================================================================== */
const MARKET_KINDS = [
  { id: "", label: "الكل" },
  { id: "skills", label: "مهارات" },
  { id: "bridges", label: "جسور" },
  { id: "connectors", label: "موصلات" },
];
const BRIDGE_STATUS_AR = {
  ready: "جاهز",
  disabled: "معطّل",
  missing: "غير مثبّت",
  error: "خطأ",
};
let marketItems = []; // {kind, id, name, desc, ...raw}
let marketKind = "";
let marketLoaded = false;

function marketChips() {
  const box = $("marketCats");
  box.innerHTML = MARKET_KINDS.map(
    (k) =>
      `<button class="cat${k.id === marketKind ? " active" : ""}" data-kind="${k.id}">${k.label}<span>${
        k.id ? marketItems.filter((i) => i.kind === k.id).length : marketItems.length
      }</span></button>`,
  ).join("");
  box.querySelectorAll(".cat").forEach(
    (b) =>
      (b.onclick = () => {
        marketKind = b.dataset.kind;
        renderMarket();
      }),
  );
}

function marketCard(item) {
  if (item.kind === "skills") {
    return `
      <article class="sk-card" data-kind="skills">
        <div class="sk-head">
          <div class="avatar"><loam-icon name="skills"></loam-icon></div>
          <div style="min-width:0">
            <div class="sk-name">${esc(item.name)}</div>
            <div class="sk-id">${esc(item.id)}</div>
          </div>
          <span class="badge" style="margin-inline-start:auto">مهارة</span>
        </div>
        <div class="sk-desc">${esc(item.desc || "")}</div>
        <div class="sk-actions"><button class="primary" data-mkt-skill="${esc(item.id)}">تثبيت</button></div>
      </article>`;
  }
  if (item.kind === "bridges") {
    const on = item.enabled;
    return `
      <article class="sk-card" data-kind="bridges">
        <div class="sk-head">
          <div class="avatar"><loam-icon name="terminal"></loam-icon></div>
          <div style="min-width:0">
            <div class="sk-name">${esc(item.name)}</div>
            <div class="sk-id">bridge/${esc(item.id)}</div>
          </div>
          <span class="badge" style="margin-inline-start:auto">${esc(BRIDGE_STATUS_AR[item.status] || item.status)}</span>
        </div>
        <div class="sk-desc">${esc(item.desc || "")}${item.version ? ` — <span dir="ltr">${esc(item.version)}</span>` : ""}</div>
        <div class="sk-actions">
          <button class="${on ? "ghost" : "primary"}" data-mkt-bridge="${esc(item.id)}" data-on="${on ? "1" : ""}">${on ? "إيقاف" : "تفعيل"}</button>
          <button class="ghost" data-mkt-bridge-skill="${esc(item.id)}">توليد مهارة</button>
        </div>
      </article>`;
  }
  /* connectors */
  const connected = item.connected;
  const hint = item.configured
    ? connected
      ? `متصل بحساب ${esc(item.account || "")}`
      : "مهيأ — اضغط ربط لبدء تسجيل الدخول"
    : `يحتاج متغيرات البيئة: ${esc((item.envVars || []).join("، "))}`;
  return `
      <article class="sk-card" data-kind="connectors">
        <div class="sk-head">
          <div class="avatar"><loam-icon name="integrations"></loam-icon></div>
          <div style="min-width:0">
            <div class="sk-name">${esc(item.name)}</div>
            <div class="sk-id">connector/${esc(item.id)}</div>
          </div>
          <span class="badge" style="margin-inline-start:auto">${connected ? "متصل" : item.configured ? "غير متصل" : "غير مهيأ"}</span>
        </div>
        <div class="sk-desc">${hint}</div>
        <div class="sk-actions">
          ${connected
            ? `<button class="ghost" data-mkt-conn-off="${esc(item.id)}">فصل</button>`
            : `<button class="primary" data-mkt-conn="${esc(item.id)}"${item.configured ? "" : " disabled"}>ربط</button>`}
        </div>
      </article>`;
}

function renderMarket() {
  marketChips();
  const box = $("marketGrid");
  const list = marketKind ? marketItems.filter((i) => i.kind === marketKind) : marketItems;
  if (list.length === 0) {
    box.innerHTML = emptyState("لا عناصر في السوق", "تحقق من تشغيل الخدمة أو أعد التحديث", "");
    return;
  }
  box.innerHTML = list.map(marketCard).join("");
  box.querySelectorAll("[data-mkt-skill]").forEach((b) => (b.onclick = () => void installSkill(b.dataset.mktSkill, b)));
  box.querySelectorAll("[data-mkt-bridge]").forEach(
    (b) =>
      (b.onclick = () =>
        void toggleBridge(b.dataset.mktBridge, b.dataset.on !== "1")),
  );
  box.querySelectorAll("[data-mkt-bridge-skill]").forEach((b) => (b.onclick = () => void bridgeSkill(b.dataset.mktBridgeSkill)));
  box.querySelectorAll("[data-mkt-conn]").forEach((b) => (b.onclick = () => void connectConnector(b.dataset.mktConn)));
  box.querySelectorAll("[data-mkt-conn-off]").forEach((b) => (b.onclick = () => void disconnectConnector(b.dataset.mktConnOff)));
}

async function loadMarket() {
  const box = $("marketGrid");
  skeletons(box, 6);
  /* Skills: same catalog source the catalog tab reads (top of the index). */
  const [skillsRes, bridgesRes, connectorsRes] = await Promise.allSettled([
    fetch("/api/skills/catalog?" + new URLSearchParams({ limit: "24", describe: "6" })).then((r) => r.json()),
    fetch("/api/bridges").then((r) => r.json()),
    fetch("/api/connectors").then((r) => r.json()),
  ]);
  const items = [];
  if (bridgesRes.status === "fulfilled" && Array.isArray(bridgesRes.value.bridges)) {
    for (const b of bridgesRes.value.bridges)
      items.push({ kind: "bridges", id: b.id, name: b.name, desc: b.description, enabled: b.enabled, status: b.status, version: b.version });
  } else {
    toast("تعذّر تحميل الجسور", "err");
  }
  if (connectorsRes.status === "fulfilled" && Array.isArray(connectorsRes.value.connectors)) {
    for (const c of connectorsRes.value.connectors)
      items.push({ kind: "connectors", id: c.id, name: c.name, connected: c.connected, configured: c.configured, account: c.account, envVars: c.envVars });
  } else {
    toast("تعذّر تحميل الموصلات", "err");
  }
  if (skillsRes.status === "fulfilled" && Array.isArray(skillsRes.value.skills)) {
    for (const s of skillsRes.value.skills)
      items.push({ kind: "skills", id: s.id, name: s.id.split("/").pop() || s.id, desc: s.description });
  } else {
    toast("تعذّر تحميل مهارات السوق", "err");
  }
  marketItems = items;
  marketLoaded = true;
  $("stMarket").textContent = String(items.length);
  renderMarket();
}

/* Bridges: same /api/bridges surface the integrations bridges API serves. */
async function toggleBridge(id, on) {
  toast(on ? "جارٍ تفعيل الجسر " + id + " …" : "جارٍ إيقاف الجسر " + id + " …");
  try {
    const data = await (
      await fetch("/api/bridges/" + encodeURIComponent(id), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: on }),
      })
    ).json();
    if (data.error) return toast("خطأ: " + data.error, "err");
    const info = data.bridge;
    const idx = marketItems.findIndex((i) => i.kind === "bridges" && i.id === id);
    if (idx >= 0 && info) marketItems[idx] = { kind: "bridges", id: info.id, name: info.name, desc: info.description, enabled: info.enabled, status: info.status, version: info.version };
    toast(on ? "فُعّل الجسر " + id : "أُوقف الجسر " + id, "ok");
    renderMarket();
  } catch (err) {
    toast("تعذّر الاتصال: " + err.message, "err");
  }
}

async function bridgeSkill(id) {
  toast("جارٍ توليد مهارة الجسر " + id + " …");
  try {
    const data = await (
      await fetch("/api/bridges/" + encodeURIComponent(id) + "/skill", { method: "POST" })
    ).json();
    if (data.error) return toast("خطأ: " + data.error, "err");
    toast("أُنشئت مهارة الجسر: " + (data.file || id), "ok");
    await loadInstalled();
  } catch (err) {
    toast("تعذّر الاتصال: " + err.message, "err");
  }
}

/* Connectors: same /api/connectors connect/disconnect routes the services page uses. */
async function connectConnector(id) {
  toast("جارٍ بدء ربط " + id + " …");
  try {
    const data = await (
      await fetch("/api/connectors/" + encodeURIComponent(id) + "/connect", { method: "POST" })
    ).json();
    if (data.error) return toast("خطأ: " + data.error, "err");
    if (data.authUrl) window.open(data.authUrl, "_blank");
    toast("أكمل تسجيل الدخول في النافذة الجديدة ثم حدّث السوق", "ok");
  } catch (err) {
    toast("تعذّر الاتصال: " + err.message, "err");
  }
}

async function disconnectConnector(id) {
  toast("جارٍ فصل " + id + " …");
  try {
    const data = await (
      await fetch("/api/connectors/" + encodeURIComponent(id) + "/disconnect", { method: "POST" })
    ).json();
    if (data.error || !data.ok) return toast("خطأ: " + (data.error || "فشل الفصل"), "err");
    toast("فُصل " + id, "ok");
    await loadMarket();
  } catch (err) {
    toast("تعذّر الاتصال: " + err.message, "err");
  }
}

document.querySelector('.sk-tab[data-tab="market"]').addEventListener("click", () => {
  if (!marketLoaded) void loadMarket();
});
$("marketRefresh").onclick = () => void loadMarket();
