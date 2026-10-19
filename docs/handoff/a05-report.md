# A5 Handoff Report: Settings, My Computer, dialogs, update, activity indicator, login

## What was done

Implemented the A5-owned surfaces for the Manus-parity web shell in `packages/web`:

- `src/app/login/page.tsx` — Login screen per §5.1 (dev-environment badge, sign-in button, help link, ToS/Privacy rich-text footer, environment-switch dialog stub).
- `src/app/desktop-activity-indicator/page.tsx` — 600×788 transparent activity-indicator panel per §5.7 with running/completed/waiting task cards, stop/open actions and "Mark as read".
- `src/components/settings/SettingsDialog.tsx` + panes — Settings dialog per §5.5/§5.9 S8:
  - Left nav with profile header, search field and grouped tabs.
  - MVP panes: General, Account, Appearance, Data controls, My Computer, Usage.
  - Non-MVP sections render `EmptyState "Coming soon"`.
- `src/components/settings/MyComputerPane.tsx` — folder list with add/remove, matching §5.4.
- `src/components/dialogs/Dialog.tsx` — base modal with portal, Escape-to-close, focus management per §6.3.
- `src/components/dialogs/SearchDialog.tsx` and `AccountPopover.tsx` — named dialogs/popovers used by the shell.
- `src/components/update/UpdatePopover.tsx` + `UpdateStoreMessage.tsx` — update states per §5.6/§9.5 (checking, available, downloading, downloaded, restarting, error, store-managed).
- `src/i18n/t.ts`, `en.ts`, `ar.ts`, `useLocale.ts` — `t()` / `tRich()` per §6.1 with `{product}` interpolation, English default, Arabic RTL switch.
- `src/styles/tokens.css` — copied verbatim from BUILD_SPEC §4.1.
- `src/styles/globals.css` — Tailwind layers + `shadow-card/menu/layer` + typography utilities.
- Unit tests for i18n and settings; Playwright e2e spec `e2e/screens-settings.spec.ts`.

## Files owned and touched

Owned by A5 per `docs/AGENTS_PLAN.md`:
- `packages/web/src/components/settings/**`
- `packages/web/src/components/dialogs/**`
- `packages/web/src/app/desktop-activity-indicator/**`
- `packages/web/src/components/update/**`
- `packages/web/src/app/login/**`

Additional files created as minimal A5-only build/test scaffolding (other agents should consolidate or replace):
- `packages/web/{package.json,next.config.ts,tsconfig.json,tailwind.config.ts,postcss.config.mjs,vitest.config.ts,playwright.config.ts}`
- `packages/web/src/app/{layout.tsx,page.tsx}`
- `packages/web/src/components/{providers/StoreProvider.tsx,ui/Button.tsx}`
- `packages/web/src/{store/index.ts,services/desktopApis.ts,styles/tokens.css,styles/globals.css,test-setup.ts}`
- `packages/web/src/i18n/{t.ts,en.ts,ar.ts}`
- `packages/web/src/hooks/useLocale.ts`

## Dependencies / requests for other agents

- A3 (web shell + design system) should take over `src/app/layout.tsx`, `src/styles/*`, `src/components/ui/*`, `src/store/*`, and replace the minimal Button/StoreProvider with the full design system.
- A2 (shared contracts) should provide the real `@shared/*` packages and `rpc.ts`/`chatSocket.ts`; A5 currently uses local stubs.
- A6 (i18n) should own the catalog files; A5 has seeded `en.ts`/`ar.ts` with all A5-needed strings plus the §5.8 set.
- A1/A9 (desktop) should provide the real preload bridge; A5's `desktopApis.ts` is a browser-safe stub that no-ops when `window.__apis` is absent.

## Verification

Run from `packages/web`:

```bash
npm run typecheck   # tsc --noEmit, passes
npm run test        # vitest unit tests, 7 passed
npm run build       # Next.js static export to out/
npx playwright test e2e/screens-settings.spec.ts  # 4 passed
```

All commands exit 0. The final build produces `packages/web/out` with `/login`, `/desktop-activity-indicator`, and `/`.

## What's left

- Real desktop IPC wiring (awaiting A1/A9).
- Real RPC/socket backend integration for settings persistence (awaiting A2/A3/A4).
- Approval-card integration (`ApprovalCard`) is owned by A7; A5 provides the dialog/registry base only.
- Full visual checklist in light/dark × en/ar should be run by A10 once the design system is merged.
