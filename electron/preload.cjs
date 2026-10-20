const { contextBridge, ipcRenderer } = require("electron");

// NOTE: keep in sync with electron/ipc-constants.cjs. These constants must be
// inlined because sandboxed preload scripts cannot require local files.
const IPC_INVOKE = "desktop-ipc-api";
const IPC_EVENT_PREFIX = "desktop-ipc-event";
const IPC_META = "desktop-ipc-meta";
const IPC_SYNC = "desktop-sync-info";
const NAMESPACES = [
  "auth",
  "window",
  "system",
  "updater",
  "theme",
  "appearance",
  "desktopOperator",
  "terminal",
  "keepAwake",
  "shortcut",
  "env",
  "diagnosticLogs",
  "desktopActivityIndicator",
  "storage",
];

/** __apis.<ns>.<method>(...args) → ipcRenderer.invoke('desktop-ipc-api', { ns, method, args }) */
const apis = Object.fromEntries(
  NAMESPACES.map((ns) => [
    ns,
    new Proxy({}, {
      get: (_, method) => (...args) => ipcRenderer.invoke(IPC_INVOKE, { ns, method, args }),
    }),
  ]),
);

/** __events.<ns>.<event>(cb) → unsubscribe */
const events = Object.fromEntries(
  NAMESPACES.map((ns) => [
    ns,
    new Proxy({}, {
      get: (_, evt) => (cb) => {
        const channel = `${IPC_EVENT_PREFIX}:${ns}:${evt}`;
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
      },
    }),
  ]),
);

const syncInfo = ipcRenderer.sendSync(IPC_SYNC);

contextBridge.exposeInMainWorld("desktopSync", syncInfo);
contextBridge.exposeInMainWorld("__apis", apis);
contextBridge.exposeInMainWorld("__events", events);
contextBridge.exposeInMainWorld("desktopLocalStorage", {
  getItem: (k) => ipcRenderer.invoke(IPC_INVOKE, { ns: "storage", method: "getItem", args: [k] }),
  setItem: (k, v) => ipcRenderer.invoke(IPC_INVOKE, { ns: "storage", method: "setItem", args: [k, v] }),
  removeItem: (k) => ipcRenderer.invoke(IPC_INVOKE, { ns: "storage", method: "removeItem", args: [k] }),
});

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
