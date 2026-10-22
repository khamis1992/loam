# Imported Word rich elements — 0.5.8

The imported document remains the export template. New statistics cards, tables and PNG/JPEG images are appended in editor order before the final section properties. Existing text edits still use source paragraph indexes.

## Preservation

- Original styles, theme, numbering, headers, footers, media and other supporting parts remain byte-identical.
- Unedited original body elements and section properties remain structurally identical. Avoid creating empty formatting properties on untouched paragraphs.
- Only the main body, image relationships and image content-type declarations receive additions. New media filenames, relationship IDs and drawing IDs avoid existing identifiers, including header/footer drawings.
- New tables/images fit the final section's page margins and column widths; Arabic labels/cells determine direction even with English filenames.
- Existing imported elements retain their original structure and formatting. The editor still provides a simplified preview; final pagination belongs to Word and may change as content is added.

## Verification

- TypeScript, original Office round trips, rich export validation, imported editor UI and encoding checks passed.
- Dedicated fixture includes colored mixed-format text, an original table, original image, custom header/footer, narrow margins and an explicit page break.
- Assertions compare original body elements, sections and every unchanged supporting ZIP part, verify relationships/drawing IDs, repeat export without duplication, and reimport unchanged output.
- Installed Loam 0.5.8 verified by executable version and SHA-256 comparison of server/UI files. Actual task `task_mvdbzerd7aefb5a31720` used the default `glm-5.3-flash:cloud`, completed normally at revision 4, and added exactly one stats group, one table and one image.
- End-to-end export retained all six original blocks, original body XML/section structure, and 19 original supporting ZIP parts. Evidence: `output/word-import-review/installed-verification.json`.
- Opened the actual installed export in Microsoft Word: two pages, original page visually unchanged; second page has three RTL cards, a shaded table with aligned columns, one centered image and captions inside the template margins. Original header/footer remain visible. No overlap, duplicate image or clipped content observed.
- Visual evidence: `original-page-1.png`, `word-final-original-page.png`, `word-final-additions-page.png` in `output/word-import-review/`. Deliverable: `loam-imported-rich-final.docx`.

## Issues found during installed testing

- GLM initially repeated image additions and attempted an incomplete replacement after a successful append. The first two attempts were stopped and were not accepted as final results.
- Image resolution had mutated the tool arguments retained in conversation history. Clone tool arguments before resolution, return compact save receipts, and expose reusable task-local image references instead of base64 on reads.
- Reject agent replacements that omit any existing imported source paragraph. Manual editor deletion remains available.
- Regression checks cover argument immutability, compact image reads, image-reference round trips, title retention, foreign-reference rejection and imported-content truncation protection.

## Editing boundaries

New rich elements are added at the end of imported Word documents. Existing imported complex tables/cards remain in their original native form; their text is editable through imported paragraphs. Existing images are preserved; the new image controls apply to images added in Loam. This does not rebuild arbitrary imported layouts as fully editable card widgets.
