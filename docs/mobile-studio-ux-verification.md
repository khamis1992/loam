# Mobile studio UX verification — 2026-10-18

## Scope and coverage

Scope: mobile studio creation → live preview → click selection → manual/model edit → undo/redo → reload → source export. Stack: existing vanilla JS/CSS, TypeScript HTTP server, Ollama. Repository conventions: docs/mobile-studio.md; no AGENTS.md found. Existing unrelated workspace changes were preserved.

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | Native labeled controls, focus rings, keyboard-selectable overlay buttons and block list; browser interaction | Inspected; screen reader and 200% zoom not verified |
| Layout | ui/mobile.css, live integrated route, 1600/768/320px automated viewports | No horizontal page overflow in tested widths; preview centered, side panel scrolls independently |
| Writing | Build phases, recoverable errors, saved/draft state, export limitations | Structural checks distinguished from behavioral/native verification |
| Typography | Studio/app styles, Arabic browser rendering, small-width form sizing | Inspected; mobile form text set to 16px |
| Colors | Computed textarea colors; declared contrast pairs | Input boundary fixed after host-theme override was observed |
| UI polish | Selected/disabled/empty/build/error states, phone frame, edit selection | Static selection cue and reduced-motion-gated press feedback |

## Findings addressed

| Severity | Domain | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| HIGH | Accessibility | ui/mobile.css | Host theme overwrote input border to rgb(49,75,59) | Dedicated --mobile-control-border rgb(115,139,155) | Preserve visible form boundaries independent of shell tokens |
| HIGH | Writing | src/mobile/build.ts | A generated button labelled Save navigated | Save/navigation mismatch sent back for repair before commit | A control must perform its labelled action |
| MEDIUM | Layout | ui/mobile.css | Fixed phone/page sizing moved toolbars off screen | Flexible viewport layout with independent panel scrolling | Keep preview and editing context visible |
| MEDIUM | Writing | src/mobile/store.ts | Generic missing-text failure | Error identifies the offending block and label requirement | Give repair loop actionable feedback |

## Verification

Passed:
- npm run typecheck
- npm run check:encoding
- npx tsx src/scripts/check-mobile-build.ts
- npx tsx src/scripts/check-mobile-http.ts --bundle
- Browser integration: model fixture emits duplicate IDs then repairs; selected-element edit, local and persisted undo/redo, reload, export, task isolation, stale revision rejection and 320px layout.
- Build unit cases: maximum three attempts; invalid draft never saved; cancelled request never saved; late result cannot overwrite concurrent edits; selected block changes cannot replace other elements; redo invalidated by a new branch; text-only edits preserve navigation; Save/navigation mismatch repaired.
- Contrast from declared tokens: secondary studio text 8.74:1, primary button text 10.30:1, app secondary text 5.67:1, app input boundary 3.05:1, app focus ring 5.54:1. Host theme changes some tokens; these are not a blanket all-theme certification.
- Final integrated tab console: no captured errors.

Live model:
- Local Ollama qwen2.5:14b; no manual JSON supplied in the successful creation prompt.
- Natural-language creation produced 3 screens and 5 fields in one attempt after schema improvements.
- Earlier live attempt automatically corrected a navigation-property validation failure on attempt 2. Earlier unstructured attempts failed safely after 3 attempts.
- Final task: task_mvd9j7ovbd1ad53ffcee, final saved revision 5.
- Selected the generated Save button inside the phone and asked the local model to save locally and rename it. Completed in one attempt.
- Comparing persisted snapshots showed exactly one block changed: block_save, text حفظ → احفظ فكرتي, target removed. Other fields/screens and app title were unchanged.
- Undo restored the old button; redo restored the fix. Reload preserved both the fix and entered book/author/pages=24/completion=true/note data. Save confirmation stayed on Notes.
- Export button worked. reading-journal-v2.zip downloaded and its Expo App.js passed JSX transformation.

Not verified: APK/IPA compilation, physical devices, cloud sync/backends, full assistive-technology audit, 200% zoom, every model or arbitrary user requirement. Model results still require review; schema validation alone does not prove requirement coverage.

## Verdict

Approve for the inspected web-studio flow. Screen-reader, zoom and native-device behavior remain outside verified coverage.

## Screen navigation update — 2026-10-18

Implemented a searchable grouped explorer with favorites/recent pages, clickable breadcrumbs, primary/detail navigation with parent fallback and visit-history Back, and a filterable flow map showing real navigation links and unreachable-page warnings. Project capacity is 100 screens; app navigation is limited to 1–5 primary sections.

Verification:
- Source and bundled server browser suites passed with a 40-page fixture: five groups, five primary sections, 35 nested/detail pages, 36 actual navigation links.
- Search, favorites, recent pages, breadcrumb selection, direct-open Back, nested Back, cross-section Back, field persistence, flow filtering/node selection, unreachable detection, deletion/reparenting and local/durable undo were exercised.
- Dialog layout checked at 1110, 768 and 320 px. Escape regression in shared theme handler fixed so an open dialog closes without leaving the studio.
- Standalone exported HTML exercised with the same navigation; exported Expo source passed JSX transformation. Native hardware Back handling is implemented but not device-tested.
- typecheck, encoding and dedicated mobile build/repair checks passed.
- Live task on port 3941: task_mvdabhi942ecb140ccd0, title مكتبة الحياة · تجربة 40 صفحة.
- The 40-page fixture was created programmatically, not generated by the model. A real local qwen2.5:14b selected-heading edit succeeded in one attempt and changed exactly one text field, preserving all screens, groups, parent relations and navigation links. Live UI undo/redo restored the old/new heading; final revision 4.
- Evidence: release/mobile-live/many-pages-local-model.sse, many-pages-proof.json, many-pages-flow.jpg, plus release/mobile-many-flow.png and mobile-many-explorer.png.
