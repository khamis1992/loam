const { contextBridge, ipcRenderer } = require("electron");

// NOTE: keep in sync with electron/ipc-constants.cjs. These constants must be
// inlined because sandboxed preload scripts cannot require local files.
const IPC_INVOKE = "desktop-ipc-api";
const IPC_EVENT_PREFIX = "desktop-ipc-event";
const IPC_META = "desktop-ipc-meta";
const IPC_SYNC = "desktop-sync-info";

function invoke(ns, method, args) {
  return ipcRenderer.invoke(IPC_INVOKE, { ns, method, args });
}

// Plain objects only — contextBridge cannot clone Proxy objects.
const apis = {
  auth: {
    getToken: (...args) => invoke("auth", "getToken", args),
    setToken: (...args) => invoke("auth", "setToken", args),
    removeToken: (...args) => invoke("auth", "removeToken", args),
    notifyLoginSuccess: (...args) => invoke("auth", "notifyLoginSuccess", args),
  },
  window: {
    minimize: (...args) => invoke("window", "minimize", args),
    maximize: (...args) => invoke("window", "maximize", args),
    close: (...args) => invoke("window", "close", args),
    isMaximized: (...args) => invoke("window", "isMaximized", args),
    toggleFullscreen: (...args) => invoke("window", "toggleFullscreen", args),
    isFullscreen: (...args) => invoke("window", "isFullscreen", args),
    openTaskInNewWindow: (...args) => invoke("window", "openTaskInNewWindow", args),
  },
  system: {
    openExternal: (...args) => invoke("system", "openExternal", args),
    showFolderDialog: (...args) => invoke("system", "showFolderDialog", args),
    showOpenFileDialog: (...args) => invoke("system", "showOpenFileDialog", args),
    readFile: (...args) => invoke("system", "readFile", args),
    notifyNetworkOnline: (...args) => invoke("system", "notifyNetworkOnline", args),
    notifyNetworkOffline: (...args) => invoke("system", "notifyNetworkOffline", args),
  },
  updater: {
    getStatus: (...args) => invoke("updater", "getStatus", args),
    checkForUpdates: (...args) => invoke("updater", "checkForUpdates", args),
    restartNow: (...args) => invoke("updater", "restartNow", args),
    getPolicyContext: (...args) => invoke("updater", "getPolicyContext", args),
  },
  theme: {
    broadcastConfig: (...args) => invoke("theme", "broadcastConfig", args),
  },
  appearance: {
    broadcastConfig: (...args) => invoke("appearance", "broadcastConfig", args),
  },
  desktopOperator: {
    listWorkspaceDirectory: (...args) => invoke("desktopOperator", "listWorkspaceDirectory", args),
    searchWorkspaceFiles: (...args) => invoke("desktopOperator", "searchWorkspaceFiles", args),
    watchWorkspaceFiles: (...args) => invoke("desktopOperator", "watchWorkspaceFiles", args),
    unwatchWorkspaceFiles: (...args) => invoke("desktopOperator", "unwatchWorkspaceFiles", args),
    getState: (...args) => invoke("desktopOperator", "getState", args),
    respondFolderAccess: (...args) => invoke("desktopOperator", "respondFolderAccess", args),
  },
  terminal: {
    create: (...args) => invoke("terminal", "create", args),
    write: (...args) => invoke("terminal", "write", args),
    resize: (...args) => invoke("terminal", "resize", args),
    close: (...args) => invoke("terminal", "close", args),
  },
  keepAwake: {
    getState: (...args) => invoke("keepAwake", "getState", args),
    setEnabled: (...args) => invoke("keepAwake", "setEnabled", args),
  },
  shortcut: {
    getConfig: (...args) => invoke("shortcut", "getConfig", args),
    getCapabilities: (...args) => invoke("shortcut", "getCapabilities", args),
    setEnabled: (...args) => invoke("shortcut", "setEnabled", args),
  },
  env: {
    setOverrideAndRelaunch: (...args) => invoke("env", "setOverrideAndRelaunch", args),
  },
  diagnosticLogs: {
    collect: (...args) => invoke("diagnosticLogs", "collect", args),
  },
  desktopActivityIndicator: {
    getState: (...args) => invoke("desktopActivityIndicator", "getState", args),
    rendererReady: (...args) => invoke("desktopActivityIndicator", "rendererReady", args),
    setEnabled: (...args) => invoke("desktopActivityIndicator", "setEnabled", args),
    setExpanded: (...args) => invoke("desktopActivityIndicator", "setExpanded", args),
  },
  storage: {
    getItem: (...args) => invoke("storage", "getItem", args),
    setItem: (...args) => invoke("storage", "setItem", args),
    removeItem: (...args) => invoke("storage", "removeItem", args),
  },
  inAppBrowser: {
    attach: (...args) => invoke("inAppBrowser", "attach", args),
    detach: (...args) => invoke("inAppBrowser", "detach", args),
    setBounds: (...args) => invoke("inAppBrowser", "setBounds", args),
    navigate: (...args) => invoke("inAppBrowser", "navigate", args),
    back: (...args) => invoke("inAppBrowser", "back", args),
    forward: (...args) => invoke("inAppBrowser", "forward", args),
    reload: (...args) => invoke("inAppBrowser", "reload", args),
    stop: (...args) => invoke("inAppBrowser", "stop", args),
    home: (...args) => invoke("inAppBrowser", "home", args),
    getState: (...args) => invoke("inAppBrowser", "getState", args),
    clearData: (...args) => invoke("inAppBrowser", "clearData", args),
  },
};

function subscribe(ns, evt, cb) {
  const channel = `${IPC_EVENT_PREFIX}:${ns}:${evt}`;
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const events = {
  auth: {
    onLoginSuccess: (cb) => subscribe("auth", "onLoginSuccess", cb),
    onLoginError: (cb) => subscribe("auth", "onLoginError", cb),
  },
  updater: {
    onStatusChanged: (cb) => subscribe("updater", "onStatusChanged", cb),
  },
  terminal: {
    onEvent: (cb) => subscribe("terminal", "onEvent", cb),
  },
  inAppBrowser: {
    onStateChanged: (cb) => subscribe("inAppBrowser", "onStateChanged", cb),
  },
};

const syncInfo = ipcRenderer.sendSync(IPC_SYNC);

contextBridge.exposeInMainWorld("desktopSync", syncInfo);
contextBridge.exposeInMainWorld("__apis", apis);
contextBridge.exposeInMainWorld("__events", events);
contextBridge.exposeInMainWorld("desktopLocalStorage", apis.storage);

// Legacy bridge kept for the existing vanilla UI during the transition.
contextBridge.exposeInMainWorld("loam", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  updates: {
    status: () => ipcRenderer.invoke("loam-updates", "status"),
    check: () => ipcRenderer.invoke("loam-updates", "check"),
    install: () => ipcRenderer.invoke("loam-updates", "install"),
  },
});
contextBridge.exposeInMainWorld("manusLocal", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  updates: {
    status: () => ipcRenderer.invoke("loam-updates", "status"),
    check: () => ipcRenderer.invoke("loam-updates", "check"),
    install: () => ipcRenderer.invoke("loam-updates", "install"),
  },
});
