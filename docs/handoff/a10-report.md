# A10 Wide Research + QA/e2e + Integration — Handoff Report

Agent: A10 (wide research, QA, e2e, and integration)  
Worktree: `C:\Users\khamis\Desktop\manus-parity-wt\a10`  
Branch: `mp/a10-qa-research` (merged into `manus-parity`)

## What was done

### 1. `map_reduce` tool (BUILD_SPEC §8.5.1)
- New `src/tools/mapReduce.ts` implements the `map_reduce` tool contract.
- Accepts a list of `items`, a `prompt` template, an optional `reduce_prompt`,
  `max_workers` (1–20, default 5), and a `batch_size` cap of 500 items.
- Runs map calls concurrently through the existing tool dispatcher, then reduces
  intermediate outputs into a final text result via an LLM call.
- Returns structured output with `outputs` (per-item results) and `result`
  (reduced summary).

### 2. Spec alias adapters (BUILD_SPEC §8.5.1)
- New `src/tools/specAliases.ts` dispatches Manus-style tool names to Loam
  native tools:
  - `terminal` → native bash
  - `text_editor` → read/write/edit
  - `search` → native grep/glob
  - `webpage_extract` → web fetch
  - `browser` → browser tool
  - `plan` → planner
  - `message` → messaging tool
  - `map_reduce` → mapReduce
  - `suggestion` → suggestion tool
  - `idle` → idle/no-op
- Added `strs()` helper to `src/tools/registry.ts` for safe string-array
  normalization of tool arguments.

### 3. Playwright e2e harness (BUILD_SPEC §12)
- New `packages/web/e2e/playwright.config.ts` with an Electron project that
  launches `electron/main.cjs` and a web project that uses `serve out -p 3000`.
- Harness files:
  - `packages/web/e2e/harness/electronApp.ts` — Electron app launcher,
    auto-detects the main script, injects test env vars, and disables the
    legacy bridge with `LOAM_DISABLE_BRIDGE=1`.
  - `packages/web/e2e/harness/fixtures.ts` — Playwright fixtures providing
    `app`, `page`, `mockApi`, and `visualCheck`.
  - `packages/web/e2e/harness/visualCheck.ts` — §12.3 visual checklist runner
    that compares page screenshots against per-theme/locale/baseline PNGs.
- Spec files:
  - `packages/web/e2e/specs/login.spec.ts`
  - `packages/web/e2e/specs/task.spec.ts`
  - `packages/web/e2e/specs/rtl.spec.ts`

### 4. QA documentation
- New `docs/QA.md` — QA plan covering scope, acceptance criteria, verification
  matrix, issue severity, test environments, and handoff procedures.
- New `docs/handoff/a10-requests.md` — explicit asks to other agents for
  blockers that fall outside A10's owned paths.

### 5. Branch integration
- Merged all agent feature branches (`mp/a01` through `mp/a09`) plus
  `mp/a10-qa-research` into `manus-parity` in the integration worktree at
  `C:\Users\khamis\Desktop\manus-local`.
- Resolved merge conflicts in:
  - `package.json` / `package-lock.json`
  - `packages/web/package.json` / `packages/web/package-lock.json`
  - `packages/web/tsconfig.json`
  - `packages/web/src/store/**`
- Added missing root dev dependencies: `@playwright/test`, `socket.io-client`.
- Added `@xmldom/xmldom` to `packages/shared` and regenerated lock files.

### 6. Cross-path build fixes required for the merged branch to compile
- Unified `packages/web/src/store/index.tsx` and removed the stale
  `packages/web/src/store/index.ts` duplicate.
- Fixed `packages/web/src/store/uiSlice.ts` and
  `packages/web/src/store/authSlice.ts` exports/actions for the new store shape.
- Fixed `packages/web/src/app/providers.tsx` and
  `packages/web/src/components/shell/TitleBar.tsx` imports.
- Rewrote `packages/shared/src/env.ts` and re-exported `proto.js` from
  `packages/shared/src/index.ts` so the server and web packages resolve shared
  types consistently.
- Restored path aliases in `packages/web/tsconfig.json` and added
  `turbopack.root` in `packages/web/next.config.ts` so the Next.js/Turbopack
  build resolves the monorepo layout.

## Verification commands

```powershell
# Root typecheck
npx tsc --noEmit
# Result: 0 errors

# Web build
npm run build --prefix packages/web
# Result: passes, static export produced in packages/web/out

# Server build
npm run build:server
# Result: dist/server.cjs produced (17.8 MB)

# Existing web e2e suite (serve out -p 3000)
npx playwright test --config=packages/web/playwright.config.ts
# Result: 7/8 pass; 1 Arabic-locale text assertion fails because forced
# locale initialization is not applied before first render.
```

## What is left / known blockers

- **Electron e2e cannot run yet**: `electron/main.cjs` still serves the legacy
  Loam UI and does not load `packages/web/out`. A10's `_electron` harness
  launches successfully but times out waiting for the first window because the
  main process never creates a BrowserWindow for the new Next.js export.
  - Required: A1 (or owner of `electron/main.cjs`) to:
    1. Serve `packages/web/out` from the Electron renderer.
    2. Expose `__apis.system.openExternal` and other §10.3 channels the
       React app expects.
    3. Ensure the main window is created and shown during test launches.
- **Arabic RTL test fails in the web project**: the forced Arabic locale
  (`navigator.language = 'ar'`) is applied after initial render, so the
  `text=مهمة جديدة` assertion in `screens-home-task.spec.ts` does not match.
  Fix belongs to the locale/bootstrap layer (A1/A4 scope).
- **Electron dependency mismatch**: root `package.json` pins `electron` to
  `^44.7.2`; BUILD_SPEC wants `43.6.0`. A10 left the downgrade out of this
  integration pass because it triggers a full native-dependency rebuild and
  should be coordinated with A1/A9 packaging work.

## Cross-path edits

A10 had to touch files outside its owned paths to make the merged
`manus-parity` branch compile and build. See the commit
`[a10] integration fixes for merged manus-parity` for the full diff. Key files:

- `packages/shared/src/env.ts`
- `packages/shared/src/index.ts`
- `packages/web/src/store/index.tsx`
- `packages/web/src/store/uiSlice.ts`
- `packages/web/src/store/authSlice.ts`
- `packages/web/src/app/providers.tsx`
- `packages/web/src/components/shell/TitleBar.tsx`
- `packages/web/next.config.ts`
- `packages/web/tsconfig.json`
- `packages/web/package.json`
- `package.json`
- `package-lock.json`

## Handoff notes

- The React Next.js app (`packages/web`) builds and can be e2e-tested via
  `serve out -p 3000`.
- The Electron harness is ready to run as soon as `electron/main.cjs` creates
  a renderer window pointing at `packages/web/out`.
- Further integration verification (packaging, fuses, full Electron smoke)
  should be re-run after A1 completes the Electron wiring.
