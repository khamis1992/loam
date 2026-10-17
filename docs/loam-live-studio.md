# Loam Live Studio — 0.5.3

The Office card opens a live editor beside task preparation/chat. Write supports documents, slides and spreadsheets; Data defaults to spreadsheets. Existing application previews and isolated task directories remain intact.

## Implemented

- Documents: editable heading/paragraph/bullet blocks, bold/italic, insertion/removal.
- Presentations: editable slide title/body/notes, background/accent colors, thumbnails, insertion/deletion/reordering, presentation view.
- Spreadsheets: editable cells/formula bar, rows/columns/sheets. Local calculation supports arithmetic, cell references and SUM/AVERAGE/MIN/MAX; unsupported formulas show an error. XLSX retains formulas for recalculation in the spreadsheet application.
- The native loam_studio tool reads/replaces/appends content; model instructions request small incremental additions. UI polls current task every1.2s while preserving dirty edits.
- Revision comparison prevents silent overwrite. Conflict choices explicitly keep manual content or accept current server content. Autosave and task creation are coordinated across navigation.
- Native DOCX/PPTX/XLSX downloads. This initial editor does not import existing Office files or offer full Office feature parity.

## Storage and verification

Content is validated and atomically stored in each task's .loam/studio.json. Task id required; Write/Data-only API and tool permissions; symlink traversal denied.

Passed: TypeScript, encoding, mode capabilities, orchestrator78checks, task isolation/recovery HTTP, existing UI responsive RTL/LTR320/768/1440 + zoom, ancillary UI, actual model-tool HTTP integration, restart persistence, studio UI including conflicts/formulas/sparsecells, and native export archive/roundtrip tests. Packaged verification includes live studio pages and all three native downloads in an isolated profile.

TestSprite was unavailable (CLI not installed); use testsprite setup to configure it. graphify update . returned1 without diagnostics. No TestSprite or graph verification claimed. Dependency audit findings recorded in release/studio-dependency-audit.json; new transitive findings concern paths not used by this exporter.

## Release evidence

The packaged Electron app passed identity/version checks, native PTY execution, all five MCP connections, live editor rendering for each kind, and DOCX/PPTX/XLSX download checks. Screenshots: release/loam-packaged-studio-document.png, release/loam-packaged-studio-presentation.png, release/loam-packaged-studio-spreadsheet.png. Final installer: release/Loam-Setup-0.5.3.exe (143,457,886 bytes); feed/hash/size/blockmap checks passed5/5.
