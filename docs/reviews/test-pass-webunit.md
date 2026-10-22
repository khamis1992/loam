# Web unit test coverage — `mf/testwebunit`

Task: add missing Vitest coverage for `packages/web` services, agent
components and settings panes. This file records what was added, where the
logic lives, and the gate results.

## Scope

| Target | Production file | Test file | New tests |
| --- | --- | --- | --- |
| Pin/reorder service | `services/agentsPinsApi.ts` | `services/__tests__/agentsPinsApi.test.ts` | 6 |
| Agent info panel service | `services/agentInfoApi.ts` | `services/__tests__/agentInfoApi.test.ts` | 9 |
| Agent label catalog | `components/agents/agentLabels.ts` | `components/agents/__tests__/agentLabels.test.ts` | 6 |
| Sidebar search/hide | `components/agents/agentListFilter.ts` | `components/agents/__tests__/agentListFilter.test.ts` | +6 (was 12, now 18) |
| Settings › My Computer | `components/settings/MyComputerPane.tsx` | `components/settings/__tests__/myComputerPane.test.tsx` | 3 |
| Settings › Usage | `components/settings/UsagePane.tsx` | `components/settings/__tests__/usagePane.test.tsx` | 4 |
| Settings › Memory | `components/settings/MemoryPane.tsx` | `components/settings/__tests__/memoryPane.test.tsx` | 4 |
| Settings › Appearance | `components/settings/AppearancePane.tsx` | `components/settings/__tests__/appearancePane.test.tsx` | 4 |
| Settings › General | `components/settings/GeneralPane.tsx` | `components/settings/__tests__/generalPane.test.tsx` | 3 |
| Updater status mapping | `components/update/UpdaterSettings.tsx` | `components/update/__tests__/updaterSettings.test.ts` | 6 |
| Home template gallery | `components/home/TemplateGallery.tsx` | `components/home/__tests__/TemplateGallery.test.tsx` | +3 (was 6, now 9) |

**Total: 54 new tests** across 11 test files (target was ~25). The touched
files run 72 tests total, all passing.

## Production change

One small, focused product change was required to make the Arabic requirement
meaningful:

- `components/agents/agentListFilter.ts` — `foldName` now strips the Arabic
  harakat/tashkeel (`\u064b-\u065f`, superscript alef `\u0670`, Quranic
  annotation `\u06d6-\u06ed`) in addition to Latin combining marks. The
  sidebar search therefore matches an unvocalised Arabic query such as `محمد`
  against a vocalised name like `مُحَمَّد`, matching the existing behaviour of
  the Latin path (`Café` → `cafe`).

No i18n JSON files were touched. No protected files were touched.

## What each test file covers

- **agentsPinsApi** — `setAgentPinned` POST body/method, id URL-encoding,
  `reorderPinnedAgents` payload, server-error message propagation, status-code
  fallback.
- **agentInfoApi** — memory / approval rules / scratchpad unwrapping and
  `[]` defaults; create+complete scratchpad; URL watch list/create/delete;
  schedules list + run-now; channel status/bindings/bind/unbind; child agents;
  live-view status and frame; missing-frame `null`; error propagation.
- **agentLabels** — English default, Arabic switch, locale flip for the same
  key, bilingual catalog sanity, `modelDisplayName` default/sentinel/custom.
- **agentListFilter** — Arabic harakat folding, decomposed (NFD) Latin input,
  Arabic letters unchanged by case folding, Arabic name/description search,
  Arabic no-match.
- **myComputerPane** — seeded folders, add folder, remove folder to empty state.
- **usagePane** — demo fallbacks, signed-in identity, credit rows, tasks row.
- **memoryPane** — status + entries render, disabled state, empty state, load
  error.
- **appearancePane** — theme switch + `localStorage` persistence, Auto/system,
  density toggle.
- **generalPane** — language select default, Arabic locale + `dir=rtl`,
  persisted switch writes to `localStorage`.
- **updaterSettings** — `mapUpdaterStatus` for current/checking/available/
  downloading (progress clamp)/installing/error/disabled/unknown and version
  passthrough.
- **TemplateGallery** — prompt-text search, category chip toggle-off, empty
  custom list.

## Gates

All gates run from the worktree root.

| Gate | Command | Result |
| --- | --- | --- |
| Web typecheck | `cd packages/web && npx tsc --noEmit` | 0 errors |
| Root typecheck | `npx tsc --noEmit` | 0 errors |
| Server build | `npm run build:server` | exit 0 (`dist/server.cjs` 18.4 MB) |
| Touched tests | `npx vitest run <11 touched files>` | 11 files / 72 tests passed |

### Known failures (not addressed by this task)

The 3 known i18n failures in `packages/web/src/i18n/t.test.ts` and
`packages/web/src/i18n/__tests__/t.test.ts` remain: the Arabic catalog
currently round-trips through mojibake, so the Arabic-placeholder assertion and
the `en`/`ar` key-parity assertion fail. Another task repairs the i18n JSON;
per instructions these were ignored and no i18n file was edited. New tests do
not assert on `t()` Arabic strings; the Arabic assertions use the hardcoded
`AGENT_LABELS` table in `agentLabels.ts`, which holds correct Arabic.
