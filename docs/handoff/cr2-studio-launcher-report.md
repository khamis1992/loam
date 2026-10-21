# CR2 — Creative Studio launcher tab (S-LAUNCHER)

Branch: `mf/cr2`. Commits:
- `b81b9c5` feat(studio): clean-room studio tool list + CR1 payload normalization
- `f575e98` feat(studio): studio launcher tab with tool cards + sidebar link

## Files
- `packages/web/src/components/studio/studioTools.ts` — new. StudioTool types,
  `STATIC_STUDIO_TOOLS` (Video/Docs/Sheets/Slides/Design), `pickStudioTools(payload)`
  normalizes an optional CR1 `GET /api/studio` `{ tools: [...] }` list; unknown kinds
  ignored, empty/no-list payloads return `null` so the UI falls back to static.
- `packages/web/src/components/studio/studioTools.test.ts` — new. 4 vitest cases
  (static inventory, null fallbacks, CR1 normalization + defaults, explicit mode/prompt).
- `packages/web/src/app/app/studio/page.tsx` — new `/app/studio` page. Card grid using
  existing tokens (`rounded-card`, `border-border-main`, `bg-bg-menu`, `bg-fill-tsp`,
  `text-text-*`, `h-row`, `text-title-lg`) and lucide icons already used in this repo.
  Fetches `${getApiBase()}/api/studio` with `getApiHeaders()`; if the response is a
  tool list it replaces the static cards, otherwise static remains (the current repo
  `/api/studio` is the per-task artifact store and 400s without `taskId` — that simply
  keeps the fallback).
- `packages/web/src/components/shell/Sidebar.tsx` — 2-line edit: `Palette` added to the
  lucide import; one nav entry `{ id: 'studio', label: t('Studio'), icon: Palette,
  href: '/app/studio' }` after Creations.
- `packages/web/src/i18n/en.json` / `ar.json` — appended 9 keys each at end of file
  (`Studio`, `Design`, five card subtitles, one hint line). Labels `Video/Docs/Sheets/
  Slides` and the `* starter` prompt keys already existed and are reused.

## Card → workspace behavior
Clicking a card reuses the home-page draft pattern: `addSession` + `loadSessions`
dispatch, then `router.push('/app/<newUid>/?draft=<prompt>&mode=standard&extData={"loamMode":"<mode>"})`.
The task page auto-sends the draft and the server `resolveLoamMode` honors the mode, so
the task workspace panel opens in that kind's studio (Video/Design → `media`,
Docs/Slides → `write`, Sheets → `data` — matching the studio artifact store's write/data
and creative media panels).

## http.ts
Not touched (no new server route needed). Supervisor merge lines: **none** for
`src/server/http.ts`. If/when CR1 lands a tool-list `GET /api/studio`, this UI picks it
up automatically; its expected shape is `{ tools: [{ kind: 'video'|'document'|
'spreadsheet'|'presentation'|'design', id?, name?, subtitle?, prompt?, mode? }] }`.

## Verification
- `npx tsc --noEmit` (root): 0 errors.
- `npx tsc --noEmit -p packages/web/tsconfig.json`: 0 errors.
- `npx vitest run src/components/studio` (packages/web): 4/4 pass.
- `npm run build` (packages/web): fails with the known worktree Turbopack
  `Could not find next/package.json` junction error → relied on web tsc per task note.
- Full web `npx vitest run`: pre-existing failures only (e2e/*.spec.ts Playwright specs
  collected by vitest; `settings.test.tsx` `@/store` alias unresolved). Not introduced here.

## How to test live
Start the loam server + web (`start-web.bat` or `npm run dev` in packages/web), sign in,
sidebar → Studio (or /app/studio). Click e.g. "Sheets": a new task opens, sends the
sheets starter prompt, workspace runs in Loam Data; Doc/Slides land in Write where the
studio tab (office editor) becomes available. Set locale ar to check RTL labels.

## Left
- CR1's real tool-list endpoint wins automatically once present; no server change made
  in this worktree.
- No e2e coverage added for the launcher (repo's e2e runner is Playwright and its specs
  are currently not vitest-compatible).

NOTICE credits the ARTCRAFT_ANALYSIS §7 S-LAUNCHER design reference in-file; all code
is original clean-room TypeScript, no ArtCraft brand/assets.
