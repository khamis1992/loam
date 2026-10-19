# Original Word elements — 0.5.9

Imported documents now use stable top-level OOXML element references. Original statistics tables, native tables and embedded PNG/JPEG drawings are editable without rebuilding their surrounding layout. Legacy imports offer an explicit upgrade through their current exported document.

## Preservation and editing

- Existing cards: change values, labels and colors; resizing a simple card row clones its formatting.
- Existing tables: edit cells; adding rows/columns in a simple grid clones the original formatting. Merged table cells retain their merges; grid changes are rejected for merged tables.
- Existing images: replace the image using a fresh media relationship while retaining the original drawing frame, positioning, crop and wrapping. Other uses of the original media remain unchanged.
- Insertion selector chooses any boundary between document elements, including the beginning. Tool append also accepts `insertAt`.
- Unedited supporting ZIP parts and body elements remain unchanged; edits patch the original XML. Unsupported complex/nested elements remain preserved rather than being reconstructed.

## Preview

Reading mode renders the current exported DOCX using bundled docx-preview in a sandboxed iframe. It displays native styles, margins, tables, embedded images, headers and footers. A disposable preview normalization handles explicit `pageBreakBefore` without modifying the downloadable document.

This is a browser rendering of DOCX, not the Microsoft Word layout engine. Automatic pagination, fields and complex floating layouts can differ. The UI states the pagination limitation. No claim of pixel-identical rendering for arbitrary Word files is made.

Renderer: https://github.com/VolodymyrBaydalka/docxjs (Apache 2.0; license bundled under ui/vendor).

## Automated checks

TypeScript, studio concurrency/isolation, original Office round trips, archive safety, import UI, original rich element editing and sandboxed preview checks passed. The new edit check verifies exact untouched XML/supporting parts, no-op byte equality, replacement image frame, inline insertion and table extension. Preview checks verify two pages with original headers/footers, three tables, two images and edited card content.

## Installed visual review

- Installed 0.5.9; final server/editor/preview assets verified against the packaged files by SHA-256 (`output/word-original-edit/installed-files.json`).
- Actual installed task `task_mvdd0apdb8a363245d0f`: edited the original card to 98%, changed an original table cell, replaced the second original image through the chooser, and inserted a paragraph at position 8 through the insertion selector. Saved at revision 3.
- Export verification confirms unchanged original elements and 20 supporting ZIP parts (`installed-verification.json`).
- Opened `installed-original-edits.docx` in Microsoft Word and inspected both pages. Page 1 retains the original title, mixed text formatting, shaded table, logo and header/footer. Page 2 shows the edited cards, original table with updated cell, inserted paragraph and replacement image in the original frame; no clipping or duplicate image observed.
- Installed preview review exposed a reserved `/vendor/` route and an RTL rendering discrepancy. Moved the bundled renderer to a supported static path, normalized RTL alignment and table direction in the disposable preview copy, and rechecked the installed preview. Added direction assertions to the preview regression check.
- The installed preview correctly shows the test document's two pages and content order. Dynamic Word fields (including page numbers) and automatic pagination are still renderer limitations; this is not pixel-identical Word rendering for every document.
- Evidence: `word-original-page.png`, `word-edited-page.png`, `installed-preview.png` in `output/word-original-edit/`.
