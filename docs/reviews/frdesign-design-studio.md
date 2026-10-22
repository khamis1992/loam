# Review — Design Studio brand kit / templates (`mf/frdesign`)

Scope: `src/tools/designStudio.ts` (agent tool surface) plus the module it
sits on (`src/server/designStudio.ts`, `src/server/routes/designStudio.ts`).
Behavioral-spec clean-room code; no ArtCraft code/assets/names involved.

Verdict: the core (brand kit model, JSON templates, deterministic fill, SVG
render, sqlite persistence) is sound. One **critical** wiring defect made the
entire HTTP surface dead code, and the tool layer had no test coverage at all.

---

## Findings

### F1 — CRITICAL: `/api/design/*` was never mounted (dead surface)

`src/server/routes/designStudio.ts` exports `handleDesignStudioRoutes`, but
nothing imported or dispatched it. `grep` across the repo found only the module
itself; `src/server/http.ts` had no import and no dispatch line. Consequences:

- Every `/api/design/...` request 404'd, so the `/app/design` page could not
  list brand kits, templates, or outputs — it rendered an empty shell.
- `design_create`'s result advertised
  `preview via GET /api/design/outputs/<id>/image`, which always 404'd.
- The `d1-report.md` handoff explicitly deferred these two lines to a
  "supervisor" who never applied them.

**Fix:** added the import and the dispatch to `src/server/http.ts`
(`handleDesignStudioRoutes(req, res, p)` alongside the other route modules, so
it runs before the generic handlers). Regressions guarded by a test that reads
`http.ts` and asserts both lines exist.

### F2 — HIGH: no vision feedback; the model could not see its own design

`design_create` returned only file paths. The model had no way to check the
rendered result, so it could not notice a bad layout and iterate.

**Fix:** when a raster exists, attach it as `ToolResult.images` (the same
mechanism `file_view_image` / `screen_look` use) so the next model call is a
vision call over the real artifact.

### F3 — MEDIUM: explicit unknown `templateId` / `brandKitId` silently ignored

`generateDesign` falls back to auto-pick when `getTemplate(input.templateId)`
misses, and `resolveBrand` throws only when a *named* kit is missing. So a
model asking for `templateId: "billboard"` got a poster and no warning.

**Fix:** the tool validates both up front and returns a clear error naming the
valid templates. Auto-pick still applies when the argument is omitted.

### F4 — MEDIUM: logo refs were embedded into served SVG without a scheme allowlist

A brand kit's `logoRefs` become `<image href="...">` in the SVG that
`/api/design/outputs/:id/image` serves as `image/svg+xml`. `javascript:` /
`vbscript:` / non-image `data:` URIs and protocol-relative `//host` refs were
accepted verbatim. (Not a direct XSS — all other interpolations are escaped and
quote-delimited — but an unnecessary script-capable sink in a served document.)

**Fix:** `isRenderableLogoRef` in `src/server/designStudio.ts` (single source
of truth, so the HTTP route is protected too) keeps `http:`, `https:`, `file:`,
`data:image/*` and plain paths, and drops everything else.

### F5 — MEDIUM: injected image-tool output was trusted on size

`generateDesign` wrote `imageBase64Png` straight to disk and the tool would
happily have forwarded it to the model. A misbehaving `imageGen` could produce
an unbounded attachment.

**Fix:** the attachment path is bounded (`MAX_TOOL_IMAGE_BYTES`), stat-checked,
and PNG-magic-verified; otherwise the tool still succeeds and reports the path.

### F6 — LOW: workspace mirror copied only the SVG

The mirror dropped the raster, so the task workspace / studio library only got
the editable SVG. Now both the SVG and the PNG are mirrored, reported as
`workspaceFiles`. Mirror failures remain best-effort (the design store is
authoritative) and are tested as such.

### F7 — LOW: non-string tool args coerced loosely

`str(args, "id")` turned an object id into `"[object Object]"`, which surfaced
as a confusing `brand kit not found`. Now trimmed; the error is still correct
and no longer depends on `String()` of a random object.

### F8 — process: zero test coverage at the tool layer

`src/server/__tests__/designStudio.test.ts` covers the pure core; nothing
covered the `Tool` objects, the route module, or the mount. See Tests below.

---

## Tests added

| File | Covers |
| --- | --- |
| `src/tools/__tests__/designStudio.test.ts` (new, 14 tests) | input validation (unknown template/kit, empty brief), vision attachment + size cap, SVG-only designs, workspace mirroring (present/absent task, unwritable path), `design_brand_kit_save` create/reject/unknown-id/non-string-id/logo-ref filtering |
| `src/server/__tests__/designStudioRoutes.test.ts` (new, 7 tests) | `http.ts` mount guard, out-of-scope decline, templates, brand-kit CRUD, invalid + oversized body, generate + raster serving, empty-brief 400 / unknown-id 404 |

Run:

```bash
node --import tsx --test src/tools/__tests__/designStudio.test.ts \
  src/server/__tests__/designStudioRoutes.test.ts \
  src/server/__tests__/designStudio.test.ts
```

No `package.json` script was added (a per-file `test:<name>` target risks a
merge conflict with the parallel worktrees that also touch `package.json`).

## Gates

- `npx tsc --noEmit` (root): 0 errors.
- `npm run build:server`: exit 0.
- `cd packages/web && npx tsc --noEmit`: 0 errors. No web test files touched, so
  `vitest run` was not applicable.
- `npm run check:encoding`: 5 pre-existing issues, none in the files touched
  (`src/server/http.ts` mojibake and 4 BOMs predate this change).

## Known remaining gaps (not fixed here — out of scope)

- `/app/design` has no sidebar/nav entry, so it is only reachable by URL.
- The design page calls `t('…')` with literals that exist in neither
  `en.json` nor `ar.json`; keys fall back to English. No new UI strings were
  added by this change, so no i18n edits were required.
- No in-repo image model exists, so the injected `imageGen` path is still
  unwired in `index.ts`; the builtin SVG→PNG path is the live generator.
