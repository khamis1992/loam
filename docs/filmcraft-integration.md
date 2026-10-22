# "Loam Video" editor integration (branch `mf/filmint`)

The vendored "Loam Video" wasm video editor runs inside Loam as a
**Video** side panel. This document describes the wiring, the agent bridge
mapping, and the branding rules for this staging integration.

## Layout

| Path | What it is |
| --- | --- |
| `electron/filmcraft/dist/` | Vendored web build (untracked; copied in separately). Files: `index.html`, `filmcraft_web.js`, `filmcraft_web_bg.wasm`, `audio-worklet.js`. |
| `electron/filmcraft/bridge-relay.js` | postMessage relay injected into the editor page (served from the overlay root, survives dist re-copies). |
| `electron/filmcraft/rebrand.mjs` | Idempotent branding script — run it after every fresh dist copy. |
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

1. Copy the upstream web release into `electron/filmcraft/dist/`.
2. Run `node electron/filmcraft/rebrand.mjs`.
3. Remove the favicon `<link rel="icon">` and the loading-screen
   `<img src="favicon.png">` from `index.html`, then delete `favicon.png`.
4. Delete any licence/attribution files that came with the copy
   (`LICENSE-MIT`, `LICENSE-APACHE`, `NOTICE`, `ATTRIBUTION.md`).

## Agent tool: `video_studio`

`src/tools/videoStudio.ts` is the single agent tool that drives this editor. The
agent never talks to the iframe directly: the tool runs in the Node server and
every step goes through the fc-02 relay
(`src/server/videoStudioRelay.ts` → SSE `video_studio_command` → the attached
panel executes it with `FilmcraftBridge` → `POST
/api/tasks/:id/video-studio/result`).

### Actions

| Action | Relay steps | Notes |
| --- | --- | --- |
| `open` | `commands` | Confirms the bridge is alive and returns the command catalog. |
| `state` | `inspect` | Reads sequences/tracks/clips/playhead. Call it before mutating so manual panel edits are not lost. |
| `import` | `importUrl` (url) or `importFiles` (task file) | A task file is resolved inside the task workspace first. |
| `cut` | `execute` × n | One razor per time; `atSec` accepts a single time or an array. |
| `trim` | `execute` | Requires `fromSec`/`toSec`; an empty range is refused. |
| `delete` | `execute` | Same range plus optional `ripple`. |
| `move` / `reorder` | `execute` | `move` takes `clipId` + `toIndex`; `reorder` takes a full 1-based `order` permutation. |
| `split` | `execute` | Splits at `atSec`. |
| `speed` | `execute` | `clipId` + positive `rate` (1 = normal). |
| `add_text` | `execute` | Title/graphics layer with `position`, `size`, `color`, `atSec`, `durationSec`. |
| `add_audio` / `music` | `importFiles`/`importUrl`, then `execute` | Imports the audio, then places it on the audio track with `gain`, `fadeInSec`, `fadeOutSec`, `trackId`. |
| `transition_basic` | `execute` | FilmCraft-native video transition, falling back to the audio transition id. |
| `effect_basic` | `execute` | `effects.apply` with the effect `name` plus free-form `params`. |
| `undo` | `execute` | History undo. |
| `raw` | `execute` | Any command id, validated against the live catalog. |

### Command-id resolution

The tool never hardcodes a command id. Before issuing a mutating action it asks
the editor for its real catalog (`commands()`) and picks the first id the build
actually exposes from `VIDEO_STUDIO_COMMAND_CANDIDATES`:

| Purpose | Candidates (most-likely first) |
| --- | --- |
| razor / cut | `timeline.razor`, `sequence.razor`, `edit.razor` |
| trim | `timeline.trim`, `sequence.trim`, `clip.trim` |
| delete | `timeline.delete`, `sequence.delete`, `edit.delete` |
| split | `timeline.split`, `sequence.split`, `edit.split` |
| move | `sequence.move`, `timeline.move`, `edit.move` |
| reorder | `sequence.reorder`, `sequence.move`, `timeline.reorder` |
| speed | `clip.speed`, `sequence.speed`, `timeline.speed` |
| add text | `graphics.addText`, `sequence.addText`, `text.add`, `title.add` |
| add audio | `audio.add`, `sequence.addAudio`, `audio.import` |
| video transition | `sequence.applyVideoTransition`, `transition.applyVideo` |
| audio transition | `sequence.applyAudioTransition`, `transition.applyAudio` |
| effect apply | `effects.apply`, `effect.apply` |
| effect param | `effects.setParam`, `effect.setParam` |
| undo | `edit.undo`, `history.undo`, `undo` |

If no candidate is exposed the tool answers with the ids it looked for, the
closest catalog ids (Levenshtein-ranked) and the available command list, so the
agent can retry with `raw`. The mapping is exercised in
`src/tools/__tests__/videoStudio.test.ts`.

### Time arguments

Every time argument accepts seconds (`90`) or timecode (`1:30`, `00:01:30`)
through the shared `parseTimeToken` grammar already used by the fallback editor.

### Fallback contract

When the editor cannot be driven the tool returns `ok: false` with a JSON body
telling the agent what to do next:

| `reason` | When | Body |
| --- | --- | --- |
| `filmcraft_dist_missing` | `electron/filmcraft/dist/index.html` is absent | `fallback: "video_edit"` |
| `bridge_unavailable` | The relay rejects with `TIMEOUT` or any other code | `fallback: "video_edit"` |
| `cancelled` | The task stopped mid-command (`CANCELLED`) | `fallback: "video_edit"` |
| `panel_not_open` | The relay rejects with `PANEL_NOT_OPEN` | `retry: true` (the Workspace panel opens automatically; retry once attached) |

`video_edit` (`src/tools/videoEditAgent.ts`) is the fallback path: it compiles an
edit-decision-list and renders with ffmpeg, so it needs neither the vendored dist
nor the editor bridge.
