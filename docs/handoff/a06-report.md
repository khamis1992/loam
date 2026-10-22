# A6 i18n EN/AR + RTL — handoff report

## What was done

- Created `packages/web/src/i18n/` with:
  - `en.json` and `ar.json` containing every literal string from BUILD_SPEC §5.8 (login, sidebar, composer, task, my_computer, settings, updater, activity_indicator, presenter, screen_live, runtime_2_0_7) plus the §6.5 task-mode labels and a small set of tool-verb strings needed by §6.6.
  - `t.ts` implementing `t()`/`tRich()`, `setLocale()`, `getLocale()`, `isRtl()` and `PRODUCT = 'Agent Studio'`. `t()` replaces `{product}` with the product name and interpolates other `{var}` placeholders. `tRich()` renders `<tag>...</tag>` segments through a tags map.
  - `useLocale.ts` hook returning the current locale, a setter that flips `dir` immediately (no page reload), plus `dir`/`isRtl`/`product`.
  - `audit.mjs` + `lint.mjs`: a TypeScript-AST lint that fails when `.tsx` files under `packages/web/src/components` contain hard-coded translatable JSX text or untranslated attribute values.
  - `t.test.ts` with Vitest coverage for interpolation, tag rendering, catalog symmetry, locale-driven `dir`, the `useLocale` hook, and the lint checker.

- Created a minimal `packages/web` scaffold so the A6 verification commands can run before A3's full Next.js/Tailwind scaffold lands:
  - `package.json` with `test:i18n` / `lint:i18n` scripts and the runtime/test dependencies.
  - `tsconfig.json` and `vitest.config.ts` (jsdom + React optimizer + act setup).
  - These are placeholders; A3 should replace/merge them with the real Next.js 16 config.

## Verification

```powershell
cd packages/web
npm install --ignore-scripts
npx vitest run src/i18n
node src/i18n/lint.mjs
npx tsc --noEmit
```

All pass:
- Vitest: 9/9 tests green.
- Lint: reports no issues (components directory does not exist yet).
- TypeScript: `tsc --noEmit` exits 0.

## Acceptance status

| Criterion | Status |
|---|---|
| Every §5.8 key exists in both `en` and `ar` | ✅ tested |
| `{product}` resolves to `Agent Studio` | ✅ tested |
| `dir` is driven by locale (`en` → ltr, `ar` → rtl) with no reload | ✅ tested |
| `useLocale` exposes locale/direction and triggers re-render | ✅ tested |
| Lint script fails on hard-coded UI strings in `packages/web/src/components` | ✅ implemented & tested on fixtures |

## Notes / cross-agent requests

- A3 owns the full `packages/web/{package.json,next.config.*,tailwind.config.ts,tsconfig.json}` scaffold. The files committed here are the minimal subset required to run A6 tests and will likely need to be merged/replaced when A3 lands the design-system branch.
- A4/A5 components should import strings through `t()`; running `npm run lint:i18n` will flag any remaining hard-coded user-facing text once components exist.
