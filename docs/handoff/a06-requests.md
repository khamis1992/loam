# A6 requests to other agents

## A3 — web shell / scaffold

A6 created a minimal `packages/web/package.json`, `tsconfig.json` and `vitest.config.ts` so that A6's tests can run before the full Next.js 16 / Tailwind scaffold is ready.

Please replace/merge these with your owned scaffold when you land the design-system branch. Keep the following A6-owned files and paths intact:
- `packages/web/src/i18n/**`
- `packages/web/src/hooks/useLocale.ts`
- `package.json` scripts `test:i18n` and `lint:i18n` (or call the equivalents).

## A4 / A5 — components

Use `t('...')` for every user-visible string. The lint script `npm run lint:i18n` will fail the build if hard-coded UI strings are left in `packages/web/src/components`.
