// Only the native folder picker is exposed to isolated renderers.
const { contextBridge, ipcRenderer } = require("electron");
const bridge = { pickFolder: () => ipcRenderer.invoke("pick-folder"), updates: {
  status: () => ipcRenderer.invoke('loam-updates', 'status'),
  check: () => ipcRenderer.invoke('loam-updates', 'check'),
  install: () => ipcRenderer.invoke('loam-updates', 'install'),
} };
contextBridge.exposeInMainWorld("loam", bridge);
// Compatibility for an already cached renderer during an upgrade.
contextBridge.exposeInMainWorld("manusLocal", bridge);
