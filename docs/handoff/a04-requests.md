# A4 requests to other agents

## A2 — shared contracts + client lib

Please replace the minimal `packages/shared/src/socket.ts` with the full BUILD_SPEC §7.1/§7.2 type catalogue, implement the real `packages/web/src/services/chatSocket.ts` service per §6.10, and implement `packages/web/src/services/rpc.ts` per §8.1.

A4 currently uses these types:
- `TaskMode`, `AgentStatus`, `ToolStatus`, `ToolName`
- `Attachment`, `ServerAttachment`
- `JoinSession`, `LeaveSession`, `UserMessage`, `StopSession`, `ClientMessage`
- `ServerEnvelope`, `ChatEventBase`, `ChatMessageEvent`, `ChatDeltaEvent`, `StatusUpdateEvent`, `QueueStatusChangeEvent`, `PlanUpdateEvent`, `NewPlanStepEvent`, `LiveStatusEvent`, `ToolUsedEvent`, `UserStopEvent`, `CascadeTaskClockEvent`, `DesktopSessionConfigEvent`, `DesktopDevicesUpdateEvent`, `LocalPermissionModeChangeResultEvent`, `EventsNotifyEventsAfterEvent`, `ExplanationEvent`, `FolderAccessRequestEvent`, `ChatEvent`, `ServerMessage`

## A3 — web shell + design system

The following temporary scaffold files were created so A4 could build and verify. Please refine them to full spec quality:

- `packages/web/package.json` — dependencies/versions per BUILD_SPEC §2.
- `packages/web/tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`.
- `packages/web/src/styles/tokens.css` — copied verbatim from §4.1 except the invalid escaped attribute selector `[--ui-density-nav-icon-scale\:1\]` (currently commented out with a note).
- `packages/web/src/styles/globals.css`.
- `packages/web/src/store/*` — Redux slices for auth, sessions, websocket, chat, project, ui.
- `packages/web/src/components/ui/{Button,Dialog}.tsx`.
- `packages/web/src/components/shell/{Sidebar,TitleBar}.tsx`.

## A5 — settings / dialogs / activity indicator

No direct blockers from A4. A4's components import `Dialog` and `Button` from the temporary A3-owned files.

## A6 — i18n EN/AR + RTL

Please expand `packages/shared/src/i18n/{en,ar}.json` with the complete §5.8 catalogue and add the lint script that fails on hard-coded UI strings in `packages/web/src/components`. A4 currently adds only the keys its screens use.

Also provide the user-facing locale switcher (Settings > General > Language). A4 has wired reactive locale switching via `LocaleInit` in `packages/web/src/app/providers.tsx`; dispatching `setLocaleState('ar')` will re-render A4's screens in Arabic/RTL.

## A7 — approvals, permission modes, model/effort menus

Please replace the stub `packages/web/src/components/chat/ApprovalCard.tsx` with the full BUILD_SPEC §6.7 / §7.2.2 implementation. The stub is intentionally minimal so A4's `EventList` compiles and can render `folderAccessRequest` events.
