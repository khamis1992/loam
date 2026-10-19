# A2 handoff: shared contracts + client lib

## What was done

Implemented the shared protocol types and the web-side RPC / chat-socket clients
per BUILD_SPEC §7.1, §7.2, §6.10 and §8.1.

### Owned paths touched

- `packages/shared/**` (new)
- `packages/web/src/services/{rpc.ts,chatSocket.ts,chatSocket.test.ts}` (new)
- `packages/web/{package.json,tsconfig.json,vitest.config.ts}` (minimal scaffold so
  the owned service files can be type-checked and tested)
- `docs/handoff/a02-report.md` (this file)

No files outside these paths were modified.

### `packages/shared`

- `src/socket.ts`: every §7.2 type.
  - TaskMode, AgentStatus, ToolStatus (incl. observed `argumentsFinished` / `streaming`), ToolName.
  - Attachment / ServerAttachment shapes.
  - All 72 client → server message types listed in §7.2.3 plus the first nine MVP frames.
  - Server → client `ServerEnvelope`, every `ChatEvent` variant (chat, chatDelta,
    statusUpdate, queueStatusChange, planUpdate, newPlanStep, liveStatus, toolUsed,
    userStop, cascadeTaskClock, desktopSessionConfig, desktopDevicesUpdate,
    localPermissionModeChangeResult, eventsNotifyEventsAfter, explanation,
    folderAccessRequest).
  - §7.2.2 local-machine approval events (`workspaceDirectoryAccessRequest/Result`,
    `localExecutionApprovalRequested/Resolved`).
  - §7.2.4 tool-detail unions (`terminal`, `textEditor`, `search`, `webpageExtract`,
    `mcp`, `suggestion`) and related events (`computerActivity`, `resourceAccessed`,
    `deviceAttachmentUploadNotify`, `deviceWorkspaceGitStatus`).
  - `ServerMessage` union and `NotifierNotification`.
- `src/eventCategories.ts`: exact `EVENT_CATEGORIES` map from §7.2.1.
- `src/proto.ts`: TypeScript shapes for every MVP protobuf message in §7.1
  (`AgentSession`, session/project request/response types, auth types, file types,
  enums).
- `src/ipc.ts`: IPC channel constants (`desktop-ipc-api`, `desktop-ipc-event`,
  `desktop-sync-info`), namespace lists, and zod schemas for the MVP §8.3 handlers
  and events.
- `src/env.ts`: frozen endpoint config per §10.5, read through `desktopSync.env`
  with browser/dev fallbacks.
- `src/i18n/{en.json,ar.json,index.ts}`: complete en/ar catalogs from §5.8 plus the
  §6.5/§5.9 [DD] mode/effort labels, with `{product}` interpolation.

### `packages/web/src/services`

- `rpc.ts`: `RpcClient` class that posts to `{apiBase}/{package}.{Service}/{Method}`
  with the §8.1 headers (`Connect-Protocol-Version`, `x-client-*`, `Authorization`,
  locale/timezone), typed wrappers for every MVP RPC, and `RpcErrorClass` for
  Connect-style error bodies.
- `chatSocket.ts`: `ChatSocket` class using `socket.io-client`.
  - Websocket transport, bearer auth, locale/timezone/client metadata in the query.
  - Exponential reconnect 1 s → 10 s.
  - `join()` with `version: 2` and a dynamic `lastMessageId` getter used on reconnect.
  - `leave()`, `sendText()` matching the observed wire field set, and `stop()`.
  - `shortUid()` 22-char base62 generator.
- `chatSocket.test.ts`: Vitest unit tests covering:
  - server envelope delivery,
  - `join_session` v2 + replay,
  - re-join using the dynamic getter,
  - `stop_session`.

### Verification

Commands from AGENTS_PLAN pass:

```bash
cd packages/shared && npx tsc --noEmit
cd packages/web   && npx vitest run src/services
```

Both exit 0.

## What is left / requests for other agents

- **A3 (web shell)** owns the rest of `packages/web` (Next.js scaffold, Tailwind,
  tokens, components, store, layout). The minimal `package.json`/`tsconfig`/`vitest.config`
  added here is only enough for the service tests; A3 should replace/extend them
  with the full §2/§3/§4/§6 setup.
- **A6 (i18n)** owns `packages/web/src/i18n/**` and `useLocale.ts`. The shared
  package provides raw catalogs; A6 should wire them into the renderer's locale
  state and add the hard-coded-string lint.
- **A1/A7** may want generated protobuf-es code under `packages/shared/src/gen`;
  the hand-rolled `proto.ts` types are sufficient for the RPC client's type
  signatures but do not include runtime serialization.
- **A10** may extend `packages/shared/src/socket.ts` if additional server event
  fields are discovered during integration.

## Design decisions

- Package name `packages/shared` is published locally as `@agent-studio/shared`;
  the reference code's `@shared/*` imports were adapted to this scoped name so
  Node/npm resolution works without a workspace root.
- The shared package uses `with { type: 'json' }` JSON imports to satisfy
  `NodeNext` ESM requirements.
- The RPC client defaults to `env.apiBase` and accepts an async token getter;
  `generateTempAuthCode` takes the deep-link `loginToken` explicitly rather than
  using the session token getter.
- `ToolStatus` includes both the static set from §7.2 and the live
  `argumentsFinished`/`streaming` values from §7.2.4.
