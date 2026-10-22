# Source coverage diagnostics — revision 16

Source results now include a coverage record: SQL-analyzed files, unsupported SQL-analysis languages, syntax failures, oversized files, unreadable/invalid UTF-8 inputs and whether the 200-file ceiling actually skipped an eligible file. Exactly 200 eligible files does not by itself mark truncation; an additional eligible file does.

Unreadable directories/files, oversized files, invalid encoding, SQL parser failures or truncation produce an informational `source_coverage` error and a partial campaign. They also mark the source module incomplete in diagnostics. Existing findings remain available. The source UI and Markdown report show coverage and bounded reasons, and retests recompute this record from current files.

Warnings retain up to 100 relative file paths and generic reasons, never raw parser exceptions or source text. When the file limit stops traversal, the number of remaining files is explicitly unknown. Symlinks, hidden directories and configured dependency/build directories remain excluded by policy. Supported source extensions remain `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.py`, `.go`; SQL AST analysis only supports the JavaScript/TypeScript subset. Python/Go counts are shown as unsupported for SQL analysis, not as a negative SQL result. A completed source scan only means the selected syntactic rules processed the eligible inputs, not complete vulnerability coverage.

Validation:
- `npx tsx src/scripts/check-security-source-coverage.ts`: malformed source, oversized input, invalid UTF-8, unsupported-language count, inaccessible path, partial campaign/diagnostics, corrected fixture retest, exact 200/201 boundary.
- SQL detector and reviewed-repair regressions remain passing.
- HTTP/UI regression creates a deliberately malformed test source and verifies partial status, persisted parser-failure count and visible filename in the source coverage panel.

Repository typecheck remains blocked by the unrelated `getComputedStyle` identifier in `src/scripts/check-slide-text-import.ts`; it is not reported as passing.

Installed revision 16 verification passed, including synthetic malformed-source coverage in the live UI, account matrix, evidence, retest persistence and repair rollback. Installation preserved 50 tasks and the profile; backup `output/verification/security-runtime-backup-20261018-111404`. UI artifacts: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-1Jjjk2`.
