# A3 handoff report: web shell + design system

## What was done

Scaffolded the full `packages/web` Next.js 16 static-export renderer and the shared design system required by BUILD_SPEC §2–§6.

### Project files owned by A3

- `packages/web/package.json` — pinned stack per §2: Next.js 16.3.3, React 19.2, Redux Toolkit 2.x, Tailwind 3.4.x, clsx, lucide-react.
- `packages/web/next.config.ts` — `output: 'export'`, `distDir: 'dist'`, `images.unoptimized`, `trailingSlash`, `turbopack.root: process.cwd()` to keep the build rooted in `packages/web` despite the parent lockfile.
- `packages/web/tailwind.config.ts` — copied verbatim from BUILD_SPEC §4.4 (colors, spacing, border-radius, font-size map).
- `packages/web/postcss.config.mjs` — Tailwind + autoprefixer.
- `packages/web/tsconfig.json` — Next.js App Router, path aliases `@/* → src/*`, `@shared/* → ../shared/src/*`.
- `packages/web/src/app/layout.tsx` — sets `<html lang="en" dir="ltr" class="light is-desktop" data-accent-color="default" data-interface-density="compact">` and wraps the app in `StoreProvider` + `DialogRegistryProvider`.
- `packages/web/src/app/page.tsx` — temporary shell demo page (to be replaced by A4's Home/Task workspace); renders `TitleBar` + `Sidebar` + placeholder content.
- `packages/web/src/styles/tokens.css` — all §4.1 colour/density/type tokens with exact hex values (verified by `npm run verify:tokens`).
- `packages/web/src/styles/globals.css` — font stacks (system + Noto Sans Arabic for `ar`, JetBrains Mono for mono), shadow utilities (`shadow-card`, `shadow-menu`, `shadow-layer`), semantic text utilities, density helpers.

### UI primitives

- `packages/web/src/components/ui/Button.tsx` — `Button`, `IconButton`, `Spinner` per §6.2 (variants primary/secondary/ghost/danger, sizes sm/md/lg).
- `packages/web/src/components/ui/Dialog.tsx` — modal dialog per §6.3 (portal, Escape, backdrop, `rounded-card`, `shadow-layer`).
- `packages/web/src/components/ui/DialogRegistry.tsx` — minimal central named-dialog registry context for the ~150 dialogs observed in the original; A5 can register actual dialog contents.

### Shell

- `packages/web/src/components/shell/TitleBar.tsx` — 48px drag region, macOS 80px left inset, left cluster (sidebar toggle, back/forward, search) in 28×28 hit boxes, right cluster Windows minimise/maximise/close buttons, background gradient matching `--background-nav` over the 240px sidebar and `--background-gray-main` over content (§5.9 S1).
- `packages/web/src/components/shell/Sidebar.tsx` — 240px width, `--background-nav`, 32px compact rows, primary nav items (New task, Computers, Agents + Cue! badge, Search, Library, Creations, Automations, Plugins, More), Projects + Tasks sections with date bucketing, footer user strip (§5.9 S2).
- `packages/web/src/components/shell/SidebarTaskItem.tsx` — task row with icon, title, running indicator.

### State

- `packages/web/src/store/index.tsx` — Redux Toolkit store factory + `StoreProvider` + typed `useAppSelector`/`useAppDispatch`.
- Slices per §3 file tree: `authSlice.ts`, `sessionsSlice.ts`, `websocketSlice.ts`, `chatSlice.ts`, `projectSlice.ts`, `uiSlice.ts`.

### Verification

- `npm run build` exits 0 and produces `packages/web/dist/index.html` + `_next/` static assets.
- `npm run verify:tokens` confirms 206/206 §4.1 hex values are present unchanged.

## What is left / requests for other agents

- **A2 shared contracts**: `@shared/socket`, `@shared/gen/session/v1/session_pb`, `@shared/env`, `packages/web/src/services/{rpc.ts,chatSocket.ts}` need real implementations. Current shell uses only local types; integration with real data requires these.
- **A4 screens**: replace `src/app/page.tsx` with the Home / New task workspace and create `src/app/app/**` for task view. The shell components (`TitleBar`, `Sidebar`, `Button`, `Dialog`) are ready to consume.
- **A5 settings/dialogs/login/activity-indicator**: create `src/app/login/**`, `src/app/desktop-activity-indicator/**`, `src/components/settings/**`, `src/components/dialogs/**`, `src/components/update/**`. Use `DialogRegistry` for named dialogs.
- **A6 i18n + RTL**: replace hard-coded English strings in shell components with `t()` from `src/i18n/t.ts` and wire locale/direction into `layout.tsx` (`lang`, `dir`, `:lang(ar)` font stack is already in globals.css).
- **A9 desktop integration**: inject `is-desktop` / platform class on `<html>`, provide `desktopSync` for `TitleBar` platform detection (Windows 40px title bar vs macOS 48px / traffic-light inset), and wire native window controls.

## Design decisions / spec gaps

1. `tokens.css` omitted the generated quirk `[--ui-density-nav-icon-scale\:1\]` because PostCSS/Tailwind cannot parse it. The default value is already declared in `:root`, so no visual change.
2. `TitleBar` height is 48px using `--ui-titlebar-height`. BUILD_SPEC §5.0 notes Windows uses 40px; this needs platform detection from `desktopSync` (A9) to apply the Windows override.
3. Font files (Noto Sans Arabic, JetBrains Mono) are referenced by family name only. A build-time `scripts/fetch-fonts.mjs` step (not owned by A3) is needed if self-hosting is required; otherwise the browser will use available fallbacks.
4. Root page (`/`) is a placeholder demo that renders the shell. A4 should replace it with the real Home view; `next.config.ts` can be updated with a redirect to `/app` once A4's route exists.

## How to verify

```powershell
cd packages/web
npm install --ignore-scripts
npm run build        # must exit 0 and produce dist/index.html
npm run verify:tokens # 206/206 hex values unchanged
```
