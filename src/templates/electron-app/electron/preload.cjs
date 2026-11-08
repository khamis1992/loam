const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getMetadata: () => ipcRenderer.invoke('app:metadata'),
  listFiles: (filters) => ipcRenderer.invoke('files:list', filters),
  addTag: (name, tag) => ipcRenderer.invoke('files:add-tag', name, tag),
  listHabits: () => ipcRenderer.invoke('habits:list'),
  addHabit: (input) => ipcRenderer.invoke('habits:add', input),
  completeHabit: (id) => ipcRenderer.invoke('habits:complete', id),
  listDocuments: () => ipcRenderer.invoke('markdown:list'),
  readDocument: (name) => ipcRenderer.invoke('markdown:read', name),
  writeDocument: (name, content) => ipcRenderer.invoke('markdown:write', name, content),
  listSecrets: () => ipcRenderer.invoke('vault:list'),
  unlockVault: () => ipcRenderer.invoke('vault:unlock'),
  lockVault: () => ipcRenderer.invoke('vault:lock'),
  addSecret: (input) => ipcRenderer.invoke('vault:add', input),
  revealSecret: (id) => ipcRenderer.invoke('vault:reveal', id),
  removeSecret: (id) => ipcRenderer.invoke('vault:remove', id),
  scanPhotos: () => ipcRenderer.invoke('photos:scan'),
  sortPhotos: () => ipcRenderer.invoke('photos:sort'),
});
