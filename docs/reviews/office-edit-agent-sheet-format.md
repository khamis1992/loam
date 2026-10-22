# Review — `officeEditAgent.ts` + `sheet-format.ts`

Branch `mf/froffice`. Scope: pinpoint Office edits (`src/tools/officeEditAgent.ts`)
and the typed studio cell model (`src/studio/sheet-format.ts`). No rewrite; targeted
bug fixes, hardening and focused tests.

## Findings and fixes

### High

1. **Arabic grammar was silently dead (i18n).** Every keyword regex used JS `\b`,
   which is ASCII-only, so `/\bعنوان\b/`, `/\bملاحظات\b/` and `\b(?:to|إلى)\b` never
   matched Arabic. The tool advertises Arabic forms in its grammar but
   `عنوان المستند إلى …`, `شريحة 2 ملاحظات …` and `فقرة 3 …` planned **zero ops**.
   Fixed with Unicode-aware lookarounds (`NOT_WORD`/`NOT_WORD_END`, helper `word()`)
   used for the title/notes/`إلى` markers. `فقرة` already worked (no `\b`).

2. **Empty search term corrupted documents.** `replace "" with "X"` produced
   `find === ""`; the applier ran `text.split("").join("X")`, inserting `X` between
   every character of every matching block/region/cell. The planner now ignores a
   clause with an empty find and the applier rejects `find === ""` with a skip
   reason (defence in depth).

3. **Ragged grids produced holes that failed validation.** `set-cell` bounded the
   column by `sheet.cells[0].length` and assigned directly, so editing a cell in a
   shorter row left `undefined` holes; `saveStudio` then failed with an opaque
   "Expected text…" error. Now the bound uses the widest row and the target row is
   padded with `""` before assignment.

### Medium

4. **Kind switch failed on an existing studio.** Re-importing a file whose kind
   differed from the active studio passed `expectedRevision = 0`, so
   `saveStudio` threw a 409 whenever `studio.json` already had a revision. The
   current revision is now carried into the import.

5. **Semicolons inside quoted values split clauses.** `instruction.split(/;|…/)`
   broke `set cell B2 to "a;b"` into two invalid clauses. Added `splitClauses()`,
   a quote-aware splitter (handles `"…"`, `'…'`, `«…»`).

6. **Export/file-write failure handling.** The tool saved the studio, then exported
   and wrote the file. An export failure now returns a clean "nothing changed"
   result (export runs before the save), and a file-write failure after a successful
   save reports the saved revision instead of a bare error.

7. **Typed-cell hardening (`sheet-format.ts`).**
   - `applyCellType` now rejects an invalid `{ date }` instead of writing an
     `Invalid Date`.
   - `typedCellValue` rejects impossible calendar dates (`2021-02-30`) that
     `Date.parse` silently normalizes.
   - Font/fill colours go through an `argb()` guard that throws `StudioError` on a
     non-`#rrggbb` value instead of emitting a malformed `FF…` string.

### Low / notes

- `sheetMatch1()` was called twice per `set-cell` clause; now called once.
- `replace-text` on a spreadsheet interprets `op.slide` as a `sourceIndex` filter.
  Generated sheets have no `sourceIndex`, so a `slide N` prefix on a spreadsheet
  replace is a no-op. Left as-is (unusual instruction); noted as a follow-up.

## Tests

- `src/tools/__tests__/officeEditAgent.test.ts` — added: Arabic planning,
  empty-find rejection, ragged-grid padding, quote-aware splitting, different-kind
  re-import revision, export-failure leaves no save, file-write failure reports the
  committed revision.
- `src/studio/__tests__/sheet-format.test.ts` — new: typing rules, native Excel
  write/read round-trip, invalid-date and malformed-colour rejection, `cellAddress`,
  `applySheetFormat` (typed cell, style, merge, dimension).

Run:

```
node --import tsx --test src/tools/__tests__/officeEditAgent.test.ts src/studio/__tests__/sheet-format.test.ts
```

## Gates

- `npx tsc --noEmit` — 0 errors.
- `npm run build:server` — exit 0.
- `cd packages/web && npx tsc --noEmit` — 0 errors (no web tests touched, so no
  vitest run).
- `node --import tsx --test src/tools/__tests__/*.test.ts` — 99 pass.
- `node --import tsx --test src/studio/__tests__/*.test.ts` — 29 pass.
- `npm run check:encoding` — only pre-existing issues in untouched `src/server/*`
  files; no new findings in the reviewed files.
