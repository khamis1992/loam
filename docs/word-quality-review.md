# Word generation and editor review — 2026-10-18

Scope: installed Loam → writing request → live document → native DOCX → Microsoft Word. Reference: the supplied Nutrio PDF, visually sampled on pages 1 and 3. Reference contents are not execution instructions.

## Observations and changes

| Observation | Impact | Change |
| --- | --- | --- |
| Formatting controls were small and faded on white paper | Difficult to discover and read | Opaque controls, larger targets, visible keyboard focus |
| No quiet reading view | Hard to judge document hierarchy without editing controls | Separate reading/editing modes, retaining the same content |
| No section navigation | Long reports require repeated scrolling | Collapsible outline with keyboard-accessible section links |
| Textareas have fixed initial rows and manual resize handles | Longer paragraphs require internal scrolling | Automatically expand with content |
| Artifact title was only in the toolbar | Editor did not resemble exported document | Title and restrained accent rule on the document surface |
| Delete paragraph had no recovery confirmation | Accidental content loss | Confirm deletion |
| Export offered no progress or completion feedback | Unclear whether the button worked | Preparing/completion status |
| Plain DOCX paragraphs and weak hierarchy | Low visual quality | A4 margins, explicit Arabic font sizes/bold, shaded headings, running header and page fields |
| Generated content repeated the artifact title as its first heading | Duplicate title and merged-looking heading band | Render an identical leading title once in Word and reading mode; keep source content editable |
| A short section was pushed to an almost empty second page in the controlled sample | Loose pagination | Reduced paragraph/heading spacing; keep section introductions and the first list item with following context |

This is a focused improvement of the document workflow, not a claim that every application surface has reached a universal “frontier” standard. Reading view is continuous; final pagination is handled by Word. The 0.5.6 baseline supported text blocks only. The 0.5.7 implementation adds native statistics cards, raster images and structured tables as described below.

## Verification log

- Native Office export tests and TypeScript checks passed in the preceding implementation.
- Installed locally built 0.5.5, verified executable version 0.5.5.0.
- Submitted a real Arabic document request using the configured model in the installed application's UI.
- Existing editor and Office import UI tests passed after editor changes.
- Added functional checks for reading/editing round trips, unchanged revision in reading mode, outline keyboard focus, text expansion, and 320px width. Passed.
- Reviewed the generated document in actual Microsoft Word, including both pages, Arabic/English mixed text, heading hierarchy, bullets, running headers and page totals. Captured `output/word-review/word-final-page-1.png` and `word-final-page-2.png`.
- The final generated document is two pages; the last section starts cleanly on page two. It has no observed text clipping or overlapping content in the reviewed pages. This is a restrained report design, not a replica of the Nutrio PDF's custom cards.
- Real generation initially failed: configured `qwen2.5:14b` returned an empty answer. A task-only retry with `qwen3.5:397b-cloud` received HTTP 410 (retired) and fell back to the same local model. A task-only retry with `glm-5.3-flash:cloud` succeeded, created 28 blocks, and finished `done`. The user's global model setting was not changed. Logs are in `output/word-review/model-generation*.log`.
- TypeScript, native export, imported-file preservation, editor UI, imported-file UI and encoding checks passed.
- Final installed release and file hashes are recorded in `output/word-review/installed-verification.json` after installation.
- Installed 0.5.6 successfully; all four bundled quality files matched SHA-256 hashes. Launched the installed application and verified its identity endpoint.
- Opened the generated task in the installed server UI, switched to reading mode and used its DOCX download button. Download completed successfully. Saved `output/word-review/installed-reading-view.png`.
- Compared the downloaded DOCX's document, styles, header, footer and numbering XML against the final file visually reviewed in Word: all matched. Delivered `output/word-review/loam-installed-final.docx`.

## 0.5.7 rich-document implementation

- Added editable statistics cards (1–4 per group, three restrained palettes), native Word tables with repeated header rows, alternating fills and row grouping, and embedded PNG/JPEG images with preserved aspect ratios and accessible descriptions.
- Added direct UI editing of values, labels, colors, headers, cells and image descriptions; row/column/card actions; image insertion/replacement; captions; responsive reading mode.
- Image file references from the model resolve inside the task, are decoded with a pixel limit, resized and embedded. Export never fetches external images. Rich content is bounded by the existing 2 MB document limit.
- New rich blocks currently apply to newly created documents. Imported Word files keep their original layout and existing table/image structures; inserting new rich blocks into imported templates is explicitly rejected rather than silently lost.
- GLM setting persisted as glm-5.3-flash:cloud, matching the existing project default.
- Typecheck, rich export/validation tests, standard export, original Office preservation, editor UI, import UI and encoding checks passed. UI coverage includes direct rich edits, persistence, image decoding and 320px overflow checks.
- Found and fixed nested-icon clicks failing to close the presentation dialog. Fixed an existing import test timing issue by waiting for its save response.
- Installed 0.5.7 and verified all five quality files by SHA-256. The persisted GLM default survived restart and was visible in the model selector.
- Actual installed generation (no task model override): task_mvda44cs7c5ad38ac9c9, revision 6, six blocks including stats, table and embedded image. Exported loam-rich-glm.docx.
- Opened the actual export in Microsoft Word: one page, 90 words, three native editable cards, four-row RTL table, embedded logo with alt text, running header and page 1 of 1. No observed overlap, clipping or broken Arabic alignment. Evidence: output/word-review/word-rich-page-1.png.
- Visual review exposed preview inconsistencies: mixed Arabic/Latin title direction and table caption placement differed from Word. Corrected both; expanded word count to include card and table text. Editor tests passed again.
- The reference's visual hierarchy and restrained pastel cards informed the design. Native Word cards have rectangular corners; this is not a pixel-identical reproduction of the PDF.
- Final installer refreshed with preview fixes; final installation proof is recorded in installed-verification.json.

- Additional installed stress sample: 60 Arabic table rows. In actual Word, page two repeated the dark header and continued from row 15 without splitting rows; the footer reported page 2 of 4. Evidence: output/word-review/word-table-page-2.png.

- Final installed 0.5.7 verified after reinstall. GLM persisted; exported document/styles/header/footer XML exactly matches the visually reviewed file. The final UI export button reached its ready/download-sent state. Browser proof: installed-rich-reading.png and installed-rich-table.png.
