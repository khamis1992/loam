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
