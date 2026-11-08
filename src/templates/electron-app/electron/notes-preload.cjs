const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  loadNotes: () => ipcRenderer.invoke('notes:load'),
  saveNotes: (text) => ipcRenderer.invoke('notes:save', text),
});
