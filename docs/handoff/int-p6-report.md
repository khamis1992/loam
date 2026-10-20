# int-p6 Handoff Report

## Summary
Added an **"Open in studio"** right-panel tab to the existing `ComputerPanel` in `packages/web/src/components/computer/ComputerPanel.tsx`. The new tab appears only when the current event's tool indicates a legacy studio mode (media / office / data) and renders the backend-served legacy studio page in an `<iframe>`. Existing Terminal/Editor/Browser/Preview/Files tabs are unchanged.

## Files Changed
- `packages/web/src/components/computer/ComputerPanel.tsx`

## Commits
```
int-p6: add Open in studio tab for legacy media/office studios
```

## What was implemented
1. **Studio URL constant**: `STUDIO_BASE_PATH = '/studios/index.html'` (top of file). Media uses `#creative`, write/data/office use `#office`.
2. **Mode inference** (`getStudioMode`): maps `creative_*`, `loam_creative`, `loam_canvas` → `media`; `office_*`, `loam_studio`, `loam_document`, `loam_dataset`, `data_chart` → `office`.
3. **Tab routing** (`getToolFamily`): studio tools now route to the new `studio` tab instead of the generic `files` tab.
4. **Conditional tab visibility**: a module-level `Map` remembers the inferred studio mode per `sessionId`, so the Studio tab stays visible after the first studio tool in a session.
5. **Studio content**: new `StudioContent` component that loads `${apiBase}${STUDIO_BASE_PATH}?taskId=<sessionId>#creative|#office` in a sandboxed iframe, with a small URL header and external-link button.

## Limitations / Assumptions
- The task's mode is not passed down from `TaskPageClient`, so mode is **derived from the current/observed tool name**. The Studio tab only appears once a studio-related tool has been seen for the session.
- The legacy studio URL is assumed to be the static backend route `/studios/index.html` with hash routing (`#creative` / `#office`). This file exists under `ui/studios/index.html`; if the intended real-time creative timeline route is different, only the `STUDIO_BASE_PATH` constant needs to change.

## Verification
- `npx tsc --noEmit -p .` → 0 errors
- `npm --prefix packages/web run build` → succeeded
