# TASK O2 — Office Edit Agent (targeted, template-preserving) — Report

Branch: `mf/o2` (worktree `o2`).

## Commits
| Commit | Content |
|---|---|
| `810c0c7` | `src/tools/officeEditAgent.ts` core: op planner + default applier + injectable tool factory |
| `f995b2f` | O2 unit tests (`src/tools/__tests__/officeEditAgent.test.ts`) + `office_edit` exposed in the `write` and `data` Loam modes + instruction-marker fix |
| `e056b8e` | Registry wiring: `createOfficeEditTools()` registered in `src/index.ts` (2 lines) |

## Files
- **New:** `src/tools/officeEditAgent.ts`, `src/tools/officeEditAgent.test.ts`
- **Minimal shared edits:** `src/index.ts` (+import, +one `registerAll` line), `src/modes/catalog.ts` (+`"office_edit"` token on the two office mode tool lists: write, data)
- **NOT touched:** `src/server/http.ts`, `package.json`, all do-not-touch files.

## New tool
**`office_edit`** — args `{ path: string, instruction: string }` (relative task-workspace path + one or more `;`-separated instructions).
Response (success): summary text with op count, target path, new studio revision, and skipped reasons; failure: honest reasons + the op grammar, and the file is left **byte-identical** (verified by test).

### Op set (all targeted; 1-based indices)
`replace-text {find, replace, slide?}` · `set-cell {address(A1), value, sheet?}` · `set-slide-title {slide, value}` · `set-slide-notes {slide, value}` · `set-block-text {block, value}` · `set-title {value}` · `set-region-text {label, value}` (document header/footer/textbox; grammar also supports Arabic keywords استبدل/خلية/شريحة/فقرة/ملاحظات/عنوان/ترويسة/تذييل).

### Flow & injection
`taskPath` → `readStudio` (or `importStudio` of the file when no matching artifact) → **`planOfficeEdits(instruction, artifact)`** (deterministic, side-effect-free) → **`applyOfficeEdits`** (clones once, mutates only named slots; keeps `sourceIndex`/parts/styles) → `saveStudio` (revision-conscious) → `exportStudio` (template-preserving round-trip) → in-place write to the same `path`.
All five steps are injectable via `createOfficeEditTools(deps)` (`importStudio/readStudio/saveStudio/exportStudio/applier`) — the applier is the primary injection point.

### Anti-rewrite guarantee (tested)
The test computes a primitive-level JSON diff of before/after and asserts the delta is **exactly** the touched paths (e.g. one cell, three text nodes for a doc-wide replace; one slide title+notes), that every op is in the targeted vocabulary (never a "regen" op), that the plan never mutates the artifact, and that a failed plan leaves the file bytes unchanged on disk.

## Tests
`npx tsx --test src/tools/__tests__/officeEditAgent.test.ts` — 11/11 pass; combined run with `runTools.test.ts` + `catalog.test.ts` — 28/28 pass. Exposure assertions: `write`/`data` modes list `office_edit`; `ask` mode does not. Root `npx tsc --noEmit` 0; `packages/web` tsc 0 (web `next build` hits the known node_modules-junction Turbopack error noted in the brief — tsc is the verified fallback).

## Known pre-existing red (not mine, action needed)
`npx tsx src/scripts/check-companions.ts` already failed at base `0e9c3bf`: *mode tools missing from the service catalog: security_assess, security_status*. My `office_edit` joins that list because `src/server/companionGateway.ts` is owned elsewhere. **Supervisor fix (1 line, owner's file):** append `"office_edit"` to the tools array of the `office` service in `COMPANION_SERVICES`:
`src/server/companionGateway.ts:30` → `tools: ["loam_document", "loam_studio", "office_craft", "office_import", "office_export", "office_status", "office_edit"]`

## http.ts mount lines
No HTTP route belongs to office_edit (it is a registry agent tool, exercised inside runs) — **nothing to add to `src/server/http.ts`.**

## Live testing
1. Start the app, open a task with an uploaded `.docx/.xlsx/.pptx`.
2. In a `write` (documents/slides) or `data` (sheets) mode run or companion in the `office` work service, call:
   `office_edit {"path":"uploads/report.docx","instruction":"replace \"Alpha\" with \"Beta\"; set document title to \"Plan 2026\""}`
   or for sheets: `{"path":"uploads/budget.xlsx","instruction":"set cell B2 to \"42\""}`
3. Re-open the file in Office: non-targeted content (images, styles, header/footer, original parts) survives the export round-trip; the edited slots only change.

## Left
- Optional richer instruction grammar (multi-quoted reorder commands), and joining `office_edit` into the `office` companion service group once the gateway file is writable (line above).
