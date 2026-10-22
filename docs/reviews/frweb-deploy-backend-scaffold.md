# FRONTIER review — `src/preview/deploy.ts` + `src/tools/backendScaffold.ts`

Scope: W1 (one-click deploy + export) and W2 (Supabase/DB/Stripe scaffolding) from
`docs/handoff/FRONTIER_GAP_PLAN.md`. Branch `mf/frweb`. Read-only review of the existing
modules, then targeted hardening. No rewrite; no protected files touched.

## Verdict

Both modules are honest about their limits (cloud targets are credential-reporting stubs;
generated code is offline with placeholder-only `.env.example`). The core invariants hold.
The review found one real durability bug, one history-loss collision, one path-confinement
bypass, and a set of untested edge cases. All are fixed and covered by new focused tests.

## Findings and fixes

### `src/preview/deploy.ts`

1. **Durability bug (fixed).** `createLocalDeployTarget.deploy` deleted the previous
   `distDir` *before* `writer.write(...)` completed. A failed/partial write destroyed the
   last good deploy. Now the copy is staged in `<distDir>.deploying` first and the old
   directory is removed only immediately before the atomic rename.
2. **History-loss collision (fixed).** `timestampSegment()` is millisecond precision, so
   two deploys/exports in the same millisecond produced identical paths and silently
   overwrote each other — contradicting the "history is preserved" contract. Added
   `withCollisionSuffix()` and used it for both the dist dir (`uniqueLocalDistDir`) and
   archives (`uniqueArchivePath`).
3. **Inflated root file count (fixed).** The root-`index.html` fallback counted
   `.loam/exports/*.zip` staging archives as build files. `countFiles` now skips a root
   `.loam` directory for that fallback.
4. **Broken local URL (fixed).** Without a serve hook the URL always pointed at
   `<distDir>/index.html`; for a build with no `index.html` it pointed at a missing file.
   Falls back to the dist directory URL when `index.html` is absent.
5. **Untested helpers.** Added coverage for `missingCredentials` (unset *and* empty),
   `safeSegment`, `timestampSegment`, `targetCatalog`/`findTarget`, `describe()`, and
   `directDistWriter` symlink skipping.

### `src/tools/backendScaffold.ts`

6. **Over-broad traversal check (fixed).** `normalized.includes("..")` rejected legitimate
   names like `a..b`. Now only exact `..` path segments are refused.
7. **Symlink-escape bypass (fixed).** Lexical `path.resolve` checks cannot see a symlink
   inside the workspace that points outside it, so `projectDir = "evil/sub"` could smuggle
   writes out. Added `assertNoSymlinkEscape`, which realpaths the deepest existing ancestor
   and requires it to stay under the real workspace root. Guarded so a not-yet-existing
   workspace keeps its previous behavior.
8. **Untested `db` kind and direct API.** Added coverage for `filesFor("db")`, direct
   `scaffoldBackend` created/skipped reporting, invalid-kind rejection before any write,
   and empty `projectDir` resolving to the workspace root.

## Tests added

- `src/preview/__tests__/deployHarden.test.ts` — 14 tests.
- `src/tools/__tests__/backendScaffoldHarden.test.ts` — 8 tests.

Run with:

```
node --import tsx --test src/preview/__tests__/deploy.test.ts src/preview/__tests__/deployHarden.test.ts
node --import tsx --test src/tools/__tests__/backendScaffold.test.ts src/tools/__tests__/backendScaffoldDeep.test.ts src/tools/__tests__/backendScaffoldHarden.test.ts
```

No `package.json` script was added (avoids conflicting-edit risk); the commands above are
the canonical invocation.

## Gates

- `npx tsc --noEmit` — 0 errors.
- `npm run build:server` — exit 0.
- `packages/web` `npx tsc --noEmit` — 0 errors; no web tests touched.
- Touched server/preview/tools suites: 52/52 pass.

## Out of scope / pre-existing

`npm run check:encoding` reports 5 pre-existing issues in files not touched by this task
(`src/server/approvalRules.ts`, `src/server/http.ts`,
`src/server/routes/workspaceSlides.ts`, `src/server/__tests__/workspaceSheet.test.ts`,
`src/server/__tests__/workspaceSlides.test.ts`). Left untouched; all files changed here are
UTF-8 without BOM.
