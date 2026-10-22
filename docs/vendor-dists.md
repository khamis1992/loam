# Vendored editor dists (FilmCraft + EffectCraft)

Loam ships two vendored wasm editors. Neither dist is committed — both are
fetched reproducibly with `npm run vendor` and gitignored.

| Editor | User-facing name | dist path | npm script |
| --- | --- | --- | --- |
| FilmCraft | Loam Video | `electron/filmcraft/dist/` | `npm run vendor:filmcraft` |
| EffectCraft | Loam Effects | `electron/effectcraft/dist/` | `npm run vendor:effectcraft` |

Run `npm run vendor` to fetch both. A fresh clone then works without any manual
copying. Nothing is downloaded during `npm install`.

## `scripts/vendor/fetch-filmcraft.mjs`

Default source: the pinned GitHub release, verified against a fixed sha256.

```
https://github.com/storytold/filmcraft/releases/download/v0.10.0/filmcraft-web-0.10.0.zip
sha256 47618cc373ff1306be17cfd539a33a5a5af490d3bb6722a6bc1436fcd6bf87a0
```

The archive is extracted, the inner web root is copied into
`electron/filmcraft/dist/`, and `electron/filmcraft/rebrand.mjs` is run to strip
upstream branding. `README`, `HOSTING`, licence, `NOTICE`, `ATTRIBUTION`,
`_headers` and `.htaccess` files are dropped (owner decision).

Overrides:

| Variable | Meaning |
| --- | --- |
| `LOAM_FILMCRAFT_ZIP` | Use a local zip instead of the network release. |
| `LOAM_FILMCRAFT_URL` | Use a different release URL. |
| `LOAM_FILMCRAFT_SHA256` | Expected sha256 for the URL (defaults to the pinned value). |
| `LOAM_FILMCRAFT_DIST` | Destination directory (defaults to `electron/filmcraft/dist`). |

Flags: `--force` replaces an existing dist; `--from-source` builds the upstream
repo with `cargo xtask web` instead of downloading a release.

Behaviour:

- **sha mismatch aborts** before anything is written.
- **skips** when `dist/index.html` already exists, unless `--force`.
- writes `dist/.vendor.json` (`{ source, version, sha256, fetchedAt }`).

## `scripts/vendor/fetch-effectcraft.mjs`

EffectCraft has no GitHub release, so sources are tried in order:

1. `LOAM_EFFECTCRAFT_ZIP` — a local zip of the built web dist;
2. `~/Desktop/loam-vendor/effectcraft-web-*.zip` — local cache;
3. `--from-source` — clone `https://github.com/storytold/effectcraft` at pinned
   rev `9db7f3b21700fd821f215782ed1c82afe077880f` into `.cache/vendor/` and run
   `cargo xtask web`.

All built files are copied (`snippets/`, `worker.js`, `sw.js`, `manifest`, …),
and `electron/effectcraft/rebrand.mjs` is run when it exists. `LOAM_EFFECTCRAFT_SHA256`
is optional. When nothing is available the script prints exactly how to obtain
the dist and exits without error — the app falls back gracefully.

Prerequisites for `--from-source`: Rust, the `wasm32-unknown-unknown` target
(`rustup target add wasm32-unknown-unknown`) and `wasm-bindgen-cli 0.2.129`.

## Electron startup check

`electron/main.cjs` prints a non-fatal hint when a dist is missing:

```
[electron] Loam Video dist not found at .../electron/filmcraft/dist.
[electron] Fetch it with: npm run vendor:filmcraft
```

It never downloads anything itself.

## Tests

```
npm run test:vendor
```

Offline unit tests build a tiny synthetic zip fixture and cover sha mismatch,
skip-when-present, the `LOAM_FILMCRAFT_ZIP` path, `.vendor.json`, zip extraction
(stored + deflated) and path-traversal rejection.
