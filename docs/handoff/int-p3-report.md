# int-p3 Handoff Report — Manus-style Right Panel

**Branch:** `manus-parity`  
**Commit:** `991ee88 int-p3: Manus-style right panel (auto-open, tabs, humanized tools, spinner/duration fixes)`  
**Owned files changed:**
- `packages/web/src/app/app/[sessionUid]/TaskPageClient.tsx`
- `packages/web/src/components/computer/ComputerPanel.tsx`
- `packages/web/src/components/chat/EventList.tsx`
- `packages/web/src/components/chat/ToolUsedRow.tsx`
- `packages/web/src/components/chat/toolLabels.ts` (new)

## What was implemented

### 1. Auto-open right panel on first tool activity
In `TaskPageClient.tsx`:
- Added `autoOpenedRef` (per-session set) so the panel opens automatically **once** on the first `toolUsed` event and does not keep re-opening if the user closes it.
- The existing manual click path via `onOpenComputer` is preserved.

> **Note for int-p1 (protocol owner):** The task mentioned `tool/computerActivity` events. No `computerActivity` event exists in `packages/shared/src/socket.ts` or `src/protocol/types.ts` yet. If a dedicated `computerActivity` event is added, the auto-open effect at `TaskPageClient.tsx` should also listen for that event type.

### 2. 40px tab strip in `ComputerPanel.tsx`
- Added a 40px tab strip with tabs: **Terminal, Editor, Browser, Preview, Files**.
- Active tab is derived from the selected tool's family (`getToolFamily`).
- Panel width is now `w-[520px]` per S18.
- Header shows **"Loam's computer"** with expand (`Maximize2`) and close (`X`) icons.

### 3. Tab contents
- **Terminal:** dark monospace panel, shows `$ <command>` and streamed output via `desktopEvents.terminal`.
- **Editor:** shows file path + extension chip + content; if `oldContent`/`find` is present, shows a simple line diff (removed in red, added in green).
- **Browser:** address bar with URL (from event or `/api/browser/state?taskId=<sessionId>`), 4px blue activity rule under it, and screenshot/state fallback. Screenshot path is parsed from tool result text and rendered via `/api/media`.
- **Preview:** fetches `/api/preview?taskId=<sessionId>` and renders the URL in an `<iframe>`.
- **Files:** search/webpage results fallback, plus a file viewer that renders images/SVG inline and others as download/open links via `/api/media`.

### 4. Fixed stuck spinners
In `EventList.tsx` `collapseEvents`:
- Fixed a stale-reference bug: merged tool frames now replace the object in the output array, so the final `success`/`error` status actually reaches the rendered row.
- Added explicit finalization when a `toolUsed` frame with a final status arrives.
- Extended the existing closed-clock fallback to also cover `streaming`/`pending`.

### 5. Fixed duration bug (`Worked for 4683m20s`)
In `TaskPageClient.tsx`:
- New `computeClockDuration(clockEvent)` computes elapsed from `clock.startedAt` and the event timestamp (or `Date.now()` for open clocks) instead of blindly trusting `accumulatedMs`.
- Includes a fallback that guards against `accumulatedMs` values stored in seconds.

### 6. Humanized tool names + summary row
- New `toolLabels.ts` maps raw tool names (`file_stat`, `file_write`, `shell_run`, `web_fetch`, `browser_navigate`, etc.) to brief labels like **"Read file"**, **"Wrote file"**, **"Ran command"**, etc.
- `ToolUsedRow.tsx` now uses `humanizeToolName(e.tool)`.
- `EventList.tsx` renders a collapsed summary row like **"Read 2 files · Ran 1 command ›"** inserted just before the first tool row.

## Verification

```powershell
npx tsc --noEmit -p .
# exit=0

npm --prefix packages/web run build
# exit=0
```

Both checks pass.

## Notes / follow-ups
- `computerActivity` event: if int-p1 adds this event shape, the auto-open effect in `TaskPageClient.tsx` should be extended to handle it.
- Browser screenshot and Preview URL rely on parsing tool result text or fetching task-scoped APIs (`/api/browser/state`, `/api/preview`) using the URL `sessionUid` as `taskId`. If the protocol separates `sessionId` and `taskId` at runtime, these API calls may need a `taskId` prop passed down from the server.
- The expand icon in the panel header is currently a placeholder (no full-screen behavior wired).
