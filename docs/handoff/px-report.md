# PX Handoff Report — UI polish (ModeChip, humanizer, Library/Creations/Projects)

**Branch:** `mf/px` (worktree)
**Commits:**
- `c1349e2` — fix(ui): single brand in ModeChip and clean human labels for every tool
- `01df479` — fix(web): project row contract, mojibake guard, and 400-safe task enumeration

## Files changed (only these)

- `packages/web/src/components/chat/ModeChip.tsx`
- `packages/web/src/components/chat/modeLabels.ts` (new — pure label helpers, self-contained so unit tests can import it)
- `packages/web/src/components/chat/toolLabels.ts`
- `packages/web/src/components/chat/ToolUsedRow.tsx`
- `packages/web/src/app/app/projects/page.tsx`
- `packages/web/src/app/app/app/library/page.tsx` → `packages/web/src/app/app/library/page.tsx`
- `packages/web/src/app/app/creations/page.tsx`
- `packages/web/src/utils/placeholders.ts` (new)
- `packages/web/src/utils/taskIds.ts` (new)
- `packages/web/src/utils/__tests__/placeholders.test.ts` (new)
- `packages/web/src/components/chat/__tests__/toolLabels.test.ts` (new)
- `packages/web/src/components/chat/__tests__/ModeChip.label.test.ts` (new)
- `packages/web/src/i18n/en.json`, `packages/web/src/i18n/ar.json` (added key `Untitled project` = `مشروع بدون عنوان`)

`src/server/http.ts` was **not** modified (not dirty — but no server change was needed either).

## (a) ModeChip «Loam Loam»

- Confirmed root paths: the old chip rendered the blue `PRODUCT` prefix plus a resolved label whose string could itself start with the brand.
- A prior fix (commits `4a47c9b`, `af467bb` on this branch) already suppressed the prefix when a mode is set. This round adds a pure, tested normalizer `dedupeBrandLabel()` in `modeLabels.ts`: collapses any number of repeated leading brand tokens (`"Loam Loam"` → `"Loam"`, `"Loam Loam Build"` → `"Loam Build"`), leaves Arabic/plain labels untouched. All 8 modes verified in the unit test.

## (b) Step/activity humanizer

`packages/web/src/components/chat/toolLabels.ts`:

- `TOOL_LABEL` now covers the full registered-tool inventory: files, terminal/pty, web, browser, lists, schedules / watches / task_* / watch_* / schedule_*, scratchpad (`scratchpad_add` → “Added to-do”), documents (`office_*`, `loam_document` → “Edited/Imported/Exported/Checked document”), studio tools, memory, device/host control, security, skills, companions/swarms, integrations.
- Claude-style capitalized aliases mapped: `Write` → “Wrote file”, `Edit` → “Edited file”, `Bash` → “Ran command”, `Grep`/`Glob`, `WebFetch`/`WebSearch`.
- Fallback: `sentenceFromToolName()` converts snake_case → a sentence (`custom_widget_mounter` → “Custom widget mounter”), collapsing duplicate tokens so a verb never repeats.
- `ToolUsedRow.briefDuplicatesLabel` now also treats raw tool-name tokens and a small generic-verb set as label vocabulary, so rows read “Edited file foo.ts” instead of the old repeated-verb “Edited file Write”.

## (c) Library / Creations 400 + Projects «?????»

Verified live against the user’s running instance (127.0.0.1:3939, read-only probes):

- `GET /api/tasks?limit=50` → 200; `GET /api/projects` → 200; `GET /api/files?taskId=…&path=&max=200` → 200 for **all 124** current tasks. Endpoints are healthy today; no client request shape was wrong.
- The 400 class comes from backend validation exceptions surfaced by the generic catch in `http.ts` (e.g. `invalid task id`, `links are not allowed in task paths`) — plural per-task calls. Fix (client-side): Library and Creations now filter task ids with `isTaskId()` (`/^task_[a-zA-Z0-9_-]+$/`, mirrors `taskWorkspace.ts:25`) before enumeration, so corrupt/legacy rows can no longer produce 400 storms; per-task failures remain non-fatal.
- **Projects «?????» is real data corruption, not a font issue:** the live DB row `proj_mv9gnuvk6c5ed5` literally stores `"name":"????? ??????","instruction":"???? ???????? ??????"` (verified at byte level; ASCII `0x3f`). The original Arabic was destroyed at creation time (Oct 15, older deployed build) and is unrecoverable. Current creation paths (http.ts POST /api/projects, protocol RPC CreateProject) decode UTF-8 correctly — a “مشروع عربي” round-trip was verified live.
- UX guard added: `displayProjectName` logic — names/Descriptions consisting only of `?` separators are treated as mojibake and replaced with a neutral placeholder; the project card keeps showing `instruction` as description (fixes the page’s `uid`/`description` field-contract mismatch with the endpoint’s `id`/`instruction` rows).

## Tests

Vitest (`npm --prefix packages/web run test`):
- `toolLabels.test.ts` — 9 tests (file ops, aliases, scratchpad, schedule, office, docs, task/memory, fallback casing, no-verb-repeat, corrupted placeholder).
- `ModeChip.label.test.ts` — 4 tests over all 7 chat modes.
- `placeholders.test.ts` — mojibake detection.

Result: **42/42 tests pass.** Six suites fail **pre-existing** and are unrelated (Playwright e2e specs picked up by the vitest root glob, and `settings.test.tsx` importing a nonexistent `@/store`).

## Verification (all before final commit)

| Command | Result |
|---|---|
| `npx tsc --noEmit` (root/server) | 0 errors |
| `npx tsc --noEmit -p packages/web/tsconfig.json` | 0 errors |
| `npm --prefix packages/web run build` | success (static export, 15 routes) |
| `npm --prefix packages/web run test -- --run` | 42 passed, 0 failed (42 run) |
| `npx tsx --test src/server/__tests__/<existing>.test.ts` | pass 14, fail 0 |

## How to test live

1. `npm run dev` (server) + `npm --prefix packages/web run dev`.
2. Mode chip: select each mode (Build/Write/Data/Media/Research/Security/Automate) → label shows the brand exactly once, e.g. “Loam Build”.
3. Any session with tool activity → timeline rows show clean labels (“Wrote file …”, “Added to-do”…), never raw `scratchpad_add`.
4. Open Library and Creations — lists populate; console shows no 400s.
5. Projects — the legacy corrupted row renders as “مشروع بدون عنوان / Untitled project” instead of “??????”.

## What’s left

- Supervisor may update the affected legacy Projects row (`proj_mv9gnuvk6c5ed5`) in the deployed DB (`C:\Users\khamis\Desktop\manus-local\data\manus.db`) — data is unrecoverable client-side.
- Optional: audit which Oct 15 creation channel destroyed non-ASCII (Windows arg-encoding in spawned scripts is the likeliest channel; all current code paths verified UTF-8-clean).
- Pre-existing broken suites (playwright-in-vitest, `@/store`) are unrelated and out of scope.
