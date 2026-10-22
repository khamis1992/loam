# uo13 — Live computer screen (VNC) + browser view in "Loam's computer"

## Summary

Implemented the UNIMPLEMENTED_OPTIONS #13 live screen/browser view. The backend already had the two pieces of streaming infra we needed — `src/screen/live.ts` (ScreenLive: interval screen capture + SSE broadcasting) and `src/tools/browserFrames.ts` (per-task browser JPEG frames captured by the browser tool) — but no single consumer-facing live view. This task added:

- **Server stream endpoints** — new `src/server/routes/liveView.ts` (dispatched from `src/server/http.ts` with `{ screenLive: deps.screenLive }`):
  - `GET /api/live-view/status?taskId=` — feature-flag snapshot. `screen.available` is true only when both `deps.screenLive` exists and `cfg.screen.enabled` passes; `browser.available` reflects the (always-present) browser-frame hub plus the latest frame's URL/title. The client uses this to render the view or a graceful placeholder.
  - `GET /api/live-view/frame?taskId=&source=screen|browser` — single JSON snapshot of the latest frame (screen falls through to `available:false` when streaming is disabled/error-free null).
  - `GET /api/live-view/stream?taskId=&source=screen|screen|browser|both` — SSE stream merging both sources: pushes an immediate `status` event, the latest frames right away, then every live frame (`type:"frame"` with `source` discriminator), with 15 s keepalive and full unsubscribe on client close. Opening the stream auto-starts ScreenLive (at the configured fps) so the tab is useful immediately; it intentionally never auto-stops, so it never fights the agent's own `screen_stream_start/stop` tool lifecycle.
  - Supporting change: `resolveFrameKey()` exported from `src/tools/browserFrames.ts` (resolves the web-session-id → Loam-task-id alias used by HTTP callers).
- **Task right-panel component** — new `packages/web/src/components/computer/LiveView.tsx`:
  - Added as a **"Live" tab** in `ComputerPanel.tsx` (the "Loam's computer" task right panel), reusing the existing panel/tab chrome; the command/output tabs are untouched.
  - Source toggle chips (Live screen / Live browser), a pulsing connection dot with the latest frame timestamp, base64-JPEG `<img>` rendering, and a URL/title footer with "Open" for the browser source.
  - Consumes SSE via **fetch + ReadableStream** (so the `x-loam-local-token` header is sent), with automatic **fallback to 1 s polling** of `/api/live-view/frame` if the stream fails.
  - **Feature flag / graceful placeholders**: overall unavailable → full-screen "Live view unavailable" placeholder; screen streaming disabled → per-source placeholder explaining it; browser source that just has no frames yet → "Waiting for live frames…" spinner hint.
  - TaskPageClient now passes the derived real `taskId` into the panel (frames are keyed by Loam task id server-side; sessionUid remains the fallback key).
- **i18n**: new EN + AR keys in `packages/web/src/i18n/{en,ar}.json` (Live tab labels, placeholders, connection status).
- **Tests**: new `src/server/__tests__/liveViewRoutes.test.ts` (node:test, 6 cases): feature flag on/off, screen frame endpoint with/without ScreenLive, browser frame publish→serve, SSE status+frame push, and non-matching path pass-through.

Relate to scope: a real VNC protocol (RFB) was not built — the shipping infra captures JPEG frames (screen via the Windows capture script at the configured fps, browser via Playwright screenshots after each navigation/action). That is what "live view" renders here; swapping in a true VNC/WebRTC transport later only needs `/api/live-view/stream`'s frame producer to change, not the panel.

## Verification

- `npx tsc --noEmit` → 0 errors (root).
- `npx tsc --noEmit -p packages/web/tsconfig.json` → 0 errors (web).
- `npx tsx --test src/server/__tests__/liveViewRoutes.test.ts` → 6/6 pass.
- `packages/web` vitest suite (run with `packages/web` as cwd): 15 files / 69 tests pass, i18n incl.
- Protected files untouched: runtime.ts, companionGateway.ts, companionTeamTools.ts, serviceBridgeTools.ts, serviceGapTools.ts, stt_server.py, docs/companions-frontier-progress.md, docs/evidence/fair-comparison.json.

## Commits

- `32804d8` feat(server): live-view stream endpoints (status/frame/stream) on top of ScreenLive + browser frames (uo13)
- `8fa2ada` feat(web): Live tab in Loam's computer panel (uo13)
- `a026375` test(server): live-view route tests (uo13)
- `ecf8165` fix(web): neutral live frame alt text (uo13)

## Known limits / follow-ups

- Screen capture is Windows-only in this build (`captureScreen` throws elsewhere); the panel then shows the graceful placeholder with the last error surfaced in `/api/live-view/status`.
- Browser frames only exist after the browser tool acts (they are published on navigation/action), so an idle task shows the waiting placeholder.
- The stream tracks the task id passed by the client; web-session-id aliasing (`setTaskFrameAlias`) remains unpopulated in this build, so `resolveFrameKey` preserves it as a no-op fallback.
- The panel never stops a ScreenLive capture it started (deliberate, to avoid racing the agent's screen tools); a future refcounted start/stop could reclaim the idle capture.
