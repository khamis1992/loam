// Settings > In-App Browser surface (UNIMPLEMENTED_OPTIONS #5).
//
// A WebContentsView owned by the Electron main process and driven through the
// desktop-ipc "inAppBrowser" namespace. The Settings pane anchors it by sending
// a window-relative rect (iabSetBounds) so the native view is positioned exactly
// over the pane's preview surface — the same technique used for overlays on top
// of DOM-rendered dialogs, because Electron has no native "webview hole".
//
// Shared state with the agent browser tool (src/tools/browser.ts):
//   - Home resolves through the Loam server settings endpoint, so the homepage
//     configured for the agent's Playwright browser (Settings > In-App Browser
//     > browser_open default) is the same page this view opens with.
//   - Cookies / localStorage live in the isolated `persist:loam-iab` session,
//     separate from the agent's per-task Playwright profiles, so agent activity
//     never clobbers what the user left open here.

const { WebContentsView, BrowserWindow } = require("electron");

const IAB_SESSION_PARTITION = "persist:loam-iab";

let view = null; // WebContentsView | null
let ownerWin = null; // BrowserWindow the view is currently attached to
let bounds = { x: 0, y: 0, width: 0, height: 0 };
let opts = { getWindow: () => null, openExternal: () => undefined, resolveHomepage: async () => "", backgroundColor: "#080b12" };
let lastNotified = "";

/** Only http(s), about:blank and devtools-ish safe schemes may load. Anything
 *  else (file:, app:, loamfilm:, javascript:, data:...) is refused. */
function isAllowedUrl(url) {
  if (typeof url !== "string") return false;
  if (url === "about:blank" || url === "about:") return true;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** True for URLs the pane may hand off to the OS browser instead of loading. */
function isExternalHandoffUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:";
  } catch {
    return false;
  }
}

function canBack() {
  if (!view) return false;
  const wc = view.webContents;
  try {
    return wc.navigationHistory.canGoBack();
  } catch {
    try {
      return wc.canGoBack();
    } catch {
      return false;
    }
  }
}

function canForward() {
  if (!view) return false;
  const wc = view.webContents;
  try {
    return wc.navigationHistory.canGoForward();
  } catch {
    try {
      return wc.canGoForward();
    } catch {
      return false;
    }
  }
}

function goBack() {
  if (!view) return;
  try {
    view.webContents.navigationHistory.goBack();
  } catch {
    try {
      view.webContents.goBack();
    } catch {}
  }
}

function goForward() {
  if (!view) return;
  try {
    view.webContents.navigationHistory.goForward();
  } catch {
    try {
      view.webContents.goForward();
    } catch {}
  }
}

function state() {
  const wc = view && !view.webContents.isDestroyed() ? view.webContents : null;
  return {
    attached: Boolean(view && ownerWin && !ownerWin.isDestroyed()),
    url: wc ? wc.getURL() : "",
    title: wc ? wc.getTitle() : "",
    loading: wc ? wc.isLoading() : false,
    canGoBack: canBack(),
    canGoForward: canForward(),
  };
}

/** Push a state snapshot to the shell renderer as a desktop-ipc event so the
 *  Settings pane stays in sync without polling. Only sends on real change. */
function notify() {
  const snapshot = state();
  const encoded = JSON.stringify(snapshot);
  if (encoded === lastNotified) return;
  lastNotified = encoded;
  const w = opts.getWindow();
  if (w && !w.isDestroyed()) {
    w.webContents.send("desktop-ipc-event:inAppBrowser:onStateChanged", snapshot);
  }
}

function hooksFor() {
  return {
    windowOpen: ({ url }) => {
      // Popups and target=_blank: follow them INSIDE the view when the page
      // navigated a plain http(s) URL; hand trusted off-scheme links to the OS.
      if (isAllowedUrl(url)) {
        try {
          view.webContents.loadURL(url);
        } catch {}
        return { action: "deny" };
      }
      if (isExternalHandoffUrl(url)) opts.openExternal(url);
      return { action: "deny" };
    },
    willNavigate: (event, url) => {
      if (!isAllowedUrl(url)) {
        event.preventDefault();
        if (isExternalHandoffUrl(url)) opts.openExternal(url);
      }
    },
  };
}

function createView() {
  const v = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: IAB_SESSION_PARTITION,
    },
  });
  v.setBackgroundColor(opts.backgroundColor || "#080b12");
  const wc = v.webContents;
  const hooks = hooksFor();
  wc.setWindowOpenHandler(hooks.windowOpen);
  wc.on("will-navigate", hooks.willNavigate);
  wc.on("did-start-loading", notify);
  wc.on("did-stop-loading", notify);
  wc.on("did-navigate", notify);
  wc.on("did-navigate-in-page", notify);
  wc.on("did-fail-load", (_event, _code, description, url, isMainFrame) => {
    // Keep the pane honest: a failed main-frame load stops loading but keeps
    // the URL the user attempted visible.
    if (isMainFrame) notify();
  });
  wc.on("page-title-updated", notify);
  wc.on("render-process-gone", () => {
    // A crashed guest process would leave a dead view permanently overlaid;
    // drop it so the next open recreates a fresh one.
    try {
      if (ownerWin && !ownerWin.isDestroyed()) ownerWin.contentView.removeChildView(v);
    } catch {}
    if (view === v) view = null;
    ownerWin = null;
    notify();
  });
  wc.on("unresponsive", notify);
  return v;
}

function ensureView() {
  if (view && !view.webContents.isDestroyed()) return view;
  view = createView();
  return view;
}

function attach() {
  const target = opts.getWindow();
  if (!target || target.isDestroyed()) throw new Error("Loam window is not available");
  const v = ensureView();
  if (ownerWin !== target) {
    if (ownerWin && !ownerWin.isDestroyed()) {
      try {
        ownerWin.contentView.removeChildView(v);
      } catch {}
    }
    try {
      target.contentView.addChildView(v);
    } catch (err) {
      throw new Error("in-app browser attach failed: " + (err instanceof Error ? err.message : String(err)));
    }
    // Always start exactly where the user says; the renderer sends setBounds
    // right after attach from its measured preview rect.
    v.setBounds({ ...bounds });
    ownerWin = target;
    target.once?.("closed", () => {
      if (ownerWin === target) {
        ownerWin = null;
        notify();
      }
    });
  }
  notify();
  return state();
}

function detach() {
  if (view && ownerWin && !ownerWin.isDestroyed()) {
    try {
      ownerWin.contentView.removeChildView(view);
    } catch {}
  }
  ownerWin = null;
  notify();
  return state();
}

function setBounds(next) {
  if (!view || !ownerWin || ownerWin.isDestroyed()) return false;
  const x = Number(next?.x ?? 0);
  const y = Number(next?.y ?? 0);
  const width = Math.max(0, Number(next?.width ?? 0));
  const height = Math.max(0, Number(next?.height ?? 0));
  bounds = { x, y, width, height };
  if (bounds.width < 1 || bounds.height < 1) return false;
  try {
    view.setBounds(bounds);
    return true;
  } catch (err) {
    return false;
  }
}

async function navigate(url) {
  const value = String(url ?? "").trim();
  if (!isAllowedUrl(value)) {
    return { ok: false, error: "only http(s) and about:blank URLs can be opened in the in-app browser", state: state() };
  }
  const v = ensureView();
  try {
    await v.webContents.loadURL(value);
    return { ok: true, state: state() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), state: state() };
  }
}

async function home() {
  let target = "";
  try {
    target = await opts.resolveHomepage();
  } catch {}
  if (!target) target = opts.fallbackHomepage || "about:blank";
  if (!isAllowedUrl(target)) target = opts.fallbackHomepage || "about:blank";
  return navigate(target);
}

async function clearData() {
  let cleared = false;
  try {
    const { session } = require("electron");
    const s = session.fromPartition(IAB_SESSION_PARTITION);
    await s.clearStorageData();
    await s.clearCache();
    cleared = true;
  } catch {}
  // Drop the view entirely so history is gone, not just hidden behind a
  // re-created page.
  if (view) {
    detach();
    try {
      view.webContents.destroy();
    } catch {}
  }
  view = null;
  notify();
  return { cleared, state: state() };
}

function reloadIgnoringCache() {
  if (view && !view.webContents.isDestroyed()) {
    try {
      view.webContents.reloadIgnoringCache();
    } catch {}
  }
}

const handlers = {
  attach: () => attach(),
  detach: () => detach(),
  setBounds: (_sender, rect) => setBounds(rect),
  navigate: (_sender, url) => navigate(url),
  back: () => {
    goBack();
    return state();
  },
  forward: () => {
    goForward();
    return state();
  },
  reload: () => {
    if (view && !view.webContents.isDestroyed()) {
      try {
        view.webContents.reload();
      } catch {}
    }
    return state();
  },
  stop: () => {
    if (view && !view.webContents.isDestroyed()) {
      try {
        view.webContents.stop();
      } catch {}
    }
    return state();
  },
  home: () => home(),
  getState: () => state(),
  clearData: () => clearData(),
};

/* Explicit integration seam for main.cjs: init() keeps this module free of
 * globals from the host file (inject the window getter, external opener and
 * homepage resolver). */
function init(next) {
  opts = Object.assign({}, opts, next || {});
}

function isVisible() {
  return Boolean(view && ownerWin);
}

const IAB_EVENT_CHANNEL = "desktop-ipc-event:inAppBrowser:onStateChanged";

module.exports = { IAB_SESSION_PARTITION, IAB_EVENT_CHANNEL, handlers, init, state, isVisible, isAllowedUrl, reloadIgnoringCache };
