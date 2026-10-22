# int-p1 Phase 1 Report: Mode Routing

Owner: `int-p1`  
Scope: `src/protocol/**`, `src/modes/**`

## Summary
Implemented offline, synchronous mode routing for protocol socket messages. Replaced the old `mapTaskModeToLoam` mapping with `resolveLoamMode(um, prompt)`, which honors an explicit `extData.loamMode`, falls back to fast keyword detection, and preserves `lite`/`discuss` as `ask`. Added a new `security` mode to the catalog, enriched `research` and `build` with browser tools, and began emitting resolved-mode events to the chat stream.

## Files Changed

- `src/modes/detect.ts` (new)
  - `detectModeFromText(text)`: ordered keyword rules from int-p1 spec.
  - `resolveLoamMode(um, prompt)`: precedence (1) `um.extData.loamMode` if valid via `normalizeModeId`, (2) keyword detection, (3) `lite`/`discuss` → `ask`, else `build`.
  - `modeEventInfo(mode)`: returns label/labelAr/reason for chat events.
- `src/protocol/socket.ts`
  - Removed `mapTaskModeToLoam`.
  - Imports `resolveLoamMode`/`modeEventInfo`.
  - Emits a `mode` AgentEvent carrying the resolved mode before calling `runTask`.
  - `runTask` now uses `mode: resolvedMode` and forwards `agentId`/`workMode`.
- `src/protocol/types.ts`
  - Added `loamMode`, `agentId`, `workMode` to `UserMessage.extData`.
  - Added `ModeEvent` to the `ChatEvent` union so the UI can receive mode events.
- `src/protocol/events.ts`
  - Mapped AgentEvent `mode` to ChatEvent `mode` (previously it was dropped as state-only).
- `src/modes/catalog.ts`
  - Added `security` mode with tools: `pentest_check`, `pentest_routes`, `pentest_report`, `security_assess`, `security_status`, `shell_run`, and file-read tools.
  - Added `...BROWSER` tools and `"browser"` panel to `research`.
  - Added `...BROWSER` tools and `"browser"` panel to `build`.
- `src/protocol/__tests__/resolve-mode.ts` (new)
  - Standalone unit tests covering keyword detection, explicit `loamMode`, aliases, invalid fallbacks, and `lite`/`discuss` preservation.

## Gaps / Follow-ups

- `RunTaskOptions.agentId` in `src/server/http.ts` is typed as `?: string` (not `string | null`). To keep `npx tsc --noEmit -p .` clean, the socket forwards `agentId: um.extData.agentId ?? undefined` instead of `?? null`. `workMode` is forwarded as `?? undefined` as requested.
- `packages/shared/src/socket.ts` still mirrors the old `ChatEvent` union without `ModeEvent` and the old `UserMessage.extData` shape. The server-side protocol type was updated, but the shared package and web UI types were intentionally left untouched because they are outside `int-p1` ownership. The UI will receive the new event at runtime; rendering support is a follow-up for the web owner.
- `detectFrontierMode` in `src/tools/frontierBridge.ts` is `async`/model-free regex-only, so it was not used; the new `detectModeFromText` is fully synchronous and offline.

## Verification

```powershell
npx tsc --noEmit -p .
# 0 errors

npx tsx src/protocol/__tests__/resolve-mode.ts
# PASS resolve-mode unit tests

npx tsx src/protocol/__tests__/run.ts
# PASS protocol adapter integration tests

npm run check:modes
# PASS: seven distinct fail-closed modes, denied execution, native document/data/canvas outputs, realpath/junction isolation
```

Web build was not run because no `packages/web` or `packages/shared` files were modified by `int-p1`.

## Commit

```bash
git add src/modes/detect.ts src/modes/catalog.ts src/protocol/events.ts src/protocol/socket.ts src/protocol/types.ts src/protocol/__tests__/resolve-mode.ts docs/handoff/int-p1-report.md
git commit -m "int-p1: offline mode routing, security mode, browser tool enrichment, mode chat events"
```
