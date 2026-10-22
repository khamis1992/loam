# W1 Report — One-click deploy + export for built apps

Branch: `mf/w1` (worktree). All work is original TypeScript/Node written for Loam; no ArtCraft code, assets or brand names were used and no Rust/wasm dependency was introduced.

## What was added

### New files
| File | Purpose |
|---|---|
| `src/preview/zip.ts` | Original minimal ZIP writer (deflate, store fallback, CRC32 table, central dir + EOCD). No external dependency. Exports `zipBuffer`, `collectFiles`, `zipDirectory`. Symlinks are skipped, mirroring the preview server's listing behavior. |
| `src/preview/deploy.ts` | Deploy/export service: `resolveBuildOutput(root)` (scans `dist/`, `build/`, `out/`, `www/`, then root `index.html`), `exportBuild(root, taskId)` (zips build output into `<taskWorkspace>/.loam/exports/deploy-<id>-<stamp17>.zip`), the pluggable `DeployTarget` interface, `createLocalDeployTarget({distRoot, serve?, writer?})`, `settle`-free atomic copy (`<distRoot>/<taskId>/<stamp>` via `.deploying` tmp + rename), `deployBuild`, and honest cloud stubs `createVercelDeployTarget` / `createNetlifyDeployTarget` that return `missingEnv` (VERCEL_TOKEN / NETLIFY_AUTH_TOKEN) and never publish. |
| `src/tools/deploy.ts` | Agent tools `deploy_app` and `export_build` (+ `deployTargetCatalog(deps)` helper wiring the local target to `PreviewService.start` when a preview is provided). |
| `src/server/routes/deploy.ts` | HTTP routes (see below). Mount lines for `src/server/http.ts` are reported below (file NOT edited, per parallel-worktree rules). |
| `src/preview/__tests__/deploy.test.ts` | Unit tests: independent central-directory reader round-trips zip entries; recursive dir zip with symlink skip; build discovery order; export zip (PK signature, staging excluded); local target deploy (file:// URL + serve hook + history dirs + no staging leftovers); cloud stubs report missing creds; no-build error. |
| `src/server/__tests__/deployTool.test.ts` | Tool exposure test: `deploy_app`/`export_build` enter the effective run tool list via `mergeAlwaysOnTools`, denial still wins; end-to-end tool run against a real DB-backed task workspace (export zip + local deploy + files on disk); honest failure without build; vercel stub reports `missingEnv=["VERCEL_TOKEN"]`. |

### Minimal edits to shared files
- `src/index.ts` (+2 lines: import + one `rt.registry.registerAll(createDeployTools({ workspace: cfg.workspace, preview: rt.preview }))`).
- `src/server/runTools.ts` (+2 entries in `ALWAYS_ON_TOOLS`: `deploy_app`, `export_build` — low-risk local tools, no approval gate needed).
- `src/server/__tests__/runTools.test.ts` (+2 lines: the fixture registry now registers the real deploy tools so its "every ALWAYS_ON name is registered" invariant holds).

`src/server/http.ts` was **not edited**.

## Tools

### `deploy_app` `{taskId: string, target?: string}` (target default `"local"`)
Response (JSON content string):
```json
{ "ok": true, "target": "local", "url": "http://127.0.0.1:<port>/", "distDir": "<abs>", "zipPath": "<abs>", "exportBytes": 132, "files": 1, "missingEnv": [], "message": "..." }
```
- `local`: copies the build output to `<workspace>/.loam-deploy/<taskId>/<stamp>/`, starts `PreviewService` on it (`url`), writes a zip; without a preview available it returns a `file://` URL to `index.html`.
- `vercel` / `netlify`: stubs → `ok:false`, `missingEnv` populated, never publishes; if creds exist they still refuse honestly ("cloud publishing not enabled in this build").

### `export_build` `{taskId: string}`
Response: `{ ok: true, zipPath, bytes, fileCount, buildDir }` — zip only, no deploy.

## HTTP routes (routes module only)

- `GET /api/deploy/targets` → `{ targets: [{ id, label, kind, requiredEnv, configured }] }`
- `POST /api/tasks/:id/deploy` body `{ target? }` → deploy result JSON (`200` on success, `400` no-build/unknown-target, `409` on stub refusal with creds context)
- `GET /api/tasks/:id/export` → the ZIP as `application/zip` attachment

**Exact mount lines for the supervisor to add to `src/server/http.ts`** (confirmed clean at time of writing):
```ts
import { handleDeployRoutes } from "./routes/deploy.js";
```
(after the other `./routes/*` imports near line 80) and the dispatch:
```ts
if (await handleDeployRoutes(req, res, p, { workspace: cfg.workspace, ...(preview ? { preview } : {}) })) return;
```
placed directly after `if (await handleSchedulesRoutes(req, res, p)) return;` (line ~1637), before the generic `/api/agents/` handlers.

## Verification
- `npx tsc --noEmit` (root) → 0 errors.
- `npx tsc --noEmit -p packages/web/tsconfig.json` → 0 errors.
- `npx tsx --test <all src/**/*.test.ts>` → 84 tests, 0 failures.
- `npx tsx src/scripts/check-encoding.ts --run` → OK.
- Live smoke (throwaway harness): `GET /api/deploy/targets` shows `local(local,configured=true), vercel(cloud,configured=false), netlify(cloud,configured=false)`; `POST …/deploy` → 200 with `file://` URL + zip; `GET …/export` → 200 `application/zip`.
- `npm run build` in `packages/web` fails with the **known** worktree Turbopack junction error (`Could not find the Next.js package`) even via webpack mode; per task notes this is accepted and web tsc is the gate.

## How to test live
1. Run Loam (`npm run dev`), create a task, build anything producing `dist/index.html` into the task workspace, then either:
   - ask the agent `deploy_app {taskId}` / `export_build {taskId}`, or
   - `POST /api/tasks/<id>/deploy` (see deploy preview URL in response) and `GET /api/tasks/<id>/export` to download the zip.

## What's left
- Real Vercel (`vercel` CLI upload via token) and Netlify (`/api/v1/sites` deploy with NETLIFY_AUTH_TOKEN + NETLIFY_SITE_ID) adapters: the interface and credential reporting are ready; the HTTP publishing step is intentionally not wired.
- Optional UI button (agents task pane) calling `POST /api/tasks/:id/deploy` — not in this task's scope.
- Pruning of old stamped dist dirs under `.loam-deploy` (history is intentionally kept).
