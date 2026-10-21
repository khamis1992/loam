# uo5 — Settings › In-App Browser (UNIMPLEMENTED_OPTIONS #5)

Replaced the "Coming soon" pane under Settings › In-App Browser with a real desktop
browser surface. Electron main owns a WebContentsView (new module `electron/inAppBrowser.cjs`,
sandboxed, `persist:loam-iab` session partition) that is attached/detached and positioned via the
new `inAppBrowser` desktop-ipc namespace (`attach/detach/setBounds/navigate/back/forward/reload/
stop/home/getState/clearData`), minimally wired in `electron/main.cjs` (one require, one handler
entry, one `init()` call), `electron/preload.cjs`, and `electron/ipc-constants.cjs`. The pane
(`packages/web/src/components/settings/InAppBrowserPane.tsx`) renders a DOM toolbar and anchors
the native view over a preview surface using measured rects pushed through the thin bridge
(`packages/web/src/lib/inAppBrowser.ts`, safe no-ops when the preload is absent, unit-tested in
`src/lib/inAppBrowser.test.ts`); it auto-attaches on tab open, re-anchors on resize/scroll,
detaches on unmount, blocks non-http(s) loads in the main process, and shows the agent browser
tool's shared settings (headless flag + homepage from GET /api/settings — the same values the
agent's Playwright browser reads, including the browser_open homepage fallback) as a read-only
section. Not done (follow-ups): POST /api/settings still rejects browserHomepage/browserHeadless
edits (http.ts not touched to stay in scope), palette of i18n keys falls back to English source
strings, and the agent's live page mirroring stays on the existing task-panel frame feed. Verified:
`npx tsc --noEmit` (root) = 0 errors, `npx tsc --noEmit -p packages/web/tsconfig.json` = 0 errors,
new vitest suite passes. Commits: 8cc96bf → add2d86 on mf/uo5.
