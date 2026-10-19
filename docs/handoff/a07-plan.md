# A7 implementation plan

## Scope (per AGENTS_PLAN.md)
Owns:
- `packages/web/src/components/approval/**`
- `packages/web/src/components/model-menu/**`
- `src/policy/permissionModes.ts`
- `src/protocol/approvals.ts`

## Objectives
1. Implement the three local permission modes (`ask_for_approval`, `approve_for_me`, `full_access`) and the policy that decides when a local action needs user approval.
2. Bridge Loam's existing `src/server/approvals.ts` to the Manus-style protocol events:
   - `localExecutionApprovalRequested` / `localExecutionApprovalResolved`
   - `change_local_permission_mode` / `localPermissionModeChangeResult`
   - `submit_workspace_directory_access` / `workspaceDirectoryAccessRequest|Result`
3. Provide the client components:
   - `ApprovalCard` for folder-access requests (BUILD_SPEC §6.7)
   - `ExecutionApprovalCard` for command/file/workspace approvals (§7.2.2)
   - `PermissionMenu` for the composer chip (§5.9 S17)
   - `ModelMenu` and `EffortPanel` for model/effort selection (§5.9 S15/S16)
4. Map the Manus Max/2.0/Lite/Flex menu and Medium/High/Extra/Ultra effort panel to Loam's mode/model/step budgets.
5. Ensure a denied approval produces no side effect and all user-visible strings match BUILD_SPEC §5.8 / §5.9.

## Verification
- `npm run typecheck` (backend policy/protocol compile)
- `npx tsx docs/handoff/a07-tests.ts` (unit + mini e2e assertions)

## Non-goals / handoffs to other agents
- Do **not** modify `src/index.ts`, `src/server/http.ts`, or A1's protocol adapter; document the hook points in `a07-requests.md`.
- Do **not** create root `packages/web` package config (owned by A2/A3).
