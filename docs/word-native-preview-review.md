# Word-native preview — Loam 0.5.10

Verified on 2026-10-18 with the installed Windows application and Microsoft Word.

## Result

Reading mode now exports the current DOCX and asks the locally installed Microsoft Word to paginate and export a disposable copy to PDF. A sandboxed, bundled PDF.js viewer displays those pages, including page fields, automatic table pagination, repeated headers, merged cells, mixed page orientation, images and multiple columns. The editable source remains DOCX. The viewer displays the page count and offers fit-width and full-size views.

The server route `/api/studio/preview` enforces the existing task workspace and mode guards, reports the rendered revision, deduplicates identical concurrent requests and keeps a bounded in-memory PDF cache. Conversions are serialized and have a timeout. The helper closes its document without saving, restores Word options and quits its own instance. Timeout cleanup checks the exact Word window's process ID, process start time and whether that process existed before conversion; it never terminates Word by process name alone.

Preview copies disable macro execution and external-resource relationships; saved content fields stay locked while PAGE, NUMPAGES and SECTIONPAGES are refreshed. The original import and exported file are not rewritten for rendering.

## Evidence

- `output/word-native-preview/complex-source.docx`: test fixture with 57 data rows, cards, merged cells, image, Arabic text, portrait/landscape sections and a two-column editorial section.
- Five PDF pages; PAGE/NUMPAGES resolve to 1–5 of 5. Automatic table continuations repeat the header on pages 2 and 3. Page 4 is landscape; page 5 has two columns.
- `verification.json`: native renderer assertions, exact no-op import/export bytes and concurrent request deduplication.
- `installed-verification.json`: installed 0.5.10 import/export, updated preview after editing, five pages and rejection of an unknown task.
- `installed-files.json`: matching SHA-256 hashes of nine runtime assets between the installed application and final packaged build.
- `preview-page-1.png` through `preview-page-5.png`: actual browser canvas output.
- `word-page-1.png`, `word-page-4.png`, `word-page-5.png`: Microsoft Word UI observations. The first page ends at row 23, the second starts at 24; the landscape and two-column layouts match the preview. Word's editing-only spelling underlines and dimmed inactive headers do not belong to the printed PDF.
- `installed-preview.png`: preview displayed in the actual installed application. GLM remains the selected default model.

## Checks passed

`typecheck`, `check:word-native-preview`, `check:word-preview`, `check:studio-ui`, `check:word-original-edit`, `check:studio-import-safety` (18 checks), `check:encoding`, and `scripts/verify-native-word-installed.mjs`.

The final helper process-ownership adjustment was retested directly with Word and through the installed API. An already-open Word review document remained open after conversions.

## Scope

This is Word's print/PDF layout on this computer, requiring installed and activated Word on Windows. Font availability, Word version and printer/layout settings can affect results on another computer. External linked content is not fetched; the preview uses embedded content and saved field results except for pagination fields. The exact preview is read-only; editing continues through the element editor and is reflected when the preview is regenerated. This five-page test validates the covered layouts, not every possible Word feature.

Microsoft API references: [Repaginate](https://learn.microsoft.com/en-us/office/vba/api/word.document.repaginate), [ExportAsFixedFormat](https://learn.microsoft.com/en-us/office/vba/api/word.document.exportasfixedformat), [Documents.Open](https://learn.microsoft.com/en-us/office/vba/api/word.documents.open).
