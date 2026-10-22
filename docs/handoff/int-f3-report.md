# int-f3 Phase 6 Studio Iframe Routes — Report

## Commit

- `3b2de20` — `int-f3: point studio iframe at real backend UI pages`
- Files changed: `packages/web/src/components/computer/ComputerPanel.tsx`

## What changed

Updated `StudioContent` in `packages/web/src/components/computer/ComputerPanel.tsx` so the **Open in studio** tab now loads real backend UI pages instead of the legacy placeholder `/studios/index.html#<hash>` route.

- Replaced the legacy constant `STUDIO_BASE_PATH = '/studios/index.html'` with two explicit backend page paths:
  - `OFFICE_PREVIEW_PATH = '/office-preview.html'`
  - `CREATIVE_RENDER_PATH = '/creative-render.html'`
- `StudioContent` now builds the iframe `src` as:
  - **Media mode**: `{apiBase}/creative-render.html?taskId={sessionId}`
  - **Office / write / data mode**: `{apiBase}/office-preview.html?taskId={sessionId}`
- `apiBase` is the same value returned by `getApiBase()` and already used throughout the panel to build `/api/media`, `/api/preview`, and `/api/browser/state` URLs.

## Iframe URLs used

The exact URLs constructed by the component are:

```
{apiBase}/office-preview.html?taskId=<sessionId>
{apiBase}/creative-render.html?taskId=<sessionId>
```

where `<sessionId>` is URL-encoded via `encodeURIComponent`.

## Assumptions

- The backend static UI directory is served at web root `/`, so `office-preview.html` and `creative-render.html` are reachable at the root of the same origin that serves the `/api/*` endpoints.
- The `taskId` query parameter is appended consistently with how the panel already calls `/api/preview?taskId=...` and `/api/browser/state?taskId=...`. No additional token or hash parameters are added because the existing panel API calls do not pass one.
- `creative-render.html` is the correct creative entry page: the backend renderer (`src/creative/timeline.ts`) also navigates to `this.base + '/creative-render.html'`, and the file exists in `ui/creative-render.html` alongside `ui/creative.js` and `ui/creative-timeline.js`.

## Verification

- `npm --prefix packages/web run build` — **passed** (Next.js 16 / Turbopack static build completed with no errors).
- `npx tsc --noEmit -p .` — my change introduced **no new errors** in `packages/web/src/components/computer/**`. The root typecheck still reports pre-existing errors in `src/eval/export.ts` and `src/server/http.ts`, which are outside int-f3 ownership and were present before this change.

## Scope guard

No other tabs (Terminal, Editor, Browser, Preview, Files) were modified.
