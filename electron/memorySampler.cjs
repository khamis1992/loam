"use strict";

/**
 * Renderer memory sampler for the J7 idle-hibernation benchmark.
 *
 * The Electron main process cannot ask a `webContents` for its own memory in
 * Electron 44: `webContents.getProcessMemoryInfo()` does not exist (it is a
 * main-process API only, and it is async there). The reliable, synchronous way to
 * attribute memory to a renderer is `app.getAppMetrics()`, which reports one row
 * per process with `type: "Tab"` for renderer windows, plus the pid so rows can
 * be matched back to the `webContents` objects we own.
 *
 * This module is deliberately pure (metrics in, numbers out) so the attribution
 * logic is unit-testable without Electron. See `__tests__/memorySampler.test.cjs`.
 */

/** Aggregate a list of process metrics into a single RSS figure (MB). */
function sumWorkingSetMB(metrics) {
  let bytes = 0;
  for (const metric of metrics || []) {
    const memory = metric && metric.memory;
    const kb = memory && typeof memory.workingSetSize === "number" ? memory.workingSetSize : 0;
    bytes += kb * 1024;
  }
  return bytes / (1024 * 1024);
}

/**
 * Pick the process metrics that belong to renderer (`Tab`) processes whose pid is
 * in `rendererPids`.
 *
 * Rows whose `memory` is missing, whose `type` is absent, or whose pid is absent
 * are ignored so a partially-populated metric list never produces a bogus number.
 */
function selectRendererMetrics(metrics, rendererPids) {
  if (!Array.isArray(metrics)) return [];
  const pids = rendererPids instanceof Set ? rendererPids : new Set(rendererPids || []);
  if (pids.size === 0) return [];
  return metrics.filter((metric) => {
    if (!metric) return false;
    if (metric.type !== "Tab") return false;
    if (typeof metric.pid !== "number") return false;
    if (!metric.memory || typeof metric.memory.workingSetSize !== "number") return false;
    return pids.has(metric.pid);
  });
}

/**
 * Resolve the OS pids for the given webContents objects.
 *
 * `webContents.getOSProcessId()` is the stable sync accessor. When it is not
 * available (older Electron, or a stubbed webContents in tests) we fall back to
 * `getProcessId()`, which returns the in-process id rather than the OS pid but is
 * still a usable key on Electron builds where the two coincide.
 */
function webContentsPids(webContentsList) {
  const pids = [];
  for (const webContents of webContentsList || []) {
    if (!webContents || typeof webContents.getOSProcessId !== "function") continue;
    const pid = webContents.getOSProcessId();
    if (typeof pid === "number" && Number.isFinite(pid)) pids.push(pid);
  }
  return pids;
}

/** All renderer webContents owned by a set of browser windows. */
function windowWebContents(windows) {
  const list = [];
  for (const window of windows || []) {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      list.push(window.webContents);
    }
  }
  return list;
}

/**
 * Sample the working set (MB) of the renderer processes owned by `windows`.
 *
 * Returns 0 when the app has no metrics yet, or when no renderer row matches.
 * Never throws: the caller is a debug/benchmark surface, not a hot path.
 */
function sampleRendererRssMB(app, windows) {
  try {
    if (!app || typeof app.getAppMetrics !== "function") return { mb: 0, matched: 0, pids: [] };
    const metrics = app.getAppMetrics();
    const pids = webContentsPids(windowWebContents(windows));
    const rendererMetrics = selectRendererMetrics(metrics, new Set(pids));
    return { mb: sumWorkingSetMB(rendererMetrics), matched: rendererMetrics.length, pids };
  } catch {
    return { mb: 0, matched: 0, pids: [] };
  }
}

module.exports = {
  sampleRendererRssMB,
  selectRendererMetrics,
  sumWorkingSetMB,
  webContentsPids,
  windowWebContents,
};
