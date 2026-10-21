// Client service for the task right-panel live computer/browser view.
// Wraps the existing /api/live-view endpoints (status + frame) behind a small
// polling helper so the preview component stays free of fetch/URL concerns.

const DEFAULT_INTERVAL_MS = 2000;
const MIN_INTERVAL_MS = 1000;

function normalizeSource(source) {
  return source === 'browser' ? 'browser' : 'screen';
}

async function request(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    let message = `تعذّر الاتصال (${response.status})`;
    try {
      const data = await response.json();
      if (data && data.error) message = data.error;
    } catch {
      /* keep the default message */
    }
    throw new Error(message);
  }
  return response.json();
}

/** Feature flag + latest-frame metadata for one task. */
export function getLiveViewStatus(taskId) {
  const params = new URLSearchParams();
  if (taskId) params.set('taskId', String(taskId));
  const query = params.toString();
  return request(`/api/live-view/status${query ? `?${query}` : ''}`);
}

/** One JSON snapshot: { source, available, frame, error? }. */
export function getLiveViewFrame(taskId, source = 'screen') {
  const params = new URLSearchParams();
  if (taskId) params.set('taskId', String(taskId));
  params.set('source', normalizeSource(source));
  return request(`/api/live-view/frame?${params.toString()}`);
}

/**
 * Poll the frame endpoint on an interval. `getTaskId` is read on every tick so
 * the same poller survives task switches without being recreated.
 */
export function createLiveViewPoller({
  getTaskId,
  source = 'screen',
  intervalMs = DEFAULT_INTERVAL_MS,
  onFrame,
  onStatus,
  onError,
} = {}) {
  let timer = null;
  let inFlight = false;
  let stopped = false;
  let currentSource = normalizeSource(source);
  let currentInterval = Math.max(MIN_INTERVAL_MS, Number(intervalMs) || DEFAULT_INTERVAL_MS);

  async function tick() {
    if (stopped || inFlight) return;
    const taskId = typeof getTaskId === 'function' ? getTaskId() : null;
    if (!taskId) {
      if (typeof onStatus === 'function') onStatus({ source: currentSource, reason: 'no-task' });
      return;
    }
    inFlight = true;
    try {
      const data = await getLiveViewFrame(taskId, currentSource);
      if (stopped) return;
      if (typeof onFrame === 'function') {
        onFrame({
          source: currentSource,
          available: Boolean(data && data.available),
          frame: (data && data.frame) || null,
          error: (data && data.error) || null,
        });
      }
    } catch (error) {
      if (!stopped && typeof onError === 'function') {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      inFlight = false;
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().finally(schedule);
    }, currentInterval);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  const poller = {
    start() {
      stopped = false;
      void tick().finally(schedule);
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    async refresh() {
      await tick();
    },
    setSource(next) {
      currentSource = normalizeSource(next);
    },
    setInterval(next) {
      const value = Math.max(MIN_INTERVAL_MS, Number(next) || DEFAULT_INTERVAL_MS);
      if (value === currentInterval) return;
      currentInterval = value;
      if (!stopped) {
        poller.stop();
        poller.start();
      }
    },
    get source() {
      return currentSource;
    },
    get running() {
      return !stopped;
    },
  };

  return poller;
}
