const $ = (id) => document.getElementById(id);
let stream = null;
let frames = 0;

function setStatus(text) {
  $("status").textContent = text;
}

function attach() {
  if (stream) stream.close();
  stream = new EventSource("/api/screen/stream");
  stream.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    if (ev.type === "frame") {
      $("view").src = `data:image/jpeg;base64,${ev.data}`;
      frames += 1;
      setStatus(`إطار #${ev.index} • ${ev.width}×${ev.height} • ${new Date(ev.at).toLocaleTimeString()}`);
    } else if (ev.type === "status") {
      setStatus(`التقاط: ${ev.running ? "يعمل" : "متوقف"} • ${ev.fps} fps • إطارات: ${ev.frames}`);
    }
  };
  stream.onerror = () => {
    /* EventSource retries automatically */
  };
}

async function refreshStatus() {
  try {
    const st = await (await fetch("/api/screen/status")).json();
    if (!st.enabled) {
      setStatus("البث معطّل في config");
      return;
    }
    setStatus(`التقاط: ${st.running ? "يعمل" : "متوقف"} • ${st.fps} fps • إطارات: ${st.frames} • مشتركون: ${st.subscribers}${st.lastError ? " • خطأ: " + st.lastError : ""}`);
  } catch {
    setStatus("تعذّر قراءة الحالة");
  }
}

$("start").onclick = async () => {
  const fps = Number($("fps").value || 1);
  const response = await fetch("/api/screen/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fps }) });
  if (!response.ok) { setStatus("تعذر تشغيل مشاركة الشاشة"); return; }
  attach();
  refreshStatus();
};

$("stop").onclick = async () => {
  if (stream) { stream.close(); stream = null; }
  $("view").removeAttribute("src");
  await fetch("/api/screen/stop", { method: "POST" });
  refreshStatus();
};

// Host capture is opt-in; do not replay a previous task's desktop frames.
refreshStatus();
setInterval(refreshStatus, 5000);
