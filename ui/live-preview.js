// Live computer screen / browser preview for the task right panel (option #13).
// Polls the existing /api/live-view/frame endpoint into an <img>, with a
// configurable refresh interval and a native full-screen toggle.

import { createLiveViewPoller, getLiveViewStatus } from './live-view.js';

const SOURCES = [
  { id: 'screen', label: 'شاشة الحاسوب' },
  { id: 'browser', label: 'المتصفح' },
];
const INTERVALS = [
  { value: 1000, label: 'كل ثانية' },
  { value: 2000, label: 'كل ثانيتين' },
  { value: 5000, label: 'كل 5 ثوانٍ' },
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountLivePreview(container, { getTaskId } = {}) {
  container.classList.add('live-view');
  container.replaceChildren();

  const sourceButtons = new Map();
  const sourceGroup = el('div', 'live-sources');
  for (const source of SOURCES) {
    const button = el('button', 'live-source', source.label);
    button.type = 'button';
    button.dataset.source = source.id;
    button.setAttribute('aria-pressed', String(source.id === 'screen'));
    button.onclick = () => selectSource(source.id);
    sourceButtons.set(source.id, button);
    sourceGroup.append(button);
  }

  const interval = el('select', 'live-interval');
  interval.setAttribute('aria-label', 'معدل تحديث العرض');
  for (const option of INTERVALS) {
    const node = el('option', '', option.label);
    node.value = String(option.value);
    if (option.value === 2000) node.selected = true;
    interval.append(node);
  }
  interval.onchange = () => poller.setInterval(Number(interval.value));

  const pause = el('button', 'icon live-pause');
  pause.type = 'button';
  pause.setAttribute('aria-label', 'إيقاف التحديث مؤقتًا');
  pause.setAttribute('aria-pressed', 'false');
  pause.innerHTML = '<loam-icon name="pause"></loam-icon>';
  pause.onclick = togglePause;

  const fullscreen = el('button', 'icon live-fullscreen');
  fullscreen.type = 'button';
  fullscreen.setAttribute('aria-label', 'ملء الشاشة');
  fullscreen.setAttribute('aria-pressed', 'false');
  fullscreen.innerHTML = '<loam-icon name="eye"></loam-icon>';
  fullscreen.onclick = toggleFullscreen;

  const toolbar = el('div', 'live-toolbar');
  toolbar.append(sourceGroup, interval, pause, fullscreen);

  const image = el('img', 'live-frame');
  image.alt = 'العرض المباشر لشاشة Loam';
  image.hidden = true;

  const status = el('p', 'live-status', 'جارٍ تشغيل العرض المباشر…');
  status.setAttribute('role', 'status');
  const meta = el('p', 'live-meta muted');
  const placeholder = el('div', 'live-placeholder');
  placeholder.append(status, meta);

  const stage = el('div', 'live-stage');
  stage.append(image, placeholder);

  container.append(toolbar, stage);

  let paused = false;
  let activeSource = 'screen';

  function renderFrame(payload) {
    const frame = (payload && payload.frame) || null;
    if (frame && frame.data) {
      image.src = `data:${frame.mediaType || 'image/jpeg'};base64,${frame.data}`;
      image.hidden = false;
      placeholder.hidden = true;
      const parts = [activeSource === 'browser' ? 'المتصفح' : 'شاشة الحاسوب'];
      if (frame.title) parts.push(frame.title);
      else if (frame.url) parts.push(frame.url);
      if (frame.width && frame.height) parts.push(`${frame.width}×${frame.height}`);
      if (frame.at) parts.push(new Date(frame.at).toLocaleTimeString());
      meta.textContent = parts.join(' · ');
      status.textContent = 'يتم التحديث تلقائيًا.';
      return;
    }
    image.hidden = true;
    image.removeAttribute('src');
    placeholder.hidden = false;
    meta.textContent = '';
    if (payload && payload.error) status.textContent = payload.error;
    else if (payload && payload.available === false) {
      status.textContent = activeSource === 'browser'
        ? 'لا توجد صورة من المتصفح بعد.'
        : 'بث الشاشة غير مفعّل في الإعدادات. جرّب عرض المتصفح.';
    } else {
      status.textContent = 'لا توجد صورة بعد. سيُحدَّث العرض تلقائيًا.';
    }
  }

  const poller = createLiveViewPoller({
    getTaskId,
    source: 'screen',
    intervalMs: 2000,
    onFrame: renderFrame,
    onError: (error) => {
      image.hidden = true;
      placeholder.hidden = false;
      meta.textContent = '';
      status.textContent = `تعذّر تحديث العرض: ${error.message}`;
    },
  });

  function selectSource(id) {
    activeSource = id;
    for (const [key, button] of sourceButtons) button.setAttribute('aria-pressed', String(key === id));
    poller.setSource(id);
    status.textContent = 'جارٍ تحديث العرض…';
    void poller.refresh();
  }

  function togglePause() {
    paused = !paused;
    if (paused) {
      poller.stop();
      pause.innerHTML = '<loam-icon name="play"></loam-icon>';
      pause.setAttribute('aria-label', 'استئناف التحديث');
      pause.setAttribute('aria-pressed', 'true');
      status.textContent = 'التحديث متوقف مؤقتًا.';
    } else {
      poller.start();
      pause.innerHTML = '<loam-icon name="pause"></loam-icon>';
      pause.setAttribute('aria-label', 'إيقاف التحديث مؤقتًا');
      pause.setAttribute('aria-pressed', 'false');
      status.textContent = 'يتم التحديث تلقائيًا.';
    }
  }

  function onFullscreenChange() {
    const active = document.fullscreenElement === container;
    container.classList.toggle('is-fullscreen', active);
    fullscreen.setAttribute('aria-pressed', String(active));
    fullscreen.setAttribute('aria-label', active ? 'الخروج من ملء الشاشة' : 'ملء الشاشة');
    fullscreen.innerHTML = active ? '<loam-icon name="close"></loam-icon>' : '<loam-icon name="eye"></loam-icon>';
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await container.requestFullscreen();
    } catch {
      /* full-screen unavailable in this context */
    }
  }

  document.addEventListener('fullscreenchange', onFullscreenChange);

  // Seed availability so a disabled source is obvious before the first frame.
  const taskId = typeof getTaskId === 'function' ? getTaskId() : null;
  if (taskId) {
    void getLiveViewStatus(taskId).then((data) => {
      if (activeSource === 'screen' && data && data.screen && data.screen.available === false) {
        status.textContent = 'بث الشاشة غير مفعّل في الإعدادات. جرّب عرض المتصفح.';
      }
    }).catch(() => {
      /* frame polling reports errors */
    });
  }

  poller.start();

  return {
    destroy() {
      poller.stop();
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      container.classList.remove('live-view', 'is-fullscreen');
      container.replaceChildren();
    },
  };
}
