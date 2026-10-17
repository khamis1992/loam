const $ = (id) => document.getElementById(id);
const taskId = new URLSearchParams(location.search).get("taskId");
const scoped = (url) => `${url}?taskId=${encodeURIComponent(taskId || "")}`;
let term = null;
let fit = null;
let sessionId = null;
let stream = null;

function setStatus(text) {
  $("status").textContent = text;
}

function initTerminal() {
  const Term = window.Terminal || (window.xterm && window.xterm.Terminal);
  if (!Term) {
    setStatus("xterm.js لم يُحمَّل (تحقق من /vendor/xterm.js)");
    return false;
  }
  term = new Term({
    fontFamily: "Consolas, 'Courier New', monospace",
    fontSize: 13,
    cursorBlink: true,
    convertEol: false,
    theme: { background: "#0b0d11", foreground: "#e6e8ee", cursor: "#6ea8fe", selectionBackground: "#2a3140" },
  });
  const FitCtor = window.FitAddon && window.FitAddon.FitAddon;
  if (FitCtor) {
    fit = new FitCtor();
    term.loadAddon(fit);
  }
  term.open($("term"));
  if (fit) fit.fit();

  term.onData((data) => {
    if (!sessionId) return;
    void fetch(scoped(`/api/pty/${encodeURIComponent(sessionId)}/input`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    });
  });

  window.addEventListener("resize", () => {
    if (fit) fit.fit();
    if (sessionId) resize();
  });
  return true;
}

function resize() {
  if (!sessionId || !term) return;
  void fetch(scoped(`/api/pty/${encodeURIComponent(sessionId)}/resize`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cols: term.cols, rows: term.rows }),
  });
}

function attachStream() {
  if (stream) stream.close();
  stream = new EventSource(scoped(`/api/pty/${encodeURIComponent(sessionId)}/stream`));
  stream.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    if (ev.type === "data") term.write(ev.data);
    else if (ev.type === "exit") {
      setStatus("انتهت الجلسة");
      sessionId = null;
      stream.close();
      stream = null;
    } else if (ev.type === "error") {
      setStatus(ev.message);
    }
  };
  stream.onerror = () => {
    /* keep reconnecting silently; EventSource retries */
  };
}

async function startSession() {
  if (!taskId) return setStatus("افتح الطرفية من مهمة لتحديد مساحتها المعزولة.");
  if (sessionId) await killSession();
  const shell = $("shell").value;
  setStatus("...جارٍ التشغيل");
  const res = await fetch("/api/pty", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId, shell, cols: term ? term.cols : 120, rows: term ? term.rows : 30 }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    setStatus(data.error || `HTTP ${res.status}`);
    return;
  }
  sessionId = data.id;
  term.reset();
  term.write(`\x1b[90m[Loam] started ${shell} session ${sessionId}\x1b[0m\r\n`);
  attachStream();
  setStatus(`جلسة ${sessionId} (${shell})`);
  term.focus();
}

async function killSession() {
  if (!sessionId) return;
  await fetch(scoped(`/api/pty/${encodeURIComponent(sessionId)}`), { method: "DELETE" });
  setStatus("أُوقفت الجلسة");
  sessionId = null;
  if (stream) {
    stream.close();
    stream = null;
  }
}

$("start").onclick = () => void startSession();
$("kill").onclick = () => void killSession();

(async () => {
  if (!taskId) { $("start").disabled = true; setStatus("افتح الطرفية من داخل مهمة في Loam."); return; }
  const ok = initTerminal();
  if (!ok) return;
  try {
    const st = await (await fetch("/api/pty/status")).json();
    setStatus(st.available ? st.status : `PTY غير متاح: ${st.status}`);
  } catch {
    setStatus("تعذّر قراءة حالة PTY");
  }
})();
