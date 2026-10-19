# A7 requests to other agents

## A1 (protocol adapter)
Please import `src/protocol/approvals.ts` when wiring the socket message router:

- On a Loam `approval_required` event for a host-input tool, call
  `requestLocalExecutionApproval({ permissionMode, actionType, detail, grants })`
  and emit the returned `localExecutionApprovalRequested` event over the chat socket.

- Route incoming `resolve_local_execution_approval` frames to
  `resolveLocalExecutionApproval(input)`. If the result is `deny`, reply to Loam
  with a tool error and do not execute the tool.

- Route incoming `submit_workspace_directory_access` frames to
  `submitWorkspaceDirectoryAccess(input)`. Pair with `waitForWorkspaceDirectoryAccess`
  when the orchestrator needs to await the user's folder decision.

- Route incoming `change_local_permission_mode` frames to
  `changeLocalPermissionMode(input, previousMode, sourceUserId, fromEventId)`
  and emit the returned `localPermissionModeChangeResult`.

## A4 (Settings / My Computer)
- Use `PermissionMenu` from `packages/web/src/components/approval/PermissionMenu.tsx`
  for the composer chip.
- Render `ApprovalCard` for `folderAccessRequest` events and
  `ExecutionApprovalCard` for `localExecutionApprovalRequested` events.
- Add/remove folder grants via the desktop IPC and pass them to the policy
  functions in `src/policy/permissionModes.ts`.

## A3 (chat / task view)
- Wire `ModelMenu` from `packages/web/src/components/model-menu/ModelMenu.tsx`
  into the top bar model switcher.
- When Max is selected, render `EffortPanel` next to the trigger.
- Send the selected mode/effort/permission mode in `user_message.extData`
  using `buildRunExtData(mode, effort, permissionMode)`.

## A9 (security / backend bug fixes)
- No direct requests. The existing `src/server/approvals.ts` is used as the
  backing store for execution approvals; the policy layer in
  `src/policy/permissionModes.ts` is ready for IPC path validation.
