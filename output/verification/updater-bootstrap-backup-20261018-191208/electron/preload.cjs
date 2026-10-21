// Only the native folder picker is exposed to isolated renderers.
const { contextBridge, ipcRenderer } = require("electron");
const bridge = { pickFolder: () => ipcRenderer.invoke("pick-folder") };
contextBridge.exposeInMainWorld("loam", bridge);
// Compatibility for an already cached renderer during an upgrade.
contextBridge.exposeInMainWorld("manusLocal", bridge);
