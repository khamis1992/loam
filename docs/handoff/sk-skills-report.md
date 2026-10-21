# SK — Settings > Skills (restore old Loam installable-skills section into the current Next.js design)

## What was built
The `Coming soon`/read-only `SkillsPane` in **Settings → Capabilities → Skills** was replaced
with a full-featured Skills manager that mirrors the feature set of the OLD Loam inline-HTML
skills page, rebuilt with the CURRENT design (existing tokens, `Section`, `Button`, `Dialog`,
`t()`, lucide icons, RTL-safe logical utilities).

Sections:
- **Installed skills** tab — list (`GET /api/skills`), filter box, `View` (opens the skill body
  via `GET /api/skills/one`, read-only with an `Edit` action), `Uninstall` (`POST /api/skills/delete`),
  and a `Create skill` button.
- **Skill catalog** tab — debounced search + category chips (`GET /api/skills/catalog`), per-item
  `Install` (`POST /api/skills/install`), an `Installed` badge, and an `Update` action (re-install with
  `force=true`) when a matching skill is already present. Refresh-index button hits
  `?refresh=1`.
- **Create / Edit dialog** — name + description + instructions (Markdown). Create posts
  `POST /api/skills/create`; edit posts `POST /api/skills/update`.
- Lightweight toast + per-item busy spinners (success/error paths for install/update/delete/create/save).

Backend endpoints were **reused unchanged** — no route additions were needed, therefore
**`src/server/http.ts` was not touched** and the supervisor has no dispatch lines to add for SK.

## Source of the feature (old Loam design)
- `ui/skills.html` + `ui/skills.js` (the pre-Next inline-HTML console; RTL Arabic skills page with
  Installed/Catalog tabs, category chips, drawer editor, toasts). These files predate the Next.js UI
  and are present since the initial import commit **`a2123a8 "Initial import of Loam application"`**.
- The API surface it consumed (`/api/skills*`) was already wired into `src/server/http.ts` at that
  same commit and still is (listSkillRecords/readSkillFile/applySkill + searchCatalog/installFromCatalog
  from `src/tools/skills.ts` and `src/tools/skillsRegistry.ts`).
- Matched the old section's **features**, not its look (the drawer editor became a centered `Dialog`;
  the CSS grid became the current card list style).

## Files changed (commits)
- `feat(i18n)` `3af6db3` — `packages/web/src/i18n/en.json`, `ar.json`: ~34 Skills-pane strings.
- `feat(web)` `095ceb0` — `packages/web/src/components/settings/SkillsPane.tsx` (rewrite) +
  `packages/web/src/components/settings/__tests__/skillsPane.test.tsx` (new, 5 tests).
- `test(web)` `9ec8d3a` — `packages/web/vitest.config.ts` (resolve `@`/`@shared` aliases, `include: src/**`,
  exclude `e2e/**`) + `packages/web/vitest.setup.ts` (in-memory `localStorage` shim).
- `test(server)` `7227bc3` — `src/server/__tests__/skills.test.ts` (6 tests, node:test/tsx).

### Note on the two test-config edits (shared files, minimal)
The committed `vitest.config.ts` had **no** alias resolver, so *every* `@/`-importing component test —
including the pre-existing `settings.test.tsx` — failed at collection ("Failed to resolve import @/store").
Adding the alias is what makes the Skills test (and the existing settings test) actually run; excluding
`e2e/**` stops vitest from trying to execute the Playwright specs (`playwright test` owns those); and the
`localStorage` shim papers over a broken jsdom `localStorage` on this Node build (`getItem is not a
function`). If the supervisor's canonical config differs, these are the only files to reconcile.

## Request / response shapes (unchanged, from `src/server/http.ts`)
- `GET /api/skills` → `{ skills: [{ name, description }] }`
- `GET /api/skills/one?name=` → `{ name, description, body, file, content }` (404 `{ error }`)
- `GET /api/skills/catalog?q=&limit=&describe=&refresh=` → `{ source, total, shown, skills:[{ id, files, description? }] }` (502 `{ error }`)
- `POST /api/skills/create` (or `/api/skills`) `{ name, description, content, location? }` → `{ ok, message }`
- `POST /api/skills/update` `{ name, description, body }` → `{ ok, message }`
- `POST /api/skills/delete` `{ name }` → `{ ok, message }`
- `POST /api/skills/install` `{ id, force? }` → `InstallResult { id, name, dir, files[] }` (400 `{ error }`)

## What was intentionally NOT built (backend does not support it)
- **Global enable/disable** of installed skills: there is no enabled flag in `SkillRecord`/
  `listSkillRecords` (skills are just `skills/<name>/SKILL.md` dirs). Per-agent skill toggling already
  exists in `NewAgentDialog`/`AgentEditDrawer` (capability `allowedServices`), but there is nothing to
  expose as a global switch without a new store field + migration. Omitted rather than faked.
- **Version / "update available" diffing**: the catalog has no version or content hash, so "update
  available" is presented honestly as an `Installed` badge + an `Update` action that re-installs with
  `force=true` (the catalog always serves the latest `SKILL.md`). Matching installed↔catalog is by the
  catalog id's last path segment vs the installed skill name.
- `location` (project/user/manus) select from the old drawer: `applySkill` ignores it (always writes
  `skills/<name>`), so it was dropped instead of silently discarding a user choice.

## How to test live
1. Start the server (`npm run dev`) and the web app; open **Settings → Skills**.
2. Installed tab: existing `skills/` dirs (e.g. `design`, `report`) should list; **View** shows the
   `SKILL.md` body; **Create skill** adds one; **Uninstall** removes it.
3. Catalog tab: search `pdf`/`react`; **Install** fetches from the aitmpl.com catalog into `skills/`
   and flips to the **Installed** badge; **Update** re-installs (force). Requires outbound network +
   optionally `GITHUB_TOKEN`.

## Automated verification (all run locally in this worktree)
- `npx tsc --noEmit` (root/server): **0 errors**.
- `npx tsc --noEmit -p packages/web/tsconfig.json`: **0 errors**.
- Web: `npx vitest run` → **35 passed / 8 files** (includes the 5 new SkillsPane tests + the 3
  pre-existing settings tests that the config fix unblocked).
- Server: `npx tsx src/server/__tests__/skills.test.ts` → **6 passed**.
- `npm run build` (web): fails only with the **known** Turbopack `Could not find next/package.json`
  junction error (`packages/web/node_modules` → `../../manus-local/...`); resolved from `src/app`
  before any component compiles, so it is environmental, not from this change. Rely on web `tsc` per the
  worktree rule.
