# int-p4 Report — Phase 4 Deliverables + Library/Creations Indexing

**Agent:** int-p4  
**Branch:** `manus-parity`  
**Date:** 2026-10-20

## Summary

Phase 4 delivered: (1) adapter-side emission of `attachment` chat events for files produced during a run, plus a terminal "run complete" marker; (2) shared type sync for `attachment` and `mode` events and `UserMessage.extData` fields; (3) a new `AttachmentCard` component and task-page attachment rendering; (4) Library page indexing of docs/slides/sheets; (5) Creations page indexing of media (video/image/svg). All verification passed.

## Files changed (owned by int-p4)

| File | Change |
|------|--------|
| `src/protocol/types.ts` | Added `AttachmentEvent` interface and included it in the `ChatEvent` union. `ModeEvent` already present from int-p1. |
| `src/protocol/socket.ts` | Added workspace snapshot helpers (`snapshotWorkspaceFiles`, `mimeFromExt`, `isTerminalToolName`). After staging uploads, snapshots the task workspace; after `runTask` completes, diffs before/after and emits one `attachment` event per new file. Emits a terminal `toolUsed` "Run complete" marker if no terminal tool was used. Kept `resolveLoamMode`/mode logic intact. |
| `packages/shared/src/socket.ts` | Synced `UserMessage.extData` with `loamMode`, `agentId`, `workMode`. Added `ModeEvent` and `AttachmentEvent` interfaces and added both to the `ChatEvent` union. |
| `packages/web/src/components/chat/AttachmentCard.tsx` | **New file.** Renders a file card with kind-specific icon (doc/slide/sheet/video/image/svg/file), name, size, and an Open button that links to `/api/media?taskId=&path=`. |
| `packages/web/src/components/chat/EventList.tsx` | Added non-structural rendering hooks for `mode` and `attachment` events. |
| `packages/web/src/app/app/[sessionUid]/TaskPageClient.tsx` | In the answer/completed area, renders `AttachmentCard`s for each `attachment` event. Added a "View all files in this task" button (FileChartColumn icon) that opens an overlay listing all files in the task workspace via `/api/files`. |
| `packages/web/src/app/app/library/page.tsx` | Indexes task outputs by querying `/api/tasks?limit=50` then `/api/files?taskId=&path=&max=200` per task. Filters to doc/slide/sheet extensions and renders an Open link per file via `/api/media`. |
| `packages/web/src/app/app/creations/page.tsx` | Indexes task outputs by querying `/api/tasks` and `/api/files` per task. Filters to video/image/svg extensions, renders a grid with thumbnails for images/SVG and icons for video, links to `/api/media`. |
| `packages/web/src/i18n/en.json` | Added localization keys: `Document`, `Spreadsheet`, `Slide`, `Image`, `File`, `View all files in this task`, `Files in this task`, `No files found in this task.`. |
| `packages/web/src/i18n/ar.json` | Added matching Arabic translations for the new keys. |

## Verification

```powershell
npx tsc --noEmit -p .
# exit 0

npm --prefix packages/web run build
# Static + SSG generation succeeded

npx tsx src/protocol/__tests__/run.ts
# PASS protocol adapter integration tests

npx tsx src/protocol/__tests__/resolve-mode.ts
# PASS resolve-mode unit tests

npm --prefix packages/web run test -- src/i18n/t.test.ts
# 9 tests passed (catalog keys remain in sync)
```

## Notes / limitations

- **No server endpoint edits:** `src/server/http.ts` was not modified. Library/Creations pages use the existing `/api/tasks` and `/api/files` endpoints (proxied through the protocol adapter), plus `/api/media` for opening files.
- **Backend listing gap:** There is no single backend endpoint that lists produced files across all tasks. The UI therefore scans the last 50 tasks and their workspaces. This is noted here as a deliberate trade-off to avoid editing `src/server/http.ts`.
- **Attachment source:** Attachment events are emitted only for files that appear in the task workspace between the post-upload snapshot and run completion. User uploads staged to `attachments/` are part of the snapshot baseline and are not re-emitted as produced files.
- **Terminal marker:** The marker is emitted only when the run produced no `terminal`-mapped tool rows, preventing the timeline from ending without a visible completion cue.
- **Other tools' edits untouched:** Files such as `src/server/http.ts`, `src/server/companionGateway.ts`, `src/setup/runtime.ts`, `src/tools/companionTeamTools.ts`, `scripts/stt_server.py`, and `src/scripts/check-*.ts` were left untouched per ownership rules.

## Commits

All owned files are staged together under a single commit:

```bash
git add packages/shared/src/socket.ts src/protocol/socket.ts src/protocol/types.ts packages/web/src/components/chat/AttachmentCard.tsx packages/web/src/components/chat/EventList.tsx packages/web/src/app/app/[sessionUid]/TaskPageClient.tsx packages/web/src/app/app/library/page.tsx packages/web/src/app/app/creations/page.tsx packages/web/src/i18n/en.json packages/web/src/i18n/ar.json
git commit -m "int-p4: attachment events, shared types, AttachmentCard, Library/Creations indexing" -- packages/shared/src/socket.ts src/protocol/socket.ts src/protocol/types.ts packages/web/src/components/chat/AttachmentCard.tsx packages/web/src/components/chat/EventList.tsx packages/web/src/app/app/[sessionUid]/TaskPageClient.tsx packages/web/src/app/app/library/page.tsx packages/web/src/app/app/creations/page.tsx packages/web/src/i18n/en.json packages/web/src/i18n/ar.json
```
