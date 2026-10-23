# "Loam Video" editor integration (branch `mf/filmint`)

The vendored "Loam Video" wasm video editor runs inside Loam as a
**Video** side panel. This document describes the wiring, the agent bridge
mapping, and the branding rules for this staging integration.

## Layout

| Path | What it is |
| --- | --- |
| `electron/filmcraft/dist/` | Vendored web build (untracked). Files: `index.html`, `filmcraft_web.js`, `filmcraft_web_bg.wasm`, `audio-worklet.js`, `favicon.png`. Fetched with `npm run vendor:filmcraft` (see `docs/vendor-dists.md`). |
| `scripts/vendor/fetch-filmcraft.mjs` | Reproducible fetch: pinned GitHub release, sha256-verified, `LOAM_FILMCRAFT_ZIP`/`LOAM_FILMCRAFT_URL`/`LOAM_FILMCRAFT_SHA256` overrides, `--force`, `--from-source`. |
| `electron/filmcraft/bridge-relay.js` | postMessage relay injected into the editor page (served from the overlay root, survives dist re-copies). |
| `electron/filmcraft/rebrand.mjs` | Idempotent branding script — `node electron/filmcraft/rebrand.mjs [distDir]`, run automatically by the fetch script. |
| `electron/filmcraft/` licence files | Intentionally absent (`LICENSE-MIT`, `LICENSE-APACHE`, `NOTICE`, `ATTRIBUTION.md` removed) — Loam is a private, local, non-commercial project. |
| `packages/web/src/app/app/video/page.tsx` | The Video side panel (route `/app/video`). |
| `packages/web/src/lib/filmcraft.ts` | Typed agent bridge. |
| `packages/web/src/components/shell/Sidebar.tsx` | Gained a "Video" nav entry. |

## Electron: the `loamfilm://` scheme

Registered in `electron/main.cjs` (before `app.ready`):

```js
protocol.registerSchemesAsPrivileged([
  { scheme: "app", ... },                                    // existing, untouched
  { scheme: "loamfilm", privileges: { standard: true, secure: true,
                                      supportFetchAPI: true, stream: true } },
]);
```

After `app.whenReady`, `protocol.handle("loamfilm", ...)` serves files from
`electron/filmcraft/dist` (with `electron/filmcraft/` as an overlay fallback for
`bridge-relay.js`). MIME types: `.wasm` → `application/wasm`, `.js`/`.mjs` →
`text/javascript`, `.html` → `text/html`, `.json` → `application/json`,
`.png` → `image/png`. HTML responses get `<script src="bridge-relay.js"></script>`
injected before `</head>` so the host page can drive the editor without editing
the dist files. The existing `app://` handler and all auth logic are unchanged.

The panel loads `loamfilm://app/index.html` in an iframe. The spike proved the
editor needs: privileged custom scheme, `.wasm` served as `application/wasm`,
`contextIsolation` on, and no COOP/COEP (single-threaded WebGPU).

## Agent bridge (`packages/web/src/lib/filmcraft.ts`)

`FilmcraftBridge` wraps one iframe and talks to the injected relay over
`postMessage`. The engine API (`window.filmcraft` inside the iframe) exposes
async methods: `execute`, `commands`, `inspect`, `info`, `screenshot`,
`importFiles`, `importUrl`, `openProject`, `readFile`, `files`.

### Command mapping

| Bridge function | Engine call |
| --- | --- |
| `newProject(params?)` | `execute({command: "file.newProject", params})` |
| `newSequence(params?)` | `execute({command: "file.newSequence", params})` |
| `importUrl(url, options?)` | `filmcraft.importUrl(url, options?)` (direct method) |
| `razorCut(params)` | `execute({command: "timeline.razor", params})` |
| `addEdit(params)` | `execute({command: "sequence.addEdit", params})` |
| `export(params?)` | `execute({command: "export", params})` |
| `execute(command, params)` | `execute({command, params})` (generic) |
| `commands()` / `inspect()` / `info()` / `screenshot()` / `files()` / `readFile(...)` / `importFiles(...)` / `openProject(...)` | direct methods |

Exact `params` shapes are engine-defined; use `await bridge.commands()` to
enumerate the supported commands and their ids at runtime (ids look like
`file.newProject`, `file.newSequence`, `sequence.addEdit`, `timeline.razor`,
`export`).

### postMessage protocol

Host → relay: `{ type: "filmcraft:call", id, method, args }`
Relay → host: `{ type: "filmcraft:ready", hasApi }` (once the engine boots)
and `{ type: "filmcraft:result", id, ok, result? , error? }` per call.

The relay (`electron/filmcraft/bridge-relay.js`) polls for `window.filmcraft`
(boot is async), then announces readiness; every call is awaited and answered
by `id`.

## Branding ("Loam Video")

User-visible upstream branding strings in the vendored copy are replaced
with "Loam Video":

- `index.html`: `<title>`, loading text, fatal-error headings. The favicon
  `<link rel="icon">` and the loading-screen logo `<img>` are removed (no
  replacement icon), so no upstream logo is shown.
- `filmcraft_web_bg.wasm`: same-length in-place byte replacement inside the
  **data section only** — the upstream app name becomes `Loam Video` (10→10
  bytes) and the upstream studio name becomes `LoamFilm` (8→8 bytes, matches
  the scheme name). Same-length
  patching keeps Rust string literal lengths (and therefore the module) valid;
  the script aborts if any hit falls outside the data section.

After copying a fresh dist, run:

```
node electron/filmcraft/rebrand.mjs
```

The vendored licence/attribution files (`LICENSE-MIT`, `LICENSE-APACHE`,
`NOTICE`, `ATTRIBUTION.md`) have been removed: Loam is a private, local,
non-commercial project. Engine-internal identifiers (`window.filmcraft`,
`filmcraft_*` canvas/loader globals, JS glue filenames, the
`filmcraft-output` AudioWorklet processor name) are API surface, not branding,
and are left untouched so the bridge and loader keep working.

## Refreshing the vendored dist

Run the fetch script — it downloads the pinned release, verifies its sha256,
extracts the web root, drops licence/hosting/README files and rebrands:

```
npm run vendor:filmcraft          # or: node scripts/vendor/fetch-filmcraft.mjs --force
```

The dist is gitignored; `npm run vendor` fetches both editors. See
`docs/vendor-dists.md` for overrides and the EffectCraft sources.