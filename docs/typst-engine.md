# Typst engine (blueprint gap 2 — academic publishing)

Local, on-device academic typesetting for Loam: `src/typst/engine.ts` wraps
`@myriaddreamin/typst-ts-node-compiler` (the official typst.ts native binding),
so `.typ` documents — math, tables, figures, numbering, bibliography — compile
to PDF without a LaTeX install and without any network call.

## Tools

| Tool | What it does |
|------|--------------|
| `typst_compile` | Compiles a workspace `.typ` file into a `.pdf` next to it. Returns page count, document title and typst diagnostics. Optional `inputs` object feeds `sys.inputs`. |
| `typst_template` | Returns a compilable academic skeleton (`paper` / `thesis` / `report` / `homework`) with Arabic defaults — title block, abstract, numbered headings and equations, a figure/table slot, bibliography hint. |

Both are registered unconditionally in `src/setup/runtime.ts` (they are local,
read-only-then-write-inside-workspace operations; the PDF write goes through the
path policy like every other file write).

## Design notes

- **Fresh compiler per compile.** Typst compilers keep source state; a per-call
  instance guarantees one task's virtual files never leak into another's.
- **Fonts.** System font directories plus `<workspace>/fonts` are scanned per
  platform (`systemFontDirs()`). Typst substitutes close families when the
  requested one is absent (warning, not error).
- **Templates compile.** `typst_template` output is asserted compilable in the
  test suite — every preset is compiled to a real PDF with Arabic text as part
  of `test:typst`.
- **No sandbox interaction.** Compilation runs in-process on the host; the
  per-task Docker container and the srt OS sandbox govern `shell_run`, not the
  typst engine. The engine reads only the resolved workspace paths.

## Gates

```
npm run test:typst   # engine (5) + tools (5), real compilations
npm run check:typst  # typecheck + tests
```

Packaging note: the npm dependency ships a NAPI binary; the Electron build
must keep `@myriaddreamin/typst-ts-node-compiler` unpacked (external) in the
asar so the `.node` binding loads.
