# Office import in Loam 0.5.4

The live studio accepts DOCX, PPTX and XLSX through Import. Files are stored only in the current task. Imported content can be edited and autosaved, exported in its original native format, and imported again.

The original OOXML package and a validated baseline are kept under .loam/imports in the task workspace. Unchanged export returns the original bytes. Changed export patches supported text/cells into the original package, preserving untouched entries such as styles, media, themes and layouts. Document paragraphs within tables are editable as blocks; the original table structure remains in exported DOCX. The studio preview is simplified and does not render all original visual elements.

Supported editing: DOCX paragraph text, bold/italic/type and new paragraphs; PPTX existing text boxes/backgrounds/notes where notes parts exist, slide reordering/deletion; XLSX existing cell values/formulas and additional rows/columns, with original cell styles, merges and dimensions retained. Imported presentation newslides and imported workbook newsheets/rename are blocked rather than silently losing layout or formula references. Legacy DOC/PPT/XLS and macro-enabled/encrypted files must first be converted to DOCX/PPTX/XLSX.

Import limits:20MB upload, bounded ZIPentry/decompressedsize, XML entity/doctype rejection; content validated using existing studio limits. Invalid imports and stale revisions do not replace existing work. Source UUIDs resolve only within the task, with symlink/junction rejection.

Verification commands: check:studio-import, check:studio-import-http, check:studio-import-ui, check:studio-import-safety, check:studio, check:studio-export, typecheck, check:packaged. Fixtures verify formatting and native roundtrips; HTTPtest includes persistence/restart and taskisolation; UI test includes failed import/conflict/navigation. Safety suite18checks. TestSprite CLI unavailable; graphify returns without a usable report. Neither is claimed as verified.

Packaged Electron verification passed: actual file chooser import for all three formats, direct text/cell edits, persistence and native export. Live MCP5/5 and native PTY passed. Screenshots: release/loam-import-document.png, release/loam-import-presentation.png, release/loam-import-spreadsheet.png. The packaged test now waits for the target task title before uploading, preventing a test race with navigation.

A broader UI regression run found overflow in the concurrently changed Media/Creative page at320pxLTR. Office import UI and existing Office studio tests passed; the unrelated Media result is not reported as a pass. Typecheck and encoding passed after concurrent source changes settled.

Release: Loam-Setup-0.5.4.exe,146228043bytes. Updatefeed/wholefile/SHA512/blockmap verification5/5 passed. User requested waiting for active task: waited until no queued/running tasks before installer; task ended error and its record was preserved.

Installed0.5.4 passed native Office import/edit/export checks. Running user profile on3940 because another development server owns3939. All12previous tasks retained; MCP5/5 connected. Evidence: release/installed-verification-0.5.4.json.
