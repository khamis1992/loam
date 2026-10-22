/**
 * WebArena evaluation adapter (frontier section 24, second benchmark beside OSWorld).
 *
 * WebArena's own environment (self-hosted shopping/forum/gitlab/maps sites in
 * Docker) is reproduced here as LOCAL equivalent sites with the same interaction
 * surface (browse → read → click/type → submit) and the same evaluation style
 * (string-match / url-match / programmatic checks on end state). Tasks run
 * through Loam's real browser tools against an isolated Loam server with a real
 * model (LOAM_WEBARENA_MODEL, default glm-5.3-flash:cloud).
 *
 * Published WebArena reference lines (paper, 2023): human 78.24%, best
 * prompt-based agent ~36.8% — included for context, with the honest caveat that
 * these 8 tasks are WebArena-equivalent, not the official 812-task environment.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const MODEL = process.env.LOAM_WEBARENA_MODEL ?? "glm-5.3-flash:cloud";
const root = process.cwd();

// ══════════ local WebArena-equivalent sites (in-memory state + real HTML) ══════════
type CartItem = { id: string; qty: number };
const store = {
  products: [
    { id: "laptop-pro", name: "لابتوب Loam Pro", price: 4200, cat: "laptops" },
    { id: "laptop-air", name: "لابتوب Loam Air", price: 3100, cat: "laptops" },
    { id: "laptop-mini", name: "لابتوب Mini", price: 2400, cat: "laptops" },
    { id: "keyboard-mesh", name: "لوحة المفاتيح Mesh", price: 180, cat: "accessories" },
    { id: "mouse-soft", name: "الفأرة الناعمة", price: 95, cat: "accessories" },
  ],
  cart: [] as CartItem[],
  reviews: [] as Array<{ product: string; stars: number; text: string }>,
};
const forum = { posts: [] as Array<{ id: number; title: string; body: string; comments: string[] }> };
const git = { issues: [] as Array<{ id: number; title: string; body: string }> };
const admin = {
  orders: Array.from({ length: 23 }, (_, i) => ({ id: i + 1, state: i % 3 === 0 ? "مكتمل" : i % 3 === 1 ? "قيد التنفيذ" : "ملغى" })),
};
const forms = { submissions: [] as Array<Record<string, string>> };

const page = (title: string, body: string): string =>
  `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`;

function startSite(name: string, handler: http.RequestListener): Promise<number> {
  const srv = http.createServer(handler);
  srv.listen(0, "127.0.0.1");
  return once(srv, "listening").then(() => (srv.address() as import("node:net").AddressInfo).port);
}
const jsonBody = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } }); });

const shoppingPort = await startSite("shopping", async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "POST" && url.pathname === "/api/cart") {
    const b = await jsonBody(req);
    const id = String(b.id ?? "");
    const qty = Number(b.qty ?? 1);
    const existing = store.cart.find((c) => c.id === id);
    if (existing) existing.qty += qty; else store.cart.push({ id, qty });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, cart: store.cart }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/review") {
    const b = await jsonBody(req);
    store.reviews.push({ product: String(b.product ?? ""), stars: Number(b.stars ?? 0), text: String(b.text ?? "") });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  let body = `<h1>متجر Loam</h1><nav><a href="/">الرئيسية</a> <a href="/laptops">لابتوبات</a> <a href="/accessories">ملحقات</a></nav>`;
  const cat = url.pathname.slice(1);
  if (cat === "laptops" || cat === "accessories") {
    body += `<ul>` + store.products.filter((p) => p.cat === cat).map((p) => `<li><a href="/product?id=${p.id}">${p.name}</a> — ${p.price} ريال</li>`).join("") + `</ul>`;
  } else if (url.pathname === "/product") {
    const p = store.products.find((x) => x.id === url.searchParams.get("id"));
    if (!p) body += `<p>غير موجود</p>`;
    else body += `<h2>${p.name}</h2><p>السعر: ${p.price} ريال</p><form onsubmit="event.preventDefault();fetch('/api/cart',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'${p.id}',qty:1})}).then(r=>r.json()).then(d=>document.getElementById('cartmsg').textContent='أُضيف إلى السلة ('+JSON.stringify(d.cart)+')')"><button id="add-to-cart">أضف إلى السلة</button></form><p id="cartmsg"></p>`;
  } else {
    body += `<ul>` + store.products.map((p) => `<li><a href="/product?id=${p.id}">${p.name}</a> — ${p.price} ريال</li>`).join("") + `</ul>`;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("المتجر", body));
});
const forumPort = await startSite("forum", async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "POST" && url.pathname === "/api/posts") {
    const b = await jsonBody(req);
    forum.posts.push({ id: forum.posts.length + 1, title: String(b.title ?? ""), body: String(b.body ?? ""), comments: [] });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/posts/") && url.pathname.endsWith("/comment")) {
    const id = Number(url.pathname.split("/")[3]);
    const b = await jsonBody(req);
    forum.posts.find((p) => p.id === id)?.comments.push(String(b.text ?? ""));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  let body = `<h1>منتدى Loam</h1>`;
  if (url.pathname.startsWith("/post/")) {
    const p = forum.posts.find((x) => x.id === Number(url.pathname.split("/")[2]));
    body += p ? `<h2>${p.title}</h2><p>${p.body}</p><h3>تعليقات</h3><ul>${p.comments.map((c) => `<li>${c}</li>`).join("") || "<li>لا تعليقات</li>"}</ul>` : "<p>غير موجود</p>";
  } else if (forum.posts.length === 0) {
    body += `<p>لا منشورات بعد — انشر الأول عبر نموذج النشر</p><form onsubmit="event.preventDefault();fetch('/api/posts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:document.getElementById('t').value,body:document.getElementById('b').value)})"><input id="t" placeholder="العنوان"><textarea id="b" placeholder="المحتوى"></textarea><button>نشر</button></form>`;
  } else {
    body += `<ul>${forum.posts.map((p) => `<li><a href="/post/${p.id}">${p.title}</a></li>`).join("")}</ul><form onsubmit="event.preventDefault();fetch('/api/posts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:document.getElementById('t').value,body:document.getElementById('b').value)})"><input id="t" placeholder="العنوان"><textarea id="b" placeholder="المحتوى"></textarea><button>نشر</button></form>`;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("المنتدى", body));
});
const gitPort = await startSite("git", async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "POST" && url.pathname === "/api/issues") {
    const b = await jsonBody(req);
    git.issues.push({ id: git.issues.length + 1, title: String(b.title ?? ""), body: String(b.body ?? "") });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  const body = `<h1>مستودع loam-app</h1><h2>المشاكل</h2><ul>${git.issues.map((i) => `<li>#${i.id} ${i.title}</li>`).join("") || "<li>لا مشاكل</li>"}</ul><form onsubmit="event.preventDefault();fetch('/api/issues',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:document.getElementById('t').value,body:document.getElementById('b').value)})"><input id="t" placeholder="عنوان المشكلة"><textarea id="b" placeholder="الوصف"></textarea><button>إنشاء مشكلة</button></form>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("المستودع", body));
});
const adminPort = await startSite("admin", (_req, res) => {
  const body = `<h1>لوحة الطلبات</h1><table border="1"><tr><th>رقم</th><th>الحالة</th></tr>${admin.orders.map((o) => `<tr><td>${o.id}</td><td>${o.state}</td></tr>`).join("")}</table>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("اللوحة", body));
});
const formPort = await startSite("form", async (req, res) => {
  if (req.method === "POST" && req.url === "/api/submit") {
    const b = await jsonBody(req);
    forms.submissions.push(b as Record<string, string>);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, received: b }));
    return;
  }
  const body = `<h1>نموذج طلب التوريد</h1><form onsubmit="event.preventDefault();fetch('/api/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:document.getElementById('n').value,city:document.getElementById('c').value,qty:document.getElementById('q').value})}).then(r=>r.json()).then(d=>document.getElementById('msg').textContent='تم إرسال الطلب: '+JSON.stringify(d.received))">
<input id="n" placeholder="الاسم"><input id="c" placeholder="المدينة"><input id="q" placeholder="الكمية" type="number"><button>إرسال</button></form><p id="msg"></p>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("النموذج", body));
});

const SHOP = `http://127.0.0.1:${shoppingPort}`;
const FORUM = `http://127.0.0.1:${forumPort}`;
const GIT = `http://127.0.0.1:${gitPort}`;
const ADMIN = `http://127.0.0.1:${adminPort}`;
const FORM = `http://127.0.0.1:${formPort}`;

// ══════════ tasks (WebArena schema: intent + sites + eval func) ══════════
interface WebArenaTask {
  id: string;
  intent: string;
  sites: string[];
  startUrl: string;
  evaluation: { func: string; expected: string };
  reference?: string;
}
const TASKS: WebArenaTask[] = [
  {
    id: "webarena-shopping-001",
    intent: `افتح متجر Loam على ${SHOP}، ابحث عن أرخص لابتوب بين اللابتوبات الثلاثة وأضفه إلى السلة عبر زر «أضف إلى السلة» في صفحة المنتج.`,
    sites: ["shopping"], startUrl: SHOP,
    evaluation: { func: "programmatic:cart_contains:laptop-mini", expected: "السلة تحوي laptop-mini (الأرخص 2400)" },
  },
  {
    id: "webarena-shopping-002",
    intent: `افتح ${SHOP}/product?id=keyboard-mesh وأضف مراجعة 5 نجوم بنص «جودة ممتازة» عبر واجهة الموقع (بعد الإضافة سترى تأكيدًا).`,
    sites: ["shopping"], startUrl: `${SHOP}/product?id=keyboard-mesh`,
    evaluation: { func: "programmatic:review_added", expected: "مراجعة 5 نجوم «جودة ممتازة» على keyboard-mesh" },
  },
  {
    id: "webarena-social-001",
    intent: `انشر في منتدى Loam (${FORUM}) منشورًا بعنوان «نتائج مسح المستخدمين» ومحتوى «الرضا العام 87 بالمئة» عبر نموذج النشر في الصفحة.`,
    sites: ["social"], startUrl: FORUM,
    evaluation: { func: "programmatic:post_created", expected: "منشور بالعنوان والمحتوى المطلوبين" },
  },
  {
    id: "webarena-gitlab-001",
    intent: `في مستودع loam-app (${GIT}) أنشئ مشكلة (issue) بعنوان «خطأ في تسجيل الدخول» ووصف «فشل التحقق عند الفراغ» عبر النموذج.`,
    sites: ["gitlab"], startUrl: GIT,
    evaluation: { func: "programmatic:issue_created", expected: "مشكلة بالعنوان والوصف المطلوبين" },
  },
  {
    id: "webarena-admin-001",
    intent: `افتح لوحة الطلبات (${ADMIN}) واحسب عدد الطلبات التي حالتها «مكتمل» واذكر الرقم في ردك النهائي فقط.`,
    sites: ["admin"], startUrl: ADMIN,
    evaluation: { func: "string-match:8", expected: "العدد الصحيح للطلبات المكتملة هو 8" },
  },
  {
    id: "webarena-cross-001",
    intent: `مهمة عبر موقعين: 1) من متجر Loam (${SHOP}) اقرأ سعر «لوحة المفاتيح Mesh». 2) انشر في المنتدى (${FORUM}) منشورًا بعنوان «سعر لوحة المفاتيح» ومحتوى السعر بالضبط بصيغة «السعر 180 ريال».`,
    sites: ["shopping", "social"], startUrl: SHOP,
    evaluation: { func: "programmatic:cross_post", expected: "منشور يحوي السعر الصحيح 180" },
  },
  {
    id: "webarena-form-001",
    intent: `عبّئ نموذج طلب التوريد (${FORM}) بالقيم: الاسم «سالم»، المدينة «الرياض»، الكمية 3، ثم أرسله وأكد ظهور رسالة النجاح.`,
    sites: ["form"], startUrl: FORM,
    evaluation: { func: "programmatic:form_submitted", expected: "استلام بالقيم الثلاث الصحيحة" },
  },
  {
    id: "webarena-social-002",
    intent: `انشر أولًا في المنتدى (${FORUM}) منشورًا بعنوان «نقاش الأسبوع» ومحتوى «ما رأيكم؟»، ثم افتح المنشور وأضف تعليقًا «موافق تمامًا» عليه.`,
    sites: ["social"], startUrl: FORUM,
    evaluation: { func: "programmatic:comment_added", expected: "تعليق على منشور «نقاش الأسبوع»" },
  },
];

// ══════════ isolated Loam server with a real model ══════════
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-webarena-"));
fs.mkdirSync(path.join(tmp, "ws"), { recursive: true });
const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = (probe.address() as import("node:net").AddressInfo).port;
await new Promise<void>((r) => probe.close(() => r()));
const protoProbe = http.createServer(); protoProbe.listen(0, "127.0.0.1"); await once(protoProbe, "listening");
const protoPort = (protoProbe.address() as import("node:net").AddressInfo).port;
await new Promise<void>((r) => protoProbe.close(() => r()));
const base = `http://127.0.0.1:${port}`;
const configPath = path.join(tmp, "config.json");
fs.writeFileSync(configPath, JSON.stringify({
  model: MODEL, fallbackModel: MODEL, ollamaUrl: "http://127.0.0.1:11434",
  workspace: path.join(tmp, "ws"),
  browser: { channel: "msedge", headless: true, viewport: { width: 1280, height: 800 } },
  memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false }, orchestrator: { enabled: false }, mcpServers: {},
}));
fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
fs.writeFileSync(path.join(tmp, "data", ".loam-local-auth-token"), "webarena-token".repeat(4), "utf8");
const headers = { "content-type": "application/json", "x-loam-local-token": "webarena-token".repeat(4) };

let child: ChildProcess | undefined;
let logs = "";
child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: root, windowsHide: true,
  env: { ...process.env, MANUS_LOCAL_CONFIG: configPath, MANUS_LOCAL_DATA_DIR: path.join(tmp, "data"), MANUS_LOCAL_PORT: String(port), AS_PROTOCOL_PORT: String(protoPort), MANUS_LOCAL_EVALS_DIR: path.join(tmp, "evals"), MANUS_LOCAL_SKILLS_DIR: path.join(tmp, "skills"), LOAM_AUTH_DISABLED: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout?.on("data", (c) => (logs += c));
child.stderr?.on("data", (c) => (logs += c));
{
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (child?.exitCode != null) throw new Error(logs.slice(-2000));
    if (await fetch(`${base}/api/work-modes`, { headers }).then((r) => r.ok).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
}

type Ev = Record<string, unknown>;
async function runChat(body: Record<string, unknown>, timeoutMs = 8 * 60_000): Promise<Ev[]> {
  const res = await fetch(`${base}/api/chat`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) return [{ type: "error", message: `HTTP ${res.status}` }];
  const events: Ev[] = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
      buf = buf.slice(i + 2);
      if (!line) continue;
      try { events.push(JSON.parse(line.slice(6)) as Ev); } catch { /* */ }
    }
  }
  return events;
}
const assistantText = (events: Ev[]): string =>
  events.filter((e) => e.type === "assistant_message").map((e) => String(e.content ?? "")).join("\n");

// ══════════ evaluation (WebArena-style end-state checks) ══════════
function evaluate(task: WebArenaTask, events: Ev[]): { pass: boolean; detail: string } {
  const done = events.some((e) => e.type === "done");
  const answer = assistantText(events);
  switch (task.evaluation.func) {
    case "programmatic:cart_contains:laptop-mini": {
      const ok = done && store.cart.some((c) => c.id === "laptop-mini");
      return { pass: ok, detail: ok ? `cart=[${store.cart.map((c) => c.id).join(",")}]` : `cart=[${store.cart.map((c) => c.id).join(",")}] done=${done}` };
    }
    case "programmatic:review_added": {
      const r = store.reviews.find((x) => x.product === "keyboard-mesh" && x.stars === 5);
      return { pass: Boolean(done && r), detail: r ? `review "${r.text}" ★${r.stars}` : `reviews=${JSON.stringify(store.reviews)}` };
    }
    case "programmatic:post_created": {
      const p = forum.posts.find((x) => x.title.includes("نتائج مسح"));
      return { pass: Boolean(done && p && p.body.includes("87")), detail: p ? `post "${p.title}": ${p.body.slice(0, 40)}` : `posts=${JSON.stringify(forum.posts.map((x) => x.title))}` };
    }
    case "programmatic:issue_created": {
      const i = git.issues.find((x) => x.title.includes("تسجيل الدخول"));
      return { pass: Boolean(done && i && i.body.includes("فشل التحقق")), detail: i ? `issue #${i.id} "${i.title}"` : `issues=${JSON.stringify(git.issues)}` };
    }
    case "string-match:8": {
      const ok = done && /\b8\b/.test(answer);
      return { pass: ok, detail: ok ? `answer contains 8: ${answer.slice(0, 60)}` : `answer="${answer.slice(0, 120)}"` };
    }
    case "programmatic:cross_post": {
      const p = forum.posts.find((x) => x.title.includes("سعر لوحة المفاتيح") && x.body.includes("180"));
      return { pass: Boolean(done && p), detail: p ? `cross-site post: ${p.body}` : `posts=${JSON.stringify(forum.posts.map((x) => [x.title, x.body]))}` };
    }
    case "programmatic:form_submitted": {
      const s = forms.submissions.find((x) => x.name === "سالم" && x.city === "الرياض" && String(x.qty) === "3");
      return { pass: Boolean(done && s), detail: s ? `form=${JSON.stringify(s)}` : `submissions=${JSON.stringify(forms.submissions)}` };
    }
    case "programmatic:comment_added": {
      const p = forum.posts.find((x) => x.title.includes("نقاش الأسبوع"));
      return { pass: Boolean(done && p?.comments.some((c) => c.includes("موافق"))), detail: p ? `comments=${JSON.stringify(p.comments)}` : "post not found" };
    }
    default:
      return { pass: false, detail: "unknown eval" };
  }
}

// ══════════ main runner ══════════
console.log(`WebArena-equivalent adapter — ${TASKS.length} tasks, model=${MODEL}\nReference (official WebArena, 812 tasks): human 78.24%, best published agent ~36.8%\nNote: local equivalent sites, same schema & end-state evaluation.\n`);
const results: Array<{ id: string; pass: boolean; detail: string; ms: number; interventions: number }> = [];
for (const task of TASKS) {
  const started = Date.now();
  console.log(`▶ ${task.id}: ${task.intent.slice(0, 60)}…`);
  const events = await runChat({ prompt: `${task.intent}\n\nنفّذ عبر أدوات المتصفح مباشرة دون طرح أسئلة وأنهِ بملخص قصير.`, mode: "build", title: `WebArena: ${task.id}` });
  const verdict = evaluate(task, events);
  const interventions = events.filter((e) => e.type === "approval_required").length;
  results.push({ id: task.id, pass: verdict.pass, detail: verdict.detail, ms: Date.now() - started, interventions });
  console.log(`  ${verdict.pass ? "✔" : "✗"} ${verdict.detail} (${((Date.now() - started) / 1000).toFixed(0)}s)\n`);
}
const passed = results.filter((r) => r.pass).length;
const rate = ((passed / results.length) * 100).toFixed(0);
const totalMs = results.reduce((a, r) => a + r.ms, 0);
console.log(`Result: ${passed}/${results.length} (${rate}%) — avg ${(totalMs / results.length / 1000).toFixed(0)}s/task, ${results.reduce((a, r) => a + r.interventions, 0)} interventions\n`);

// evidence
const evDir = path.resolve(import.meta.dirname, "../../docs/evidence");
fs.mkdirSync(evDir, { recursive: true });
fs.writeFileSync(path.join(evDir, "webarena-adapter-results.json"), JSON.stringify({
  when: new Date().toISOString(), model: MODEL, tasks: TASKS.map((t) => ({ id: t.id, sites: t.sites, intent: t.intent, eval: t.evaluation })),
  results, summary: { passed, total: results.length, rate: Number(rate), interventions: results.reduce((a, r) => a + r.interventions, 0), avgSecPerTask: Math.round(totalMs / results.length / 1000) },
  reference: { officialWebArena: { human: 78.24, bestPublishedAgent: 36.8, officialTasks: 812 }, caveat: "equivalent local sites, not the official Docker environment" },
}, null, 2), "utf8");

// cleanup
if (child && child.exitCode === null) { const e = once(child, "exit"); child.kill("SIGKILL"); await e; }
assert.ok(passed >= 4, `expected at least half the WebArena-equivalent tasks to pass, got ${passed}/${results.length} — see docs/evidence/webarena-adapter-results.json`);
console.log(`Evidence → docs/evidence/webarena-adapter-results.json`);
