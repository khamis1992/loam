# O4 report — bullets→charts/diagrams + tracked changes/comments

## Commits (branch mf/o4)
- `4440bae` feat(studio): parse bullet lists into native chart data + simple diagram model (slide-chart-data.ts append)
- `633a1d6` feat(studio): tracked-changes model with comment threads + O4 bullet parsers tests

## Files
- `src/studio/slide-chart-data.ts` — appended a new, self-contained bullet section (existing OOXML chart import/patch code untouched):
  - `parseBulletChartData(bullets, opts?) => BulletChart {kind:'bar'|'line'|'pie'|'area'; title; categories: string[]; series:[{name, values:number[]}]}`
    - Accepts string[] or newline string; markers `- * • – 1) 1.`; directives `Title:`/`Type:`/`Categories:` (`Labels:`/`X:` aliases); `- Q1: 10%`, negatives, decimals.
    - One value per bullet → label categories + one series; multi-value bullets → series over positional or explicit categories; length/dup/pie validation; errors are `StudioError` (400).
  - `parseBulletDiagram(bullets, opts?) => BulletDiagram {title; layout:'flow'|'hierarchy'|'sequential'; nodes:[{id,label}]; edges:[{from,to}]}`
    - `A -> B`/`=>`/`→` lines → deduplicated flow graph (chained arrows ok); indentation (2 spaces or tab per level) → hierarchy; plain equal-depth bullets → sequential steps. Caps 60 nodes/120 edges.
  - Small note: chart-section `chartLines` keeps leading whitespace (needed for diagram indentation); chart parsing trims internally.
- `src/studio/word-track-changes.ts` — pure TS, no OOXML, immutable transforms (every call clones; errors via `TrackChangesError`):
  - Model: `TrackedDocument {authors, paragraphs[{id, runs}], threads}`; `TrackedRun {id, type:'base'|'insert'|'delete', text, authorId?, timestamp?, prior?}` (delete runs keep the `prior` snapshot so reject restores exactly, including re-deleted inserts).
  - API: `createTrackedDocument(paragraphs)`, `registerAuthor`, `insertText(doc, paragraphId, offset, text, {authorId, timestamp?})`, `deleteText(doc, paragraphId, offset, length, opts)` (offsets count visible text; runs split on boundaries), `acceptChange`/`rejectChange(changeId)`, `acceptAll`/`rejectAll`, `pendingChanges`, `getChange`, `paragraphText`/`documentText(view:'final'|'original')`, `changeStats`.
  - Comments: `addCommentThread(doc, paragraphId, offset, length, {authorId, text, timestamp?})` (anchor into visible text), `replyToComment(threadId, parentId)` (flat list + parentId), `threadReplies`, `setThreadResolved`, `removeComment` (cascades reply subtree; empties drop thread).
  - NOTICE credit comment in the file header references the WordCraft/DeckCraft-style design; original code, no brand strings.
- Tests: `src/studio/__tests__/slide-chart-data.test.ts` (11), `src/studio/__tests__/word-track-changes.test.ts` (12).

## Routes/tools
None — pure modules; no http.ts mount lines needed for O4. Nothing added to runTools/ALWAYS_ON_TOOLS.

## Verification
- `npx tsc --noEmit` (root): 0 errors. `npx tsc --noEmit -p packages/web/tsconfig.json`: 0 errors.
- `npx tsx --test src/studio/__tests__/slide-chart-data.test.ts src/studio/__tests__/word-track-changes.test.ts` → 23/23 pass (repo runner: node:test via tsx, same as src/server/__tests__).
- `npm run check:studio` fails on the server-readiness probe (`assert.ok(ready)` check-studio.ts:23) — reproduced identically on baseline commit `0e9c3bf` with my files reverted, so it is a pre-existing environment issue (Node v25.2.1 / worktree), not caused by O4.
- `packages/web` `npm run build` hits the known worktree Turbopack filesystem-root error; web tsc is clean per instructions.

## How to test live
`npx tsx` a snippet: `import {parseBulletChartData,parseBulletDiagram} from './src/studio/slide-chart-data.js'` / `import * as tc from './src/studio/word-track-changes.js'`, or run the two test files with `npx tsx --test`.

## Left / notes
- Wire-in (UI/export to PPTX chart XML / DOCX w:ins/w:del OOXML emission) is intentionally out of O4 scope — the models are ready for a later task to serialize.
- Chart section does not yet feed `importSlideCharts`/`patchSlideCharts` (no consumer requested bullets→OOXML conversion in this task).
