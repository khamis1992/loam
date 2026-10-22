# A8 Handoff Report — Uploads + Offline/Reconnect

**Agent:** A8 (uploads + offline/reconnect)  
**Branch:** `mp/a08-upload-offline`  
**Date:** 2026-10-19

## Owned paths touched

- `src/upload/**` — new server-side 3-step upload module and `deviceAttachmentUploadNotify` event bus.
- `packages/web/src/services/upload.ts` — client upload service.
- `packages/web/src/hooks/useOnline.ts` — network state hook with 10 s grace.
- `packages/web/src/components/offline/OfflineBanner.tsx` — non-blocking offline toast.
- Tests for all of the above.
- Minimal `packages/web` scaffold (`package.json`, `tsconfig.json`, `vitest.config.ts`, `vitest.setup.ts`).

No other agent paths, `main`, secrets, `config.json`, `.env*`, `output/`, or `data/` were touched.

## What was implemented

### Server upload (`src/upload`)

Implements the §8.1 3-step contract against local storage:

1. `POST /api/chat/getPresignedUploadUrl` — reserves a blob id and returns a local PUT URL.
2. `PUT /blob/:id` — stores raw bytes.
3. `POST /api/chat/uploadComplete` — validates size and returns the public file URL.
4. `GET /blob/:id` — downloads the stored file.

- Bytes are kept on disk in a configurable directory (defaults to an OS temp dir; tests use a temp dir that is cleaned up).
- `emitDeviceAttachmentUpload` / `onDeviceAttachmentUpload` provide the `deviceAttachmentUploadNotify` event channel required by §7.2.4.
- `createUploadServer(config)` spins up a standalone HTTP server; `createUploadRoutes(config)` can be used by another agent to mount the routes onto an existing server.

### Client upload service (`packages/web/src/services/upload.ts`)

- `getPresignedUploadUrl`, `putFile`, `uploadComplete`, `uploadFile`.
- `uploadFile(apiBase, file)` orchestrates the full flow and returns an `Attachment` matching the §7.2 shape (`id: "temp-<id>"`, `fileMetaData: { tag: "upload", uploadStatus: "success", uploadProgress: 100 }`).

### Offline state (`useOnline` + `OfflineBanner`)

- `useOnline(graceMs = 10_000)`:
  - Tracks `navigator.onLine` via window `online`/`offline` events.
  - `showBanner` becomes `true` only after the full grace period has elapsed while offline (§5.9 S20).
  - On recovery, `showBanner` hides immediately and `wasOffline` is set.
  - `retry()` re-dispatches connectivity events so the socket layer can trigger an immediate reconnect/replay.
- `OfflineBanner` renders the §5.9 S20 toast string in English and Arabic and is dismissible.

## Acceptance criteria

| Criterion | Status |
|---|---|
| Attachment round-trip test passes | ✅ `src/upload/__tests__/run.ts` |
| Simulated offline shows the banner after 10 s and recovers | ✅ `useOnline.test.ts` |
| Client upload returns spec-shaped `Attachment` | ✅ `upload.test.ts` |
| Offline banner renders EN/AR strings | ✅ `OfflineBanner.test.tsx` |
| TypeScript compiles | ✅ `npx tsc --noEmit` in `packages/web` |

## Verification commands

Run from the worktree root:

```bash
# Server upload round-trip
npx tsx src/upload/__tests__/run.ts

# Web unit tests
cd packages/web
npx vitest run
npx tsc --noEmit
```

All commands exit 0 on this branch.

## Requests to other agents

- **A1 / A5 (protocol/mock server):** mount the upload routes via `createUploadRoutes` on the main HTTP server so the `/api/chat/*` and `/blob/*` paths are reachable under the same origin as Connect RPC and socket.io. The exported `RouteHandlers` give direct control of each verb if you prefer to wire them manually.
- **A2 / A3 (chat socket / composer):** consume `useOnline()` in the Composer to disable Send while offline, and render `<OfflineBanner />` in the root layout. When `online` returns to `true`, the chat socket should re-emit `join_session` with the latest `lastMessageId` to perform the §9.3 replay.
- **A6 (i18n):** if a global catalog is introduced, the offline toast strings should move there; until then they are localized inside the component.

## What's left

- Real integration with the Loam HTTP server (`src/server/http.ts`) and the new web shell Composer is out of A8's ownership; see requests above.
- The server module currently stores files locally; swapping to an S3-compatible backend is a future backend concern and can be done inside `FileStore` without changing the wire contract.

## Commits

- `85dbc5c` — `[a08] server upload module: 3-step presign/PUT/complete + deviceAttachmentUploadNotify`
- `d802983` — `[a08] web upload service, useOnline grace hook, OfflineBanner + tests`
