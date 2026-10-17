const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function render(items, withScore) {
  const list = $("list");
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = `<div class="card"><div class="meta">لا نتائج</div></div>`;
    return;
  }
  for (const it of items) {
    const e = it.entry ?? it;
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="meta">${esc(e.id)} • [${esc(e.kind)}] • ${esc((e.createdAt || "").slice(0, 16))} ${withScore ? `• <span class="score">${Number(it.score).toFixed(3)}</span>` : ""}</div>
      <div>${esc(e.text)}</div>`;
    const del = document.createElement("button");
    del.className = "ghost";
    del.textContent = "حذف";
    del.style.marginTop = "6px";
    del.onclick = async () => {
      await fetch(`/api/memory/${encodeURIComponent(e.id)}`, { method: "DELETE" });
      void loadAll();
    };
    card.appendChild(del);
    list.appendChild(card);
  }
}

async function loadStatus() {
  const st = await (await fetch("/api/memory/status")).json();
  $("model").textContent = `${st.model} • ${st.count} عنصر${st.enabled ? "" : " (معطّل)"}`;
}

async function loadAll() {
  const data = await (await fetch("/api/memory?limit=100")).json();
  render(data.entries ?? [], false);
  loadStatus();
}

async function doSearch() {
  const q = $("q").value.trim();
  if (!q) return loadAll();
  const data = await (await fetch(`/api/memory?query=${encodeURIComponent(q)}&limit=20`)).json();
  render(data.hits ?? [], true);
}

$("search").onclick = () => void doSearch();
$("all").onclick = () => void loadAll();
$("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") void doSearch();
});
$("add").onclick = async () => {
  const text = $("text").value.trim();
  if (!text) return;
  await fetch("/api/memory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, kind: $("kind").value || "note" }),
  });
  $("text").value = "";
  void loadAll();
};

void loadAll();
