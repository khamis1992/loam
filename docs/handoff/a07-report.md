# A7 handoff report: approvals, permission modes, model/effort menus

## What was implemented

### Backend
- **`src/policy/permissionModes.ts`**
  - Defines `LocalPermissionMode` (`ask_for_approval`, `approve_for_me`, `full_access`).
  - Provides `reviewLocalAction()` that decides whether a local read/write/terminal/workspace action needs user approval based on the active mode and folder grants.
  - Maps the Manus-style **Max / 2.0 / Lite / Flex** model menu to concrete Loam run profiles (`mapAgentModeToLoam`).
  - Maps the **Medium / High / Extra / Ultra** effort panel to step/verify/reflection budgets (`effortBudgets`).
  - Builds `user_message.extData` with mode, effort and permission mode.

- **`src/protocol/approvals.ts`**
  - Defines spec events: `WorkspaceDirectoryAccessRequest/Result`, `LocalExecutionApprovalRequested/Resolved`, `ChangeLocalPermissionMode`, `LocalPermissionModeChangeResult`, `FolderAccessRequestEvent`.
  - Bridges Loam's existing `src/server/approvals.ts` so that a denied execution approval leaves the underlying record as `denied` and no side effect is produced.
  - Implements `submitWorkspaceDirectoryAccess`, `waitForWorkspaceDirectoryAccess`, `resolveLocalExecutionApproval`, `changeLocalPermissionMode`, and optimistic client-side resolution.

### Frontend
- **`packages/web/src/components/approval/`**
  - `ApprovalCard.tsx` — folder-access card per BUILD_SPEC §6.7.
  - `ExecutionApprovalCard.tsx` — command/file/workspace execution approval per §7.2.2 / §5.9 S19.
  - `PermissionMenu.tsx` — composer chip menu for the three permission modes per §5.9 S17.

- **`packages/web/src/components/model-menu/`**
  - `ModelMenu.tsx` — Max / 2.0 / Lite / Flex switcher per §5.9 S15.
  - `EffortPanel.tsx` — Medium / High / Extra / Ultra segmented control per §5.9 S16.

Components accept a typed `t` prop and use the exact strings from BUILD_SPEC §5.8 / §5.9 so they can be wired to A6's i18n layer without string changes.

## Verification

Run:

```bash
# Targeted typecheck for A7-owned modules
npx tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2023 --lib ES2023 --strict --skipLibCheck --types node --esModuleInterop --resolveJsonModule src/policy/permissionModes.ts src/protocol/approvals.ts src/server/approvals.ts

# Unit + mini e2e assertions
npx tsx docs/handoff/a07-tests.ts
```

Both commands pass in this worktree.

## Notes / what's left

- The full repo `npm run typecheck` still fails on a pre-existing missing dependency (`@xmldom/xmldom` in `src/studio/ooxml.ts`). This is unrelated to A7 and outside the owned paths.
- The frontend components are authored against the BUILD_SPEC design but will only be fully type-checked once A2/A3's `packages/web` shell, Tailwind config, and `@shared` types are available. No changes were made to other agents' paths.
- Integration with A1's protocol adapter is documented in `docs/handoff/a07-requests.md`.

## Commit

Final commit: `[a07] report and handoff notes`.
