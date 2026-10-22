# "Loam Effects" engine integration (branch `khamis1992/fc-08`)

EffectCraft is the hidden backend for transitions, effects and text/motion
animation. It runs inside Loam as an iframe served from the privileged
`loameffect://` scheme. This document describes the wiring, the agent bridge
mapping, and the branding rules. The user sees one product ("Loam Effects");
the upstream names never appear in the UI.

## Layout

| Path | What it is |
| --- | --- |
| `electron/effectcraft/dist/` | Vendored web build (untracked; copied in separately by `scripts/vendor/fetch-effectcraft`). |
| `electron/effectcraft/bridge-relay.js` | postMessage relay injected into the engine page (served from the overlay root, survives dist re-copies). |
| `electron/effectcraft/rebrand.mjs` | Idempotent branding script — run it after every fresh dist copy. |
| `packages/web/src/lib/effectcraft.ts` | Typed agent bridge (`EffectcraftBridge`). |

The engine can run in a **hidden iframe** for agent jobs, or in the visible
panel for "Open in effects". The bridge is agnostic to where the iframe lives.

## Electron: the `loameffect://` scheme

Registered in `electron/main.cjs` (before `app.ready`):

```js
protocol.registerSchemesAsPrivileged([
  { scheme: "app", ... },                                    // existing, untouched
  { scheme: "loamfilm", ... },                               // existing, untouched
  { scheme: "loameffect", privileges: { standard: true, secure: true,
                                         supportFetchAPI: true, stream: true } },
]);
```

After `app.whenReady`, `protocol.handle("loameffect", ...)` serves files from
`electron/effectcraft/dist` (with `electron/effectcraft/` as an overlay fallback
for `bridge-relay.js`). MIME types: `.wasm` → `application/wasm`, `.js`/`.mjs`
→ `text/javascript`, `.html` → `text/html`, `.json` → `application/json`,
`.png` → `image/png`.

Every response is served **cross-origin isolated** so the render queue can use
`SharedArrayBuffer` in Web Workers:

```
Cross-Origin-Opener-Policy:    same-origin
Cross-Origin-Embedder-Policy:  require-corp
Cross-Origin-Resource-Policy:  same-origin
```

HTML responses get `<script src="bridge-relay.js"></script>` injected before
`</head>` so the host page can drive the engine without editing the dist files.
The existing `app://` and `loamfilm://` handlers and all auth logic are
unchanged.

## Agent bridge (`packages/web/src/lib/effectcraft.ts`)

`EffectcraftBridge` wraps one iframe and talks to the injected relay over
postMessage. The engine API (`window.effectcraft` inside the iframe) exposes
async methods: `request`, `execute`, `commands`, `inspect`, `renderFrame`,
`screenshot`, `addFile`, `files`, `readFile`, `saveToBrowser`, `info`, `flush`.

| Bridge function | Engine call |
| --- | --- |
| `execute(command, params?)` | `execute({command, params})` |
| `request(method, params?)` | `request(method, params?)` (generic) |
| `commands()` | `commands()` |
| `inspect()` / `info()` | direct methods |
| `renderFrame(...)` / `screenshot()` | direct methods |
| `addFile(...)` / `files()` / `readFile(...)` | direct methods |
| `saveToBrowser(...)` / `flush(...)` | direct methods |
| `call(method, ...args)` | any method (generic passthrough) |

Exact `params` shapes are engine-defined; use `await bridge.commands()` to
enumerate the supported commands and their ids at runtime.

### postMessage protocol

Host → relay: `{ type: "effectcraft:call", id, method, args }`
Relay → host: `{ type: "effectcraft:ready", hasApi }` (once the engine boots)
and `{ type: "effectcraft:result", id, ok, result?, error? }` per call.

The relay (`electron/effectcraft/bridge-relay.js`) polls for
`window.effectcraft` (boot is async), then announces readiness; every call is
awaited and answered by `id`.

## Branding ("Loam Effects")

User-visible upstream branding strings in the vendored copy are replaced:

- `index.html`: `<title>` becomes `Loam Effects`; a final catch-all replaces any
  remaining `EffectCraft` occurrence so no upstream name leaks into the UI.
- `*.wasm`: same-length in-place byte replacement inside the **data section
  only** — `EffectCraft` → `Loam Effect` (11→11 bytes) and `ArtCraft` →
  `LoamFilm` (8→8 bytes). Same-length patching keeps Rust string literal lengths
  (and therefore the module) valid; the script aborts if any hit falls outside
  the data section.

After copying a fresh dist, run:

```
node electron/effectcraft/rebrand.mjs
```

The vendored licence/attribution files (`LICENSE-MIT`, `LICENSE-APACHE`,
`NOTICE`, `ATTRIBUTION.md`) have been removed: Loam is a private, local,
non-commercial project. Engine-internal identifiers (`window.effectcraft`,
`effectcraft_*` globals, JS glue filenames) are API surface, not branding, and
are left untouched so the bridge and loader keep working.

## Refreshing the vendored dist

1. Copy the upstream web build into `electron/effectcraft/dist/`.
2. Run `node electron/effectcraft/rebrand.mjs`.
3. Delete any licence/attribution files that came with the copy
   (`LICENSE-MIT`, `LICENSE-APACHE`, `NOTICE`, `ATTRIBUTION.md`).

## Tests

- `packages/web/src/lib/__tests__/effectcraft.test.ts` (vitest): bridge
  request/response, failure propagation, typed helpers, `waitForApi` timeout,
  and `dispose`.
- `electron/effectcraft/__tests__/rebrand.test.mjs` (`node --test`): HTML
  rebranding, same-length wasm patching, refusal when a hit falls outside the
  data section, and idempotency.
