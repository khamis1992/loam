# D1 — Design Studio surface (clean-room) — report

Branch: `mf/d1`. Commits: `55a8a6e` (server core + tool + routes + tests + registration), `b99836d` (web page).

## What was built (original TS; behavioral-spec clean-room, no ArtCraft code/assets/names)

### Backend
- `src/server/designStudio.ts` — core domain:
  - **Brand kit model**: `{id,name,colors{primary,secondary,accent,background,text},fonts{heading,body},logoRefs[],createdAt,updatedAt}`; hex-validated (#RRGGBB, falls back per-field), persisted through the existing `sqliteStore` entity store (`kind="design_brand_kits"`, `design_outputs`) — idempotent, no migrations needed.
  - **Templated layouts (JSON)**: `DESIGN_TEMPLATES` = `poster` (800×1200), `banner` (1600×640), `social_card` (1080×1080); slots bind `colorRole`/`fontRole` to the brand kit.
  - **Fill + render**: `parseBrief`, `fillTemplate` (pure, deterministic), `renderSpecToSvg` (original SVG layout: title wrap, subtitle, hashtag badge, logo/image block), `generateDesign` writes `<id>.json` spec + `<id>.svg` (+ best-effort PNG via the existing `sharp` dependency) under `DATA_DIR/design/`.
  - **Injected image tool**: `generateDesign(input, { imageGen })` / `createDesignStudioTools({ imageGen })`. `ImageGenFn = ({prompt, spec, brand, template}) => Promise<{imageBase64Png?, svg?, note?}>`. Not wired in `index.ts` yet (no image model exists in-repo); builtin SVG/PNG is the fallback so the tool always produces a real artifact.
- `src/tools/designStudio.ts` — agent tools:
  - `design_create {brief, templateId?, brandKitId?}` → `{designId, template, brandKit, generator, specFile, svgFile, imageFile, workspaceCopy, preview, hint}`; mirrors the SVG into `<task workspace>/design/` when a task is active.
  - `design_brand_kit_save {name, id?, colors?, fonts?, logoRefs?}` → full kit JSON.
  - `DESIGN_STUDIO_TOOL_NAMES` exported.
- `src/server/routes/designStudio.ts` — `handleDesignStudioRoutes(req,res,p,ctx)` (returns `false` outside `/api/design/`):
  - `GET /api/design/templates` → `{templates}`
  - `GET/POST /api/design/brand-kits` → `{kits}` / `{kit}`; `GET/PUT/DELETE /api/design/brand-kits/:id` → `{kit}` / `{deleted}`
  - `POST /api/design/generate {brief, templateId?, brandKitId?}` → `{design, spec}` (400 on bad input)
  - `GET /api/design/outputs?limit=` → `{designs}`; `GET /api/design/outputs/:id` → `{design}`; `GET /api/design/outputs/:id/image` → PNG (preferred) or SVG bytes, `no-store`, nosniff.

### Tool exposure (recipe from MF1)
- `src/index.ts`: `rt.registry.registerAll(createDesignStudioTools());` (+1 import line) — `src/setup/runtime.ts` untouched (owned elsewhere).
- `"design_create"` and `"design_brand_kit_save"` added to `ALWAYS_ON_TOOLS` in `src/server/runTools.ts`.
- `src/server/__tests__/runTools.test.ts` extended (2 lines) so the root-cause loop registers the design tools.

### Web UI (minimal, existing tokens)
- `packages/web/src/app/app/design/page.tsx` — `/app/design`: brand-kit list + create form (name, 5 color pickers, heading/body fonts, logo ref), generate panel (brief textarea, template + brand-kit selects, Generate button), result grid with live previews via `/api/design/outputs/:id/image`. Tailwind tokens only (`bg-bg-main`, `rounded-card`, `border-border-main`, `text-text-*`, `h-row`), `t()` on all labels (keys fall back to English literals — no i18n json edits). Sidebar not touched (shared component); navigate via URL.

## Supervisor: http.ts mount (not edited, per parallel-worktree rule)
Add next to the other route imports (near lines 76–80):
```ts
import { handleDesignStudioRoutes } from "./routes/designStudio.js";
```
and next to the other dispatches (near line 1633–1635):
```ts
        if (await handleDesignStudioRoutes(req, res, p)) return;
```

## Verification
- `npx tsc --noEmit` (root): 0 errors. `npx tsc --noEmit -p packages/web/tsconfig.json`: 0 errors.
- `npx tsx --test src/server/__tests__/*.test.ts`: 66/66 pass (incl. 11 new design tests: template fill determinism, brand kit storage round-trip/validation, generate + injected imageGen, always-on exposure into the model tool list, tool end-to-end).
- `npm run check:encoding`: OK.
- Live smoke (standalone server over the route module): templates/kit POST/generate OK, `GET .../image` → 200 `image/png` (~97 KB via sharp), bad brief → 400, unknown id → 404.
- `npm run build` in packages/web fails with the known worktree Turbopack `next/package.json` junction error (documented in the task; web tsc relied on instead).

## How to test live (after the 2 http.ts lines are mounted)
1. `npm start`, open `/app/design`.
2. `curl -s -X POST localhost:3939/api/design/brand-kits -d '{"name":"Acme","colors":{"primary":"#22aa55"}}' -H 'content-type: application/json'`
3. `curl -s -X POST localhost:3939/api/design/generate -d '{"brief":"Poster for the weekend food fair"}' -H 'content-type: application/json'` → open the returned `svgFile` or `GET /api/design/outputs/<id>/image`.
4. In an agent task: ask the companion to `design_create {brief:"..."}` — it appears in every mode/work-mode run list.

## What's left
- Mount the 2 http.ts lines (supervisor).
- Wire a real injected `imageGen` (no in-repo image model exists today; builtin SVG→PNG via sharp is the current generator).
- Optional: sidebar link + ar.json keys; NOTICE credit not required — nothing ArtCraft-derived was copied (clean-room from behavioral spec).
