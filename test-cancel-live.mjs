// Live end-to-end cancellation test against the newly built dist/server.cjs
import { spawn } from 'node:child_process';

const PORT = 4951;
const child = spawn(process.execPath, ['dist/server.cjs'], {
  cwd: 'C:/Users/khamis/Desktop/manus-local',
  env: { ...process.env, MANUS_LOCAL_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logBuf = '';
child.stdout.on('data', (d) => { logBuf += d.toString(); });
child.stderr.on('data', (d) => { logBuf += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForBoot() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/settings`);
      if (r.ok) return true;
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error('server did not boot:\n' + logBuf.slice(-1500));
}

await waitForBoot();
console.log('[boot] server up on', PORT);

// Start a real task via /api/chat (SSE)
const sseRes = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    prompt: 'افحص ملفات مساحة العمل عبر file_list، ثم حلّل أهم 3 ملفات بالتفصيل، ثم اكتب تقريراً شاملاً مطولاً عن محتواها مع توصيات مفصلة لكل ملف.',
    title: 'اختبار الإيقاف',
  }),
});
console.log('[chat] SSE started, status', sseRes.status);

const reader = sseRes.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let taskId = null;
let sawWork = false;
const events = [];
let streamDoneResolve = null;
const streamDone = new Promise((resolve) => { streamDoneResolve = resolve; });

(async () => {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (!chunk.startsWith('data:')) continue;
        try {
          const ev = JSON.parse(chunk.slice(5).trim());
          events.push(ev.type);
          if (ev.type === 'task') taskId = ev.taskId;
          if (['step', 'plan', 'plan_step', 'assistant_token', 'tool_call', 'assistant_message'].includes(ev.type)) sawWork = true;
        } catch { /* partial */ }
      }
    }
      } finally {
        streamDoneResolve(true);
      }
})();

// wait for taskId + actual work to start
const t0 = Date.now();
while (!taskId || !sawWork) {
  if (Date.now() - t0 > 60000) { console.log('[fail] no work started; events:', events.join(',')); process.exit(1); }
  await sleep(200);
}
console.log('[work] taskId:', taskId, '| events so far:', events.slice(0, 8).join(','));
// let it get deeper (a few seconds of streaming/steps)
await sleep(5000);

// PRESS STOP
const cancelT0 = Date.now();
const cancelRes = await fetch(`http://127.0.0.1:${PORT}/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' });
const cancelBody = await cancelRes.json();
console.log('[cancel] response:', JSON.stringify(cancelBody));

// wait for the SSE stream to end
const ended = await Promise.race([streamDone, sleep(30000).then(() => false)]);
const cancelMs = Date.now() - cancelT0;

// fetch final task status
const taskRes = await (await fetch(`http://127.0.0.1:${PORT}/api/tasks/${encodeURIComponent(taskId)}`)).json();
const st = taskRes.task ?? {};

console.log('[result]', JSON.stringify({
  streamEnded: ended === true,
  msFromCancelToStreamEnd: cancelMs,
  lastEvents: events.slice(-6).join(','),
  taskStatus: st.status,
  taskError: st.error,
}, null, 2));

const pass =
  ended === true &&
  cancelMs < 8000 &&
  String(st.error ?? '').includes('cancelled');

console.log(pass ? '[PASS] المهمة توقفت بعد الإيقاف خلال ' + cancelMs + 'ms' : '[FAIL] المهمة لم تتوقف بسرعة');
child.kill();
process.exit(pass ? 0 : 1);