# A3 requests to other agents

## A2 — shared contracts + client lib

Please implement the real versions of the following so A4/A5/A6 can integrate against them:

- `packages/shared/src/socket.ts` — `ChatEvent` union, `ServerEnvelope`, `ClientMessage` union, `TaskMode`, `AgentStatus`, `ToolStatus`, `ToolName`, `Attachment`, etc. per BUILD_SPEC §7.2.
- `packages/shared/src/gen/session/v1/session_pb.ts` — generated protobuf-es types for `AgentSession`, `ListSessionsRequest/Response`, `GetSessionRequest/Response`, etc. per §7.1.
- `packages/shared/src/env.ts` — `apiBase`, `socketBase`, `notifierBase` config per §10.5.
- `packages/web/src/services/rpc.ts` — Connect JSON RPC client for the MVP methods listed in §8.1.
- `packages/web/src/services/chatSocket.ts` — socket.io `message` channel service with join/replay, send, stop, leave per §6.10.

Once these exist, the shell can switch from local `AgentSession` type to the shared type.

## A4 — screens (Home + Task view)

- Replace `packages/web/src/app/page.tsx` with the real Home / New task view per §5.2 / §5.9 S3.
- Create `packages/web/src/app/app/**` for the task view per §5.3 / §5.9 S4–S7.
- Use the existing shell components: `TitleBar`, `Sidebar`, `Button`, `IconButton`, `Dialog`.
- Consume `sessionsSlice` for active session selection and `chatSlice` for streaming events.

## A5 — settings, login, activity indicator, dialogs, update

- `packages/web/src/app/login/page.tsx` — Login screen per §5.1.
- `packages/web/src/app/desktop-activity-indicator/page.tsx` — floating panel per §5.7.
- `packages/web/src/components/settings/**` — Settings dialog + panes per §5.5 / §5.9 S8.
- `packages/web/src/components/dialogs/**` — content for named dialogs; register them via `DialogRegistry` (`src/components/ui/DialogRegistry.tsx`).
- `packages/web/src/components/update/**` — update popover states per §5.6 / §9.5.

## A6 — i18n EN/AR + RTL

- `packages/web/src/i18n/t.ts` — `t()` and `tRich()` per §6.1.
- `packages/web/src/i18n/en.json` / `ar.json` — full §5.8 string tables (or generate via `scripts/extract-i18n.mjs`).
- `packages/web/src/hooks/useLocale.ts` — locale setter that updates `document.documentElement.lang` and `dir` without reload.
- Replace hard-coded English strings in shell components (`TitleBar`, `Sidebar`, `Button` aria-labels, etc.) with `t()` calls.

## A9 — desktop integration

- Inject platform class / attributes on `<html>` from the preload/main process so `TitleBar` can choose Windows 40px vs macOS 48px height and apply the correct traffic-light inset.
- Provide `window.desktopSync` with `platform`, `appVersion`, etc. per §6.9.
- Wire native window controls so the right-cluster buttons in `TitleBar` call the appropriate IPC handlers.
