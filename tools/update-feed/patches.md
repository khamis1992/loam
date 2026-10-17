# Changes applied to manus-local

Unlike the Manus Studio app, your app is your own Electron project, so enabling
self-update is additive — no reverse-engineered patches are needed. What changed:

## 1. Dependencies
```
electron-updater      (dependency)
electron-builder      (devDependency)
```

## 2. `electron-builder.yml` (new)
`appId: im.manus.local`, `productName: manus-local`, output `release/`,
`asar: false`, `npmRebuild: false`, `publish: { provider: generic, url: <feed> }`,
NSIS oneClick target, `artifactName: manus-local-Setup-${version}.${ext}`.

Why `asar: false`: the main process spawns `dist/server.cjs` with
`ELECTRON_RUN_AS_NODE` and `ROOT = path.resolve(__dirname, "..")`, and the server
reads `ui/` and `skills/` from disk. Unpacked keeps all of that working unchanged.

Why `npmRebuild: false`: your `node_modules` are already the ones that run under
`npm run desktop`; rebuilding them for Electron's ABI is unnecessary here and can
fail without build tools.

## 3. `electron/updater.cjs` (new)
- Reads the feed from `MANUS_LOCAL_UPDATE_URL` or `DEFAULT_FEED_URL`.
- `setFeedURL({ provider: "generic", useMultipleRangeRequest: false })`.
- `autoDownload = true`, `autoInstallOnAppQuit = true`.
- Checks once at startup and every 4 hours.
- Emits state: idle / checking / available / current / downloading / downloaded / error.
- Prompts "إعادة التشغيل الآن / لاحقاً" once per downloaded version.
- Short-circuits with a clear reason when `!app.isPackaged` (unless
  `MANUS_LOCAL_DEV_UPDATE=1`, which sets `forceDevUpdateConfig`).

## 4. `electron/main.cjs` (edited)
- `const updater = require("./updater.cjs");`
- `updater.init({ onStatus })` after the window is created.
- Tray menu + app "ملف" menu: "التحقق من التحديثات…" and
  "تثبيت التحديث وإعادة التشغيل".

## 5. `package.json` (edited)
- `"author"` added (electron-builder requires it).
- `"dist": "npm run build:server && electron-builder --win"`.
- `"dist:publish": "npm run build:server && electron-builder --win --publish always"`.

## Remaining manual step
Set your real feed URL in `electron/updater.cjs` (`DEFAULT_FEED_URL`) and keep
`publish.url` in `electron-builder.yml` in sync. Bump `version`, run
`npm run dist`, upload `latest.yml` + the installer to that URL.
