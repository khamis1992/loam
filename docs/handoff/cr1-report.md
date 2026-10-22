# CR1 — Loam Studio Host (clean-room, replaces artcraft-services; ARTCRAFT_ANALYSIS §7 S-SERVICES)

Branch `mf/cr1`. Commits: `c79c289` (host module), `589390d` (routes + tests).

## Files (new only — no shared files touched, http.ts untouched)
- `src/tools/loamStudioHost.ts` — studio registry + command proxy (pure TS, no deps).
- `src/server/routes/studioHost.ts` — HTTP route module `handleStudioHostRoutes(req, res, p, ctx?)`.
- `src/server/__tests__/studioHost.test.ts` — 12 unit tests (registry, proxy, routes; mock engine via injected resolver).

NOTICE credit comments live at the top of both new source files. Clean-room: only the
behavioral description was used (list studios; proxy `{id, params}` to an engine;
`list_commands` self-describing catalog; safe `enabled()`-reason failures). No Rust/wasm,
no ArtCraft names/assets.

## API
- `GET /api/studio` → `{ studios: [{ app, title, description?, available, reason?, commands: string[] }] }`
  (apps from the fixed set `video|doc|sheet|slides|design`; `reason` present only when unavailable).
- `POST /api/studio/:app/command` body `{ id, params? }` →
  - `{ ok: true, commands: StudioCommandSpec[] }` when `id === "list_commands"` (200; works even if engine disabled — catalog is metadata)
  - `{ ok: true, data: ... }` after a declared command runs (200)
  - `{ ok: false, error: "studio_disabled", reason }` — safe, one-line, ≤240-char reason (200, proxy semantics)
  - `{ ok: false, error, commandId }` for undeclared commands (200)
  - 404 `{ ok: false, error: 'unknown studio app "<app>"', app }`; 400 malformed body/id; 405 non-POST.
- Engine contract: `enabled(): {enabled, reason?}`, `commands(): StudioCommandSpec[]`, `run(id, params)`;
  engines are only allowed to run commands they declared.

## Coexistence with existing /api/studio (IMPORTANT)
http.ts already serves `GET|POST /api/studio?taskId=…` (studio-artifact read/save), plus
`/api/studio/import|export|preview|slide-preview`. The new module **returns `false`** for
`GET /api/studio` when `taskId` is present and for all other `/api/studio/*` forms, so the
legacy handlers keep working unchanged.

## 2 lines the supervisor must add to src/server/http.ts
1) With the other route imports (near `import { handleAgentSpawnRoutes } …`):
   `import { handleStudioHostRoutes } from "./routes/studioHost.js";`
2) Dispatch — place **before** the `if (p === "/api/studio/import" …)` block (~line 2086):
   `if (await handleStudioHostRoutes(req, res, p)) return;`

## Engine injection
Default lookup is the module registry (`registerStudioEngine(engine)` at boot).
For tests/overrides the route also accepts `ctx.studioEngineResolver: (app) => engine|undefined`
(the http dispatcher may pass it; nobody calls that yet).

## How to test
- Unit: `node --import tsx --test src/server/__tests__/studioHost.test.ts` → 12 pass.
- Full server suite: all 67 tests pass. `npx tsc --noEmit` → 0; web `tsc -p packages/web/tsconfig.json` → 0.
- Live (after supervisor mounts the 2 lines): register an engine, then
  `curl http://127.0.0.1:3939/api/studio` and
  `curl -X POST http://127.0.0.1:3939/api/studio/doc/command -d '{"id":"list_commands"}'`.

## Left / out of scope
- No real engines registered yet (video/doc/sheet/slides/design adapters are follow-up tasks;
  the old src/studio artifact pipeline is untouched and independent).
- No agent-tool wrapper exposed: this is an HTTP host; per MF1 recipe, a follow-up can add a
  `studio_command` agent tool routing through runTools.ts/approvals if agents must reach it.
- `npm run build` in packages/web fails with the known worktree Turbopack `next/package.json`
  junction error (no web files changed; relied on web tsc per task instructions).
