const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function status(msg, kind) {
  const el = $("status");
  el.textContent = msg;
  el.className = kind || "";
}

function fmtDate(iso) {
  return String(iso ?? "").replace("T", " ").slice(0, 16);
}

function badges(items, cls) {
  return (items ?? []).map((t) => `<span class="chip">${esc(cls ? `${cls}:` : "")}${esc(t)}</span>`).join(" ");
}

async function load() {
  status("جارٍ تحميل لقطة الذاكرة…");
  let data;
  try {
    const res = await fetch("/api/brain?episodes=15&facts=15&skills=50");
    data = await res.json();
    if (data.error) {
      status("خادم memory-skills غير متاح: " + data.error, "err");
      return;
    }
  } catch (err) {
    status("تعذّر الاتصال بالخادم: " + err.message, "err");
    return;
  }
  status("");
  $("generatedAt").textContent = "آخر تحديث: " + fmtDate(data.generatedAt);

  const stats = data.stats ?? {};
  const chips = [];
  chips.push(`<span class="chip">حلقات: ${Number(stats.total ?? 0)}</span>`);
  chips.push(`<span class="chip">آخر 7 أيام: ${Number(stats.last7d ?? 0)}</span>`);
  for (const [k, v] of Object.entries(stats.byOutcome ?? {})) chips.push(`<span class="chip">${esc(k)}: ${Number(v)}</span>`);
  for (const t of stats.topTags ?? []) chips.push(`<span class="chip">#${esc(t.tag)} ×${t.count}</span>`);
  for (const t of stats.topTools ?? []) chips.push(`<span class="chip"><loam-icon name="build"></loam-icon> ${esc(t.tool)} ×${t.count}</span>`);
  $("stats").innerHTML = chips.join(" ") || '<span class="desc">لا بيانات بعد.</span>';

  const review = data.review ?? [];
  $("reviewCount").textContent = review.length > 0 ? `(${review.length})` : "";
  if (review.length === 0) {
    $("review").innerHTML = '<div class="desc">لا شيء يحتاج انتباهاً حالياً.</div>';
  } else {
    $("review").innerHTML = "";
    for (const item of review) {
      const row = document.createElement("div");
      row.className = "item";
      row.innerHTML = `<div class="head"><span class="id">${esc(item.slug)}</span><span class="desc">أولوية ${Number(item.priority)} · استخدام ${Number(item.uses)}</span><div class="grow"></div></div>
        <div class="desc">${esc((item.reasons ?? []).join(" · "))}</div>`;
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = "تحسين الآن";
      btn.onclick = () => void improve(item.slug, btn);
      row.querySelector(".head").appendChild(btn);
      $("review").appendChild(row);
    }
  }

  const episodes = data.episodes ?? [];
  if (episodes.length === 0) {
    $("episodes").innerHTML = '<div class="desc">لا حلقات بعد — ستُسجَّل أول مهمة تلقائياً عند اكتمالها.</div>';
  } else {
    $("episodes").innerHTML = "";
    for (const e of episodes) {
      const row = document.createElement("div");
      row.className = "item";
      const lessons = (e.lessons ?? []).map((l) => `<li>${esc(l)}</li>`).join("");
      row.innerHTML = `<div class="head">
          <span class="badge ${esc(e.outcome)}">${esc(e.outcome)}</span>
          <span class="id">${esc(fmtDate(e.createdAt))}</span>
          <div class="grow" style="font-size:13px">${esc(e.goal)}</div>
          <span class="id desc">${esc(e.id)}</span>
        </div>
        <p class="summary">${esc(e.summary)}</p>
        ${lessons ? `<ul class="lessons">${lessons}</ul>` : ""}
        <div class="chips">${badges(e.tools, "")}${badges(e.tags, "#")}</div>`;
      $("episodes").appendChild(row);
    }
  }

  const skills = data.skills ?? [];
  if (skills.length === 0) {
    $("skills").innerHTML = '<div class="desc">لا مهارات بعد.</div>';
  } else {
    $("skills").innerHTML = "";
    for (const s of skills) {
      const uses = Number(s.uses ?? 0);
      const rate = uses > 0 ? `${Math.round(Number(s.successRate ?? 0) * 100)}%` : "—";
      const row = document.createElement("div");
      row.className = "item";
      row.innerHTML = `<div class="head">
          <span class="id">${esc(s.slug)}</span>
          <span class="chip">v${Number(s.version ?? 1)}</span>
          <span class="chip">نجاح ${rate} · ${uses} استخدام</span>
          ${s.lastUsed ? `<span class="chip">آخر استخدام ${esc(fmtDate(s.lastUsed))}</span>` : ""}
          <div class="grow"></div>
        </div>
        <div class="desc">${esc(s.description || "(بلا وصف)")}</div>`;
      const actions = document.createElement("div");
      actions.className = "row";
      actions.style.margin = "6px 0 0";
      const view = document.createElement("button");
      view.textContent = "عرض";
      view.onclick = () => void viewSkill(s.slug);
      const imp = document.createElement("button");
      imp.className = "ghost";
      imp.textContent = "تحسين";
      imp.onclick = () => void improve(s.slug, imp);
      actions.append(view, imp);
      row.appendChild(actions);
      $("skills").appendChild(row);
    }
  }

  const facts = data.facts ?? [];
  if (facts.length === 0) {
    $("facts").innerHTML = '<div class="desc">لا حقائق محفوظة بعد.</div>';
  } else {
    $("facts").innerHTML = "";
    for (const f of facts) {
      const row = document.createElement("div");
      row.className = "item";
      row.innerHTML = `<div class="head"><span class="chip">${esc(f.kind)}</span><div class="grow">${esc(f.text)}</div><span class="id desc">${esc(fmtDate(f.updatedAt))}</span></div>`;
      $("facts").appendChild(row);
    }
  }
}

async function viewSkill(slug) {
  const box = $("skillView");
  box.hidden = false;
  box.textContent = "جارٍ التحميل…";
  try {
    const res = await fetch(`/api/brain/skill?name=${encodeURIComponent(slug)}`);
    const data = await res.json();
    box.textContent = data.content ?? data.error ?? "(لا محتوى)";
  } catch (err) {
    box.textContent = "تعذّر التحميل: " + err.message;
  }
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function improve(slug, btn) {
  if (!window.confirm(`دمج ملاحظات الفشل المعلّقة في «${slug}» ورفع إصداره؟`)) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const res = await fetch("/api/brain/improve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: slug }),
    });
    const data = await res.json();
    if (data.error) status("خطأ: " + data.error, "err");
    else status(data.message ?? `تم تحسين ${slug}`, "ok");
  } catch (err) {
    status("تعذّر الاتصال بالخادم: " + err.message, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    await load();
  }
}

$("refresh").onclick = () => void load();
void load();
