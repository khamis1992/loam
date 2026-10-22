# Loam Craft apps (Loam Docs / Sheets / Slides / Photo / Design)

Loam embeds the original ArtCraft applications, vendored as wasm web builds and
rebranded, so a file attached in chat opens directly in the matching editor in
the Workspace panel. The apps are driven live by the agent over a
`craft:*` postMessage bridge; the user can also edit by hand and export from
the panel or by asking in chat.

This document covers the vendored dists, the `loamcraft://` scheme, the fetch
scripts and the layout. The web-side bridge (`packages/web/src/lib/craft.ts`) and
the Workspace registration are added by cr-02/cr-03.

## Apps and branding

| Internal id | User-facing name | Formats |
| --- | --- | --- |
| `wordcraft` | Loam Docs | docx / doc / odt / rtf / md / html |
| `gridcraft` | Loam Sheets | xlsx / csv / ods |
| `deckcraft` | Loam Slides | pptx / odp / key |
| `photocraft` | Loam Photo | psd / png / jpg / webp / tiff / raw / heif |
| `designcraft` | Loam Design | idml / pdf / epub / pptx export |

The user-facing names are exactly **Loam Docs, Loam Sheets, Loam Slides, Loam
Photo, Loam Design**. Never show WordCraft / GridCraft / DeckCraft / PhotoCraft /
DesignCraft in the UI, prompts or tool descriptions. Internal ids and engine
globals keep the `wordcraft` / `gridcraft` / ... names.

## Bridge protocol (postMessage, iframe URL must contain `loam=1`)

- host → app: `{type:'craft:call', id, method, params}` ; `{type:'craft:open', name, bytes:Uint8Array}` (same path as a dropped file)
- app → host: `{type:'craft:ready', app, version}` ; `{type:'craft:result', id, ok, result?, error?}` (result is the control reply, usually `{ok:true, result:...}`) ; `{type:'craft:save', app, name, bytes:Uint8Array}` — EVERY save/export (`file.save`, `file.saveAs`, `file.exportPdf`…) is handed to the host instead of downloading.
- Only messages whose source is `window.parent` are accepted.

The bridge lives in the app itself: `scripts/vendor/craft/loam_bridge.rs` is
compiled into each wasm build (applied by `scripts/vendor/craft/apply_patch.py`).
Unlike Loam Video there is no injected relay overlay.

Verified save/export paths: Loam Docs/Sheets `file.save`; Loam Slides
`file.save` (native) or `app.saveAsDialog {format:'pptx'}`; Loam Photo/Design use
the UI-level export commands (routed to `craft:save`). Opening is
`{type:'craft:open', name, bytes}` (Design: `file.new {preset:'A4'}`).

## Layout

| Path | What it is |
| --- | --- |
| `scripts/vendor/craft/` | Source of truth for the patch: `loam_bridge.rs`, `apply_patch.py`, `rebrand_src.py`, `build-craft-web.sh`, `manifest.json`. |
| `scripts/vendor/fetch-craft.mjs` | CLI: fetch and install the dists. |
| `scripts/vendor/lib/` | Shared, dependency-free zip/vendor helpers (also used by `fetch-filmcraft.mjs` and `fetch-effectcraft.mjs`). |
| `electron/craft/<app>/dist/` | Installed dist (gitignored). Contains the bundle, e.g. `index.html`, `<app>_web_bg.wasm`, and Photo's `app/` parts, plus a `.vendor.json` sidecar. |
| `electron/vendorProtocol.cjs` | Shared static-file serving for `loamfilm://` and `loamcraft://`. |
| `src/server/craftStatus.ts`, `src/server/routes/craft.ts` | `GET /api/craft/status` and the startup availability check. |
| `electron/filmcraft/` | Loam Video dist + overlay (existing, shared helper only). |

## Fetch / build

```sh
# All five apps (sources: LOAM_CRAFT_<APP>_ZIP, then ~/Desktop/loam-vendor/<zip>)
npm run vendor:craft

# One app, force a re-install, or build from source (needs bash, cargo, trunk)
node scripts/vendor/fetch-craft.mjs wordcraft --force
node scripts/vendor/fetch-craft.mjs --from-source
```

- Sources are tried in order: `LOAM_CRAFT_<APP>_ZIP` (upper-case app id, e.g.
  `LOAM_CRAFT_WORDCRAFT_ZIP`) local zip path, then the cached
  `~/Desktop/loam-vendor/<zip>` from `scripts/vendor/craft/manifest.json`
  (sha256 verified; a mismatch aborts that app). `--from-source` clones the
  pinned upstream repo, applies the bridge patch + rebrand, and builds with
  Trunk. Extraction and installation reuse the shared, dependency-free helpers
  in `scripts/vendor/lib/` (the same zip/vendor code the Loam Video fetchers
  use), so no external `tar`/`unzip` tool is required.
- The zip's single top folder is installed as `electron/craft/<app>/dist`
  (nested folders such as Photo's `app/` parts are preserved) and
  `dist/.vendor.json` is written with `{app, rev, sha256, source, fetchedAt}`.
  Vendored licence/README/attribution files are pruned. An existing dist is
  skipped unless `--force`.
- When nothing is available the app is skipped and Loam falls back to its own
  editor for that file type. Nothing is downloaded on `npm install`.

## Electron: the `loamcraft://` scheme

Registered in `electron/main.cjs` (before `app.ready`) alongside `loamfilm`:

```js
protocol.registerSchemesAsPrivileged([
  { scheme: "loamfilm", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: "loamcraft", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
```

`protocol.handle("loamcraft", ...)` serves `loamcraft://<app>/<path>` from
`electron/craft/<app>/dist` for the five allowed app ids only (404 otherwise),
with path-traversal protection and correct MIME types (`.wasm`
`application/wasm`, `.js` `text/javascript`, `.html`, `.png`, `.ico`, `.ttf`,
`.woff2`, unknown `application/octet-stream`). File resolution and MIME mapping
are shared with `loamfilm://` through `electron/vendorProtocol.cjs`; Loam Video
behaviour is unchanged.

## Availability to the app

`GET /api/craft/status` returns `{ apps: [{ app, name, installed, rev, source }] }`
for the five apps, read from each dist's `.vendor.json`. The web panel uses this
to choose the Craft app or the Loam fallback editor. On startup the server logs
how to fetch any missing dist (never auto-downloads).
