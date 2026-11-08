const path = require('node:path');
const { ipcMain, safeStorage, Notification } = require('electron');
const { createFileStore } = require('./fileStore.cjs');
const { createHabitStore } = require('./apps/habitStore.cjs');
const { createMarkdownStore } = require('./apps/markdownStore.cjs');
const { createPasswordStore } = require('./apps/passwordStore.cjs');
const { createPhotoStore } = require('./apps/photoStore.cjs');
const { registerNotes } = require('./notes.cjs');

function registerDesktopStore(config) {
  if (config && config.ipc === 'notes') {
    registerNotes(path.join(__dirname, '../notes'), ipcMain);
    return { notes: true };
  }
  ipcMain.handle('app:metadata', () => config);
  if (config.scenario === 'file-organizer') return createFileStore(path.join(__dirname, '../fixtures/downloads'), ipcMain);
  if (config.scenario === 'habit-tracker') return createHabitStore(path.join(__dirname, '../fixtures/habits'), ipcMain, {
    notify: (habit) => {
      if (Notification.isSupported()) new Notification({ title: 'Loam habit reminder', body: `${habit.name} is due today.` }).show();
    },
  });
  if (config.scenario === 'markdown-editor') return createMarkdownStore(path.join(__dirname, '../fixtures/documents'), ipcMain);
  if (config.scenario === 'password-manager') return createPasswordStore(path.join(__dirname, '../fixtures/vault'), ipcMain, safeStorage);
  if (config.scenario === 'photo-sorter') return createPhotoStore(path.join(__dirname, '../fixtures/photos'), ipcMain);
  throw new Error('Unknown desktop scenario');
}

module.exports = { registerDesktopStore };
