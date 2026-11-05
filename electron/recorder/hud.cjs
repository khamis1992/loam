// Recording countdown and tray dot. Shown only while a Loam Recorder session
// is counting down or capturing. No window titles are displayed.
const { BrowserWindow, Tray, nativeImage } = require("electron");
const path = require("node:path");

const DOT = nativeImage.createFromDataURL(
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOElEQVR4nGO4o6bGQAmmSDMhA/6jYaINQNeI1yBSNWMYQlUDiNWMYsgwM2DgY4EqCYkqSZm+uREAs7yXoHlZFewAAAAASUVORK5CYII=",
);

let tray = null;
let countdown = null;

function closeCountdown() {
  if (countdown && !countdown.isDestroyed()) countdown.close();
  countdown = null;
}

function showCountdown(seconds) {
  if (countdown && !countdown.isDestroyed()) return;
  countdown = new BrowserWindow({
    width: 240,
    height: 140,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
  });
  countdown.loadFile(path.join(__dirname, "countdown.html"), { query: { seconds: String(seconds || 3) } });
  countdown.setIgnoreMouseEvents(true);
}

function showRecording() {
  closeCountdown();
  if (tray) return;
  tray = new Tray(DOT);
  tray.setToolTip("Loam Recorder");
}

function clear() {
  closeCountdown();
  if (!tray) return;
  tray.destroy();
  tray = null;
}

module.exports = { showCountdown, showRecording, clear };
