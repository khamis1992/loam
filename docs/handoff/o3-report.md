# O3 report — typed Excel cell values in the studio (GridCraft typed-value model)

Branch `mf/o3`, worktree `C:\Users\khamis\Desktop\mf-wt\o3`.

## Problem

Spreadsheet artifact cells were a plain string grid (`cells: string[][]`). Type selection happened
with ad-hoc heuristics duplicated in three places (`src/studio/export.ts` for generated workbooks,
`src/studio/roundtrip.ts` for imported ones, `src/studio/import.ts` when reading back), and the
three sets disagreed: generated exports never wrote real dates, booleans were exported as text,
and the imported patcher gated date restoration on the *previous* cell value instead of the value
model. That made cell types lossy and inconsistent on export/import.

## What landed

Typed-cell value model, defined once and used by both serialization paths:

- `src/studio/sheet-format.ts`
  - `StudioCellValue` — `string | number | boolean | { date: string }`; formulas stay strings
    starting with `=` (existing studio convention), text otherwise.
  - `typedCellValue(value)` — parses a grid value into its typed form: canonical decimals → number
    (≤15 significant digits, ≤1e15), strict `YYYY-MM-DD` (1900+) → `{date}`, `true`/`TRUE` /
    `false`/`FALSE` → boolean, `=...` formulas and everything else stay text. Leading-zero strings
    (`00123`) and 17+ digit ids remain text, matching the existing export contract.
  - `applyCellType(cell, value, style?)` — writes the native kind into an ExcelJS cell; date cells
    gain `yyyy-mm-dd` only when the cell has no explicit number format (user formats always win).
  - `sheetCellValue(cell)` — reads an ExcelJS cell back into a typed value (numbers, booleans,
    `{date}`, `=formula`, rich text, hyperlink, error text).
  - `cellAddress(column,row)` helper.
  - `applySheetFormat` now writes **all** cell values through the typed model (before applying
    styles), so generated exports produce native numbers/dates/booleans/formulas/text from the
    unchanged string grid — no lossy stringification.
- `src/studio/sheet-roundtrip-format.ts`
  - `writeSheetValue(doc, cell, value, epoch)` — serializes each typed kind into its distinct
    OOXML form: `<v>` numbers, `t="b"` booleans, date serials (1900/1904 epochs), `<f>` formulas,
    inline strings for text. Untouched (`t`, `s`) attributes/styles preserved.
  - `displayNumber(text)` — editorial numeric display forms (`1,234.50`, `18.5%`, spaced groups)
    that can restore a number when the cell's existing number format is numeric (builtin map plus
    custom codes without text/date placeholders). This keeps edited percent/thousand-separated
    cells numeric instead of silently demoting them to text.
  - `sheetDateEpoch(date1904)` — serial epoch, read from the workbook part lazily only when a date
    is being patched.
  - `patchSheetValues(zip, doc, current, old)` — re-serializes **exactly the changed** grid cells
    with typed values; unchanged cells keep their original XML (shared strings, shared formulas,
    media and styles stay byte-identical). No changes → no writes, so no-op saves stay
    byte-identical. Called first in `patchSheetFormat`, before style patching, so it reads the
    original style attributes.

No non-owned behavior changed: the studio artifact model, validation, UI and the agent-tool
contract are untouched (`cells` keeps flowing as text; conversion is centralized in the two owned
modules, which are the only places touching workbook value XML in their callers).

## Focused test

`src/scripts/check-sheet-typed-values.ts` (`npx tsx src/scripts/check-sheet-typed-values.ts`):
typed parsing table, formatted-number restore table, per-kind OOXML shapes, a real
write→loadXLSX→read cycle proving every kind survives byte round trip, the generated-export wiring
(exportStudio → workbook assertions) and a full imported cycle (exportStudio → importStudio →
value edits: `19.25%` → number `0.1925`, date retype, boolean edit → native `t="b"`, text edit →
inline string) with byte-identical untouched supporting parts (styles.xml etc.).

## Verification

- `npx tsc --noEmit` — 0 errors.
- `npx tsx src/scripts/check-sheet-typed-values.ts` — PASS.
- `npm run check:studio-export` — PASS.
- `npx tsx src/scripts/check-sheet-format.ts` — PASS.
- `npx tsx src/scripts/check-sheet-grid.ts` — PASS, including exact no-op round trip, imported
  merged/hidden preservation, direct numeric edits and pasted values/formulas.
- `npm run check:studio` could not run here: its server port 8787 is already in use by the live
  Loam server in this environment (EADDRINUSE); unrelated to this change.

## Decisions & limitations

- `TRUE`/`FALSE`/`true`/`false` grid text now types as boolean, mirroring Excel's own typing when
  Excel reimports such text; legacy artifacts containing literal text "TRUE" get the same typing
  only when that cell changes (untouched cells keep their original XML).
- Dates outside the XLSX serial range (pre-1900) remain text rather than negative serials.
- Formulas remain formula-text strings (`=...`); filling their cached values is left to the
  spreadsheet application (`fullCalcOnLoad/forceFullCalc` already set by the round-trip writer).
- Ownership note: the value-serialization call sites live in `import.ts`/`export.ts`/`roundtrip.ts`
  (not owned). This task needed no edits there: `applySheetFormat` and `patchSheetFormat` already
  receive the sheet objects after those sites run, so the typed model replaces and outranks their
  heuristics entirely from inside the owned files. `sheetCellValue` is exported ready for O4 or a
  follow-up importer refactor to stop emitting display-text strings at import.
- mf-common.txt was referenced by the task but does not exist anywhere in the repo or branches;
  standard rules from docs/AGENTS_PLAN.md were followed instead (owned paths only, no push, no
  secrets).
