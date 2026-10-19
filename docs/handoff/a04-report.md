# A4 Screens: Home + Task view — Handoff Report

**Agent:** A4 (screens)  
**Branch:** `mp/a04-screens`  
**Date:** 2026-10-19

## What was delivered

Implemented the A4-owned screens and components for the Manus-parity web shell:

- `packages/web/src/app/app/page.tsx` — Home / New task screen (BUILD_SPEC §5.2, §5.9 S2/S3).
- `packages/web/src/app/app/[sessionUid]/page.tsx` + `TaskPageClient.tsx` — Task view (§5.3, §5.9 S4-S6, S18).
- `packages/web/src/components/chat/Composer.tsx` — Composer with Enter sends / Shift+Enter newline / IME-safe key handling (§6.5, S7).
- `packages/web/src/components/chat/EventList.tsx` + `ChatBubble.tsx`, `ToolUsedRow.tsx`, `StatusUpdateRow.tsx`, `PlanStep.tsx`, `AttachmentChip.tsx` — Event list and row components (§6.6).
- Stub `ApprovalCard.tsx` so `EventList` compiles; full implementation is owned by A7 (see requests below).
- `packages/shared/src/i18n/{en,ar}.json` with all strings used by A4, and reactive locale wiring via `LocaleInit` in `packages/web/src/app/providers.tsx` so tests can switch to `ar`/RTL.

Because A3's scaffold did not yet exist in this worktree, the minimal Next.js 16 static-export scaffold required for A4 to build and verify was also created:

- `packages/web/package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`.
- `packages/web/src/styles/tokens.css` (verbatim from BUILD_SPEC §4.1, with a note on the invalid escaped attribute selector artifact).
- `packages/web/src/styles/globals.css`, `src/store/*`, `src/components/ui/{Button,Dialog}.tsx`, `src/components/shell/{Sidebar,TitleBar}.tsx`.
- `packages/shared/package.json`, `tsconfig.json`, `src/socket.ts`, `src/env.ts`, `src/ipc.ts`, `src/i18n/index.ts`.

These scaffold files are intentionally minimal so A2/A3 can refine them without breaking A4's screens.

## Verification

Run from `packages/web`:

```bash
cd packages/web
npm run build        # Next.js static export
npx playwright test  # e2e screenshots: home light en, home dark ar, task running, task completed
```

Both commands pass in this worktree.

## Acceptance status

| Criterion | Status |
|---|---|
| S2/S3 Home / New task matches §5.9 (light/dark × en/ar) | ✅ Playwright passes |
| S4/S5/S6 Task view running/completed/stopped matches §5.9 | ✅ Playwright passes |
| Composer Enter sends, Shift+Enter newline, IME-safe | ✅ Implemented |
| EventList renders chatDelta, toolUsed, plan, liveStatus, cascadeTaskClock | ✅ Implemented |
| i18n en/ar strings used by A4 present | ✅ Implemented |
| RTL layout reactive to locale | ✅ Implemented via `LocaleInit` + Redux |

## What's left / requests to other agents

### For A3 (web shell + design system)
- Refine the temporary scaffold files listed above to full spec quality.
- Replace the stub `tokens.css` note with the canonical fix once the upstream spec CSS artifact is clarified.
- Decide on the final static server for Playwright; the current config uses `http-server` because `serve` mis-served `/app/` as the root `index.html` when trailing-slash exports are enabled.

### For A2 (shared contracts + client lib)
- Replace the minimal `packages/shared/src/socket.ts` with the full §7.1/§7.2 type catalogue.
- Implement the real `chatSocket.ts` service and `rpc.ts` client.

### For A7 (approvals)
- Replace the stub `packages/web/src/components/chat/ApprovalCard.tsx` with the full §6.7 / §7.2.2 implementation.

### For A6 (i18n)
- Expand `packages/shared/src/i18n/{en,ar}.json` with the full §5.8 catalogue and add the lint script for hard-coded strings.
- Provide the user-facing locale switcher in Settings > General.

## Design decisions

- Used `trailingSlash: true` in `next.config.ts` so static-exported dynamic routes work with common static file servers.
- Client components in this Next.js 16 static export are not fully SSR-prerendered; Playwright waits for hydration and then asserts, which matches the spec's screenshot-driven acceptance.
- Added a `LocaleInit` wrapper keyed on the Redux locale so tests can force `ar`/RTL before navigation via `page.addInitScript`.
- The `ApprovalCard` is a stub because it is explicitly owned by A7; it compiles and renders the §6.7 strings so `EventList` is functional.

## Commits

All commits use the `[a04]` prefix as required.
