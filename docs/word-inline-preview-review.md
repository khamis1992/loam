# Word inline preview review — 0.5.11

Date: 2026-10-18. Installed build: Loam 0.5.11.

## Delivered behavior

Click text, a statistic value/label, table header/cell, or an image on the Word-rendered page to open a contextual editor on that page. Save regenerates the preview using Microsoft Word, including automatic pagination and fields. Whole-element editing and insertion before/after any top-level block are available. The insertion menu covers the document start/end and every block boundary.

Temporary hyperlinks in a disposable preview copy provide Word-generated hit rectangles. They are never added to the exported document. Existing source identities, section geometry and image frames are preserved. New rich elements use the width of their actual section, including landscape and multi-column sections. Invalid merged-table grid edits are rejected before saving. Revision conflicts retain the typed draft.

## Validation

- `check:word-inline-ui`: text, card, table, image, insertion, regenerated pages and conflict draft preservation passed.
- `check:word-inline-map`: 205 edit targets; all text strings and positions equal the ordinary Word PDF on five pages; preview does not mutate exported bytes; landscape/column insertion widths verified.
- `check:word-original-edit`, `check:studio-ui`, `check:encoding` passed.
- Targeted strict TypeScript checks for changed backend/modules passed; build and installer completed.
- Full `npm run typecheck` remains blocked by errors in the concurrently developed `src/scripts/check-creative-http.ts` (DOM typings and possibly undefined values).
- Installer verification matched packaged/installed runtime hashes.
- `node scripts/check-inline-installed.mjs` passed against the actual installed server, version 0.5.11. Task: `task_mvdh6fjyf9b964dd1b9c`, final revision 6. Edited all four element types and inserted a paragraph before the landscape dashboard. Invalid merged-grid save returned 400 and preserved revision 6.
- GLM `glm-5.3-flash:cloud` remained selected in the installed UI.

## Visual findings

Reviewed all five exported page images. Page 1 contains the changed heading and 99% card; page 2 contains the edited row 24 and repeated table heading; page 3 completes the table; page 4 retains landscape geometry, merged cells, the replacement image frame and inserted paragraph; page 5 retains two-column flow. No new clipping or overlap observed. Sparse space on pages 3–4 is retained from the fixture's section breaks.

Opened `installed-edited.docx` in Microsoft Word and visually checked pages 1 and 5. Word initially displayed a partial background page count, then repaginated to five pages; the header/footer numbering and line endings matched the preview. Browser review confirmed the on-page card editor and saved revision.

Evidence: `output/word-inline-preview/installed-test.json`, `installed-edited.docx`, `installed-edited.pdf`, `installed-page-1.png` through `installed-page-5.png`, `installed-browser-proof.png`, `installed-word-page-1.png`, `installed-word-page-5.png`.

## Scope limits

This is a contextual editor over exact Word-rendered pages, with reflow after saving. It is not a continuous character-level Word canvas. Insertion is at top-level block boundaries; arbitrary pixel placement, insertion inside a paragraph/cell, editing headers/footers, and every possible drawing/text-box layout are not implemented. Legacy imports using only sourceIndex need reimport to obtain the spatial edit mapping. Native preview requires Microsoft Word on Windows. Original merged grids permit content edits but reject unsupported structural changes.
