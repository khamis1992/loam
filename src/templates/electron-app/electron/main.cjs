const { app, BrowserWindow, Menu, Tray, nativeImage, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { registerDesktopStore } = require('./store.cjs');
const { widgetFrame, placedWidgetOnDisplays, readWidgetPosition, WIDGET_WIDTH, WIDGET_HEIGHT, MOVE_DEBOUNCE_MS } = require('./widget-geometry.cjs');
const { allowNavigation } = require('./navigation.cjs');
const { userDataDir } = require('./userData.cjs');
app.setPath('userData', userDataDir(path.join(__dirname, '..'), process.env.LOAM_PREVIEW_READY));

const configPath = path.join(__dirname, '../desktop-app.json');
const configText = readDesktopConfig(configPath);
const config = configText === null
  ? { scenario: 'file-organizer', title: 'Loam File Organizer', version: 1 }
  : JSON.parse(configText);
const store = registerDesktopStore(config);
const widget = config.surface === 'widget';
const notesOnly = config.ipc === 'notes';
const positionFile = path.join(__dirname, '../widget-window.json');
let mainWindow = null;
let tray = null;
let quitting = false;
let moveTimer = null;

function refuseLinked(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    return null;
  }
  if (stat.nlink > 1) throw new Error('unsafe_path');
  return stat;
}

function readDesktopConfig(file) {
  const stat = refuseLinked(file);
  if (!stat) return null;
  return fs.readFileSync(file, 'utf8');
}

function plainText(file) {
  const stat = refuseLinked(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
  const text = fs.readFileSync(file, 'utf8');
  fs.rmSync(file, { force: true });
  return text;
}

function readPreviewInput(file) {
  const stat = refuseLinked(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
  const text = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '').slice(0, 200);
  fs.rmSync(file, { force: true });
  return text;
}

function consumeMove() {
  const text = plainText(path.join(__dirname, '..', 'preview-move.txt'));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    return { x: parsed.x, y: parsed.y };
  } catch {
    return null;
  }
}

function readPositionText() {
  const stat = refuseLinked(positionFile);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return '';
  return fs.readFileSync(positionFile, 'utf8');
}

function readPositionBytes() {
  const stat = fs.lstatSync(positionFile);
  if (stat.nlink > 1) throw new Error('unsafe_path');
  return fs.readFileSync(positionFile, 'utf8');
}

function readPosition() {
  const stat = refuseLinked(positionFile);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
  let failure = null;
  const value = readWidgetPosition(() => stat, () => {
    try {
      return readPositionBytes();
    } catch (error) {
      failure = error;
      throw error;
    }
  });
  if (failure) throw failure;
  return value;
}

function positionWritable() {
  if (!fs.existsSync(positionFile)) return true;
  const stat = fs.lstatSync(positionFile);
  return stat.isFile() && !stat.isSymbolicLink();
}

function screenDisplays() {
  return screen.getAllDisplays().map((display) => ({
    id: String(display.id),
    bounds: display.bounds,
    workArea: display.workArea,
  }));
}

function writeFileSync(file, text) {
  let stat = null;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (stat && stat.nlink > 1) throw new Error('unsafe_path');
  fs.writeFileSync(file, text);
}

function savePosition() {
  if (!mainWindow || mainWindow.isDestroyed() || !positionWritable()) return;
  const bounds = mainWindow.getBounds();
  const expanded = readPosition()?.expanded === true;
  const placed = placedWidgetOnDisplays(JSON.stringify({ x: bounds.x, y: bounds.y, expanded }), screenDisplays());
  writeFileSync(positionFile, `${JSON.stringify(storedPosition({ x: placed.x, y: placed.y }, placed.expanded))}\n`);
}

function storedPosition(placed, expanded) {
  return expanded ? { ...placed, expanded: true } : placed;
}

function resizeWidget(expanded) {
  const win = createWindow();
  const frame = widgetFrame(expanded);
  const bounds = win.getBounds();
  const placed = placedWidgetOnDisplays(JSON.stringify({ x: bounds.x, y: bounds.y, expanded }), screenDisplays());
  win.setBounds({ x: placed.x, y: placed.y, width: frame.width, height: frame.height });
  if (positionWritable()) writeFileSync(positionFile, `${JSON.stringify(storedPosition({ x: placed.x, y: placed.y }, frame.expanded))}\n`);
  win.show();
}

function ensureTray() {
  if (!widget || tray) return;
  const icon = nativeImage.createFromBuffer(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGPQz/cjCTGMahjVMHw1AABZN+wBaO9x6QAAAABJRU5ErkJggg==',
    'base64',
  ));
  tray = new Tray(icon);
  tray.setToolTip(config.title || 'Widget');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: () => { const win = createWindow(); win.show(); } },
    { label: 'Expand', click: () => resizeWidget(true) },
    { label: 'Compact', click: () => resizeWidget(false) },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const displays = widget ? screenDisplays() : [];
  const placed = displays.length > 0 ? placedWidgetOnDisplays(readPositionText(), displays) : null;
  const frame = placed ? widgetFrame(placed.expanded) : widgetFrame(false);
  mainWindow = new BrowserWindow({
    width: widget ? frame.width : 1100,
    height: widget ? frame.height : 760,
    x: placed ? placed.x : undefined,
    y: placed ? placed.y : undefined,
    minWidth: widget ? WIDGET_WIDTH : 760,
    minHeight: widget ? WIDGET_HEIGHT : 560,
    frame: !widget,
    transparent: false,
    alwaysOnTop: widget,
    title: config.title,
    backgroundColor: '#f7f8f5',
    webPreferences: {
      preload: path.join(__dirname, notesOnly ? 'notes-preload.cjs' : 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!allowNavigation(url, path.join(__dirname, '..'))) event.preventDefault();
  });
  if (process.env.LOAM_PREVIEW_READY && path.isAbsolute(process.env.LOAM_PREVIEW_READY)) {
    const readyFile = process.env.LOAM_PREVIEW_READY;
    const markReady = () => {
      const nonce = process.env.LOAM_PREVIEW_NONCE;
      if (fs.existsSync(readyFile) || !/^[a-f0-9]{32}$/.test(nonce || '')) return;
      writeFileSync(readyFile, `${nonce}\n`);
    };
    mainWindow.webContents.once('did-fail-load', (_event, code, description) => {
      writeFileSync(`${readyFile}.error`, `${code} ${description}\n`);
    });
    mainWindow.webContents.once('did-finish-load', () => {
      const typed = readPreviewInput(path.join(__dirname, '..', 'preview-input.txt'));
      const script = `(() => {
        const note = document.querySelector('#note');
        const typed = ${JSON.stringify(typed)};
        if (note && typeof typed === 'string' && typed) {
          note.value = typed;
          note.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return JSON.stringify({
          requireType: typeof window.require,
          processType: typeof process,
          note: note ? note.value : null,
          dir: document.documentElement.getAttribute('dir')
        });
      })()`;
      mainWindow.webContents.executeJavaScript(script).then(async (raw) => {
        await mainWindow.webContents.session.flushStorageData();
        const page = JSON.parse(String(raw));
        const requestedMove = widget ? consumeMove() : null;
        const closeRequested = plainText(path.join(__dirname, '..', 'preview-close.txt')) !== null;
        const showRequested = plainText(path.join(__dirname, '..', 'preview-show.txt')) !== null;
        if (requestedMove && !mainWindow.isDestroyed()) {
          mainWindow.setBounds({ x: requestedMove.x, y: requestedMove.y, width: WIDGET_WIDTH, height: WIDGET_HEIGHT });
          await new Promise((resolve) => setTimeout(resolve, MOVE_DEBOUNCE_MS + 150));
        }
        const expandRequested = widget && plainText(path.join(__dirname, '..', 'preview-expand.txt')) !== null;
        const compactRequested = widget && plainText(path.join(__dirname, '..', 'preview-compact.txt')) !== null;
        if (expandRequested && !mainWindow.isDestroyed()) resizeWidget(true);
        if (compactRequested && !mainWindow.isDestroyed()) resizeWidget(false);
        if ((expandRequested || compactRequested) && !mainWindow.isDestroyed()) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        const bounds = mainWindow.getBounds();
        const alwaysOnTop = mainWindow.isAlwaysOnTop();
        if (!mainWindow.isVisible()) mainWindow.show();
        const visible = mainWindow.isVisible();
        if (closeRequested) mainWindow.close();
        const visibleAfterClose = mainWindow.isDestroyed() ? false : mainWindow.isVisible();
        if (showRequested && mainWindow && !mainWindow.isDestroyed()) createWindow().show();
        const after = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : bounds;
        const probe = {
          ...page,
          width: bounds.width,
          height: bounds.height,
          x: after.x,
          y: after.y,
          saved: readPosition(),
          workArea: screen.getPrimaryDisplay().workArea,
          alwaysOnTop,
          visible,
          visibleAfterClose,
          visibleAfterShow: showRequested && mainWindow && !mainWindow.isDestroyed() ? mainWindow.isVisible() : null,
          destroyed: !mainWindow || mainWindow.isDestroyed(),
        };
        writeFileSync(`${readyFile}.probe`, `${JSON.stringify(probe)}\n`);
        markReady();
      }).catch((error) => {
        writeFileSync(`${readyFile}.error`, `${error && error.message ? error.message : 'probe'}\n`);
      });
    });
  }
  mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  mainWindow.on('close', (event) => {
    if (!widget || quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  const scheduleSave = () => {
    if (!widget) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(savePosition, MOVE_DEBOUNCE_MS);
  };
  mainWindow.on('move', scheduleSave);
  mainWindow.on('moved', scheduleSave);
  return mainWindow;
}

app.whenReady().then(() => {
  createWindow();
  ensureTray();
  store.startReminders?.();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (!widget) app.quit(); });
