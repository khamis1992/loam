# Word direct caret and positioning — 0.5.12

## Cross-page drag and resize handles — worktree after 0.5.23

Elements can now be dragged across pages and resized directly in the Word preview. A new `move` operation in the shared edit module reorders the block in document flow — which decides the page its anchor flows on — and sets page-relative coordinates for the target page; invalid moves (same slot, adjacent slot, out of range, missing position, non-spatial blocks) are rejected. During a pointer drag the snapshot ghost follows the cursor across the whole pages column and turns orange while over another page; dropping re-anchors the element after the nearest text target above the drop point on that page, and pages without body anchors (pure table continuations) ask the user to choose a paragraph, as before.

A corner handle (⤡) resizes the element: width grows or shrinks with page-bound clamping, commits as a positioned width, and `positionWord` now scales image extents symmetrically (growing is no longer capped at the original size) while keeping the aspect ratio exactly. Same-page dragging, keyboard movement, Escape cancellation and the exact-geometry-after-save model are unchanged.

Checks: new `check:word-move-resize` (model: reorder moves the drawing paragraph before the target in body flow, position persisted, invalid moves rejected, symmetric proportional extent scaling) and `check:word-crosspage-ui` (real drag from the landscape page up to page 1 commits a move — the image block index drops, its position lands near the new page top, and its drag handle re-renders on page 1; the corner handle then grows the saved width; native export regenerates). `check:word-caret-ui` (page-local drags unchanged, save waits 2.8–3.7 s) and the full Studio UI regression pass; typecheck is clean for these files (unrelated concurrent errors remain in `src/server/http.ts` and `check-companions.ts`). Visual review passed: the illustration appears exactly once on page 1 at the drop point, resized larger, without obscuring the title, cards or table. Evidence: `output/word-move-resize/` (`crosspage-edited.docx/.pdf`, `page-1..3.png`, `moved.docx`).

Boundaries: keyboard movement stays page-local; the ghost is a snapshot outline (exact appearance refreshes after save); multi-select, alignment guides and z-order tools remain open. Uninstalled; installed release remains 0.5.23.

## Special regions and in-cell images — worktree after 0.5.23

Editing inside headers, footers and text boxes, and inserting images into table cells, are now supported for imported documents. Import captures every header/footer part referenced by `sectPr` (deduplicated by part, text-joined paragraphs) and every `w:txbxContent` body drawing as `content.regions` entries identified by part or body node; `cellImages` on a table block describes images appended into cells.

Export patches region text in place — distributing edited lines across the original paragraphs with the same run-preserving `patchText` used for body cells — and never restructures header/footer parts or text boxes; removing or reshaping regions is rejected to protect the original structure, and unchanged documents stay byte-identical. A new cell image becomes an extra paragraph inside its target cell through a generalized `richWordAppender.build` (numeric layout width supported), creating its own media part, relationship and content-type override; each export rebuilds from the pristine source so repeated exports stay idempotent, model rows map to XML rows after the header row, and positions covered by merges are rejected.

The studio document editor shows a «الرأس والتذييل ومربعات النص» panel for imported files and per-table «صور داخل الخلايا» controls (row/column picker plus upload, up to four images).

Checks: new `check:word-special-regions` (capture, no-op byte identity, header/footer/textbox patching with preserved paragraph counts, idempotent re-export, region protection, in-cell media/rel/content-type with the drawing inside the right `tc`, validation guards) and `check:word-special-regions-ui` (header edited and cell image inserted through the actual studio UI, native Word export). `check:word-original-edit`, `check:word-inline-format`, `check:word-native-preview` and the full Studio UI regression pass; typecheck is clean for these files (one unrelated pre-existing error in `src/server/http.ts` telemetry from concurrent work). Visual review passed on the Word render: edited two-line header, green in-cell image inside the middle cell, edited text box and footer. Evidence: `output/word-special-regions/` (`special-source.docx`, `special-edited.docx/.pdf`, `model-page-1.png`, `special-ui-edited.docx/.pdf`, `artifact.json`).

Boundaries: regions are plain-text edits (no inline formatting inside headers/footers yet); cards and nested tables inside cells are not supported (images only); existing images already inside cells are preserved but not editable or removable; insertion on a page that is entirely a table continuation still needs a body anchor. Uninstalled; installed release remains 0.5.23.

## Persistent preview session — worktree after 0.5.23

Preview rendering now keeps one long-lived dedicated Word process instead of starting PowerShell plus Word for every render. `scripts/render-word-preview-server.ps1` owns an invisible Word instance, reads one JSON command per stdin line, opens the disposable copy read-only, repaginates, refreshes only pagination fields, exports the PDF, publishes the atomic `.ready` marker and answers on stdout. Ownership (PID plus creation time) is written at session startup — before any document work — closing the previously documented gap where a startup or open stall could strand an unidentified Word process.

`src/studio/word-render-session.ts` manages the helper: serialized commands, per-command timeout, idle shutdown after ten minutes, graceful quit on stdin close, and owner-checked teardown that never sweeps other Word processes. A hang, crash or dead dedicated process destroys the session and retries once with a fresh one (the helper flags a dead owned Word as fatal, distinguishing it from a document Word cannot open, which surfaces as the existing user-facing error without a restart). The per-content preview cache grew from three to six entries; concurrent renders of identical content remain deduplicated.

Measured on the complex five-page fixture through the actual UI: save-to-preview waits are now 2015–3173 ms (median 2513 ms) versus the documented 7058–9182 ms — roughly 3× faster — recorded in `output/word-caret-preview/0.5.23/save-wait-times.json`. Session-level timings: cold start 2627–4216 ms, warm reuse 163–171 ms, cache hit ~0 ms, crash recovery including a fresh session 3136–4342 ms.

Checks: new `check:word-preview-session` verifies session reuse (same owner across renders), warm speed, cache hits without touching Word, automatic recovery after `taskkill` of the owned process (fresh owner, render succeeds, recovery counted), document-error isolation (corrupted content types yield the user error while the session keeps serving), and clean shutdown stopping the owned process. `check:word-native-preview` (byte-identical no-op, concurrent dedupe, page fields/landscape/repeated headers), the deterministic render-process lifecycle test, `check:word-caret-ui` (with new per-save timing evidence), `check:word-inline-caret-ui` and the full Studio UI regression pass. Full typecheck is clean except two pre-existing errors in `src/scripts/check-companions.ts` from concurrent work. Visual review passed: `output/word-preview-session/page-1.png` shows legible English and correctly shaped RTL Arabic.

Boundaries: Microsoft Word on Windows is still required for exact preview (the no-Word fallback remains open); live reflow during typing is unchanged (exact layout still regenerates after save); the reused session adds one hidden owned WINWORD process for up to ten idle minutes. Uninstalled; installed release remains 0.5.23.

## Inline run formatting — worktree after 0.5.23

In-line formatting of a text selection is now supported end to end, closing the "format part of the text" and "keep mixed formatting while editing" gaps. Imports capture per-run formatting as `segments` (text plus explicit bold/italic/underline, colour, highlight, size and font) for paragraphs whose direct children are only `pPr` and plain runs; paragraphs containing hyperlinks, fields or drawings are excluded and preserved as before. The store validates segment shape and requires the concatenated segment text to equal the paragraph text.

Plain-text edits re-flow the segments through a shared helper (`ui/inline-segments.js`): the unchanged prefix and suffix keep their formatting and replaced text inherits the format at the edit boundary, with surrogate-pair-safe boundaries. Splitting at the caret distributes segments across both halves and carries the caret editor's current formatting through the atomic insertion.

The caret toolbar gained غامق/مائل/تسطير toggles, a colour picker, a highlight palette, a font-size input, a font-family picker and a colour reset, applied to the current selection. The editor renders one span per segment for an approximate live view, re-renders after each apply while restoring the caret, and the wrapped toolbar is placed fully above or below the paragraph so it never covers the text. A collapsed caret shows "حدّد النص الذي تريد تنسيقه" instead of guessing a range.

Export rebuilds the paragraph's runs from segments, cloning the original `rPr` of the source run with the largest character overlap for each range and patching only explicit properties, inserted at their CT_RPr schema positions. Unchanged paragraphs round-trip byte-identically; the existing no-op guard covers segments. A whole-paragraph bold/italic toggle deliberately flattens segments.

Checks: new `check:word-inline-format` (fixture with mixed bold/colour/underline/Arabic runs; typing reflow, sub-range formatting with preserved original Georgia `rPr`, caret split distribution, byte-identical no-op, validation rejections) and new `check:word-inline-caret-ui` (real selection via double-click, per-word colour/size/highlight/font through the actual UI, typed-tail inheritance, split distribution, native run export including `rFonts` patching, Word-rendered preview). `check:word-original-edit`, `check-word-caret-model`, `check:word-inline-map`, `check:word-inline-ui`, `check:word-caret-ui`, the full Studio UI regression and the complete repository typecheck pass. Visual review of the native page and the zoomed editor confirmed per-word properties and fully visible Arabic after adding horizontal editor padding. Evidence: `output/word-inline-format/` (`mixed-source.docx`, `inline-caret-edited.docx/.pdf`, `page-1.png`, `inline-caret-toolbar.png`, `editor-zoom.png`, `artifact.json`).

Boundaries: selection-based tools need a non-empty selection; paragraphs with links/fields/drawings stay excluded; the End key in bidi paragraphs can place appended text inside the Arabic tail (browser caret behaviour — the model still preserves formatting); older imports need reimport to gain segments. Not installed yet; installed release remains 0.5.23.

## Completed export and Word teardown — installed 0.5.21

The helper now publishes an atomic completion marker after synchronous PDF export returns, only for a dedicated process identified by native window PID and start time. The process runner allows three seconds for normal teardown after observing that marker, then terminates the helper if teardown remains stuck. The existing owner-checked Word cleanup still runs before the queue proceeds. Partial outputs without the marker remain failures; PDF signature and size checks remain in place. Reused Word sessions do not publish the early-completion marker and are not quit by the helper; application settings are restored during normal cleanup.

Deterministic process tests cover completed export with stalled teardown, nonzero teardown exit, incomplete output failure, render timeout and normal exit. The native complex-file test and full direct-caret UI workflow pass with the new lifecycle; TypeScript passes. Native output retains five pages, page fields, repeated table headers, landscape/merged tables, images and columns. Reviewed the native landscape page. This targets a verified failure mode from 0.5.20; it does not establish that every possible Word timeout is eliminated.

Built and installed 0.5.21, verifying packaged hashes. The first installed run timed out before PDF/owner creation after revision 2. Four abandoned automation processes from our earlier failed tests were positively identified by PID, creation time and automation command line, then stopped; no general Word-process sweep was used. A fresh complete installed run passed for task `task_mvdqgdxm6a0aae983ee2`, revision 9, five pages. Eight save-to-preview waits measured 7.058–9.182 seconds. Geometry validation passed within one point, and pages 1, 4 and 5 were visually reviewed: cards, tables, Arabic text, moved image, inserted card, columns and page fields remain intact.

Evidence: `output/word-caret-preview/0.5.21/installed-result.json`, `installed-caret.docx`, `installed-caret.pdf`, `installed-page-*.png`, `geometry-verification.json`, and installed hash verification. Early Word startup/open failures can still leave a process before ownership is recorded; automatic recovery of that case remains open. The successful clean run does not prove that limitation resolved. This is progress, not completion of the frontier objective.

## Precise keyboard positioning — 0.5.20

Image and card drag handles now support staged keyboard positioning: arrows move one point, Shift+arrow moves ten points, Enter commits and Escape cancels. Blurring the handle cancels the uncommitted gesture. The outline uses the same bounded coordinates as the saved native position. Pointer dragging remains available. The handle tooltip documents the controls.

The iframe regression verifies cancelled keyboard movement, blur cancellation and a committed (1, 10) point movement, alongside bounded pointer dragging and Escape cancellation. Caret insertion/model tests and the full Studio UI regression pass; full TypeScript checking passes. Existing scope boundaries remain: page-local movement, exact Word layout after saving, and unsupported cell/header/footer insertion locations.

Installed 0.5.20 and verified runtime hashes. The complete installed test passed for task `task_mvdpvj4n9de940eb985e`, revision 9, five pages: text/card/cell typing, draft cancellation, atomic caret insertion, cancelled and committed pointer movement, cancelled and committed keyboard movement, and positioned card insertion. Geometry validation confirms the Word-rendered image remains within one point of the saved target; the export retains native anchors without preview hyperlinks. Visually reviewed all five page images and the browser caret screenshot: repeated table headers, edited cell, landscape merged table, Arabic text, moved picture/card, two-column flow and page numbering remain intact without new clipping or overlap. Evidence is in `output/word-caret-preview/0.5.20/`.

The first installed run timed out after revision 2 while waiting 150 seconds for the regenerated preview. A subsequent direct request for the same revision succeeded (HTTP 200 in about 13 seconds), and the second complete run passed every revision. This is an observed intermittent preview-lifecycle/latency problem; the successful retry does not prove it fixed. The test now logs each completed preview revision. The overall frontier goal is not complete.

## Atomic caret insertion — 0.5.18

Text edits and insertion at the caret now save as one document revision. Opening the insertion panel suspends the editable text; cancelling restores its draft and selection. The caret offset follows the selection focus and counts rendered line breaks, including Arabic multiline content. Plain-text editing and IME composition remain supported. The original source identity, paragraph properties and section-ending properties are retained by the split operation.

Verified before installation: `scripts/check-caret-insertion.mjs` (multiline Arabic, cancellation, atomic operation and invalid input), `check-word-caret-model.ts` (native section preservation with revised text), `check-word-caret-ui.ts` (complex native Word workflow), bounded drag/Escape regression, full Studio UI regression, Office import roundtrip regression, TypeScript and encoding. Reviewed native pages 1, 2, 4 and 5: original cards, repeated table headers, edited cell, landscape merged table, moved image, new card, Arabic text, two-column flow and page numbers remain visible. Installation verification is recorded below when complete.

This improves the existing supported insertion locations. It does not add unrestricted insertion inside cells, headers or footers, cross-page dragging, or pixel-exact live reflow during typing. Exact Word layout is regenerated after save.

Installed 0.5.18 and verified packaged hashes, including the shared preview-edit module. The installed complex-file test passed for task `task_mvdm20y34a96c7778627`, revision 8, five pages. It covered direct text/card/cell editing, cancellation restoring an unsaved text draft, atomic insertion from that draft, cancelled dragging, committed image/card dragging and positioned card insertion. Geometry verification confirmed the Word-rendered image position is within one point of the saved target and exported DOCX has native image/table anchors without preview links. Visually reviewed all five installed page images plus the browser caret screenshot. No clipping or new overlap was visible; repeated table headers, landscape layout, merged table, Arabic text, two-column flow and page numbers remained intact. Evidence: `output/word-caret-preview/0.5.18/installed-caret.docx`, `installed-caret.pdf`, `installed-page-*.png`, `installed-browser-caret.png`, `installed-result.json` and `geometry-verification.json`.

Date: 2026-10-18.

## Behavior

- Text, card values/labels, and table headers/cells can be edited with a contenteditable caret on the Word page. Plain-text paste, selection, arrow navigation, Escape to cancel, and Ctrl+Enter to save are supported. The previous contextual panel remains available via the toolbar mode toggle.
- “Insert at caret” splits a body paragraph at the selected text offset, inserts the chosen block, and preserves the original paragraph properties in the continuation. Section-ending properties remain on the final continuation.
- Double-clicking empty page space opens insertion at page coordinates. Positioned elements retain their coordinates in DOCX, with a bounded width for new elements near the page edge.
- Image and card-group drag handles persist native page positions. Word performs the final wrapping and pagination after the save. Existing image geometry and original table formatting are retained.
- Revision conflicts preserve drafts; unsupported merged-grid edits are still rejected before saving.

## Implementation references

Native DrawingML anchors use page-relative offsets in EMUs. Floating tables use `tblpPr` coordinates in twips. See [Microsoft DrawingML Anchor](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.wordprocessing.anchor?view=openxml-3.0.1) and [Microsoft table positioning properties](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.tablepositionproperties?view=openxml-3.0.1).

## Validation completed before installation

- Direct caret test: edited a heading, card value, table cell; inserted inside a heading; dragged image and cards; inserted a positioned card into landscape page space; exported using Word successfully.
- Original Word edit regression passed: unchanged XML/supporting parts, original image frame, grid extension, and no-op byte roundtrip.
- Interactive mapping regression passed: all text positions match ordinary Word rendering; preview links never leak into exported DOCX; section widths remain correct.
- Studio UI regression passed: documents, live updates, conflict recovery, slides, spreadsheets, task isolation, and responsive viewport.
- Targeted strict TypeScript compilation, encoding checks, and the final full repository `npm run typecheck` all passed. The earlier concurrent creative-test typing errors were resolved by the time of the final check.

## Visual review

The five-page complex fixture includes a multi-page table with repeated headers, original cards, a landscape section with a merged table and image, Arabic text, and a two-column section. Reviewed the new native Word render: card and image moves are visible, text wraps around them, the inserted paragraph splits the heading at the selected character, and the new card stays within the landscape page. Page numbering remains generated by Word.

## Boundaries

While typing, the editable overlay approximates the selected field's font and line layout; exact Word pagination is regenerated on save, not on every keystroke. Dragging is within the anchor's page, not across pages. Card groups move together. Arbitrary insertion inside a table cell, editing headers/footers/text boxes, and placing a new object on a page consisting solely of a continued table remain unsupported. Such a page asks the user to choose a body paragraph rather than silently attaching the object to the wrong page. Legacy sourceIndex imports require reimport for spatial editing. Microsoft Word on Windows is required for exact preview.

Evidence directory: `output/word-caret-preview/`.

## Installed build verification

Installed 0.5.12 and verified packaged runtime hashes. Live test task `task_mvdhyy3z088ba6c554a0` reached revision 8 and retained five pages after all edits. `scripts/check-caret-installed.mjs` passed for the actual installed backend and UI.

`scripts/check-caret-geometry.mjs` confirmed native image/table anchors and no preview links in the exported DOCX. The image drag target was (204.5098, 250.6685) points; Word rendered it at (204.5, 250.61) on page 4, within 0.06 points on both axes.

Reviewed installed output pages 1, 2, 4 and 5 as images and pages 1, 4 and 5 in Microsoft Word. Cards and image positioning, edited cell, repeated table heading, landscape layout, inserted card, two columns and page numbers remained visible without clipping or new overlap. Browser proof captures the direct text caret and insert-at-caret toolbar. The section-boundary model test also passed, preserving section count and all split text.

Deliverables: `installed-caret.docx`, `installed-caret.pdf`, `installed-browser-caret.png`, `word-page-1.png`, `word-page-4.png`, `installed-result.json`, `geometry-verification.json` in the evidence directory.

## Reverification on installed 0.5.13

Installed and verified runtime hashes on 2026-10-18. Live task `task_mvdikizfb019795f4677` reached revision 8 after direct text, card and cell edits, insertion at a paragraph caret, image and card dragging, and positioned card insertion. Export saved under `output/word-caret-preview/0.5.13/` because the prior release DOCX was open in Word. The native geometry check passed (under one point). Studio UI regression and caret section-preservation model checks passed.

Visually reviewed Word-rendered pages 1, 4 and 5: original cards and long table, landscape merged table, moved image, inserted card, Arabic text, two-column flow and page numbers remained intact. The browser preview eventually loaded all five pages; an automated fresh-load capture exceeded its 90-second wait, so preview latency remains an observed limitation. Exact layout still regenerates after save, and the boundaries above remain applicable.

## Drag feedback and cancellation — 0.5.15

Drag feedback now uses the same bounded coordinates that are saved to the document. Escape, pointer cancellation and lost capture remove the drag feedback without committing. The drag handle explicitly receives keyboard focus inside the preview iframe, and editing state prevents background refresh during the gesture.

`scripts/check-word-drag.mjs` exercises page bounds, Escape cancellation and a subsequent successful drag inside an iframe. The installed integration test also checks cancellation before committing image/card moves. The first installed run exposed the missing iframe keyboard focus; that was corrected and the installer rebuilt. Another run exceeded the old 90-second native preview wait; direct native rendering returned HTTP 200. The test now allows 150 seconds, matching the preview client timeout. Native Word preview latency remains a known limitation.

Final corrected 0.5.15 installation passed packaged-file hash verification and the full installed caret test, reaching revision 8 with five pages. Native geometry verification passed: image position differs by less than one point from the saved drag target; exported DOCX contains native anchors and no preview hyperlinks. Visually reviewed the installed browser caret and Word-rendered pages 2, 4 and 5: edited cell, repeated table heading, landscape merged table, moved image, inserted card, Arabic text, two columns and page numbers remained intact. Evidence: `output/word-caret-preview/0.5.15/installed-caret.docx`, `installed-caret.pdf`, `installed-browser-caret.png`, `installed-page-*.png`, `installed-result.json`, and `geometry-verification.json`. The scope boundaries above remain unchanged; this is not unrestricted Word editing at every location.
