# A7 design notes

## Approval policy alternatives

Approach A: central policy function receives the action kind, path, declared flags, and the active permission mode; returns `{needsApproval, reason, reviewer}`.
- Pros: single source of truth, easy to unit-test, deterministic.
- Cons: must know enough about the action to classify it.

Approach B: each tool decides locally whether to call `createApproval`.
- Pros: tool-specific context is naturally available.
- Cons: logic scattered, harder to enforce consistency, duplicates the mode checks.

**Chosen: Approach A.** `src/policy/permissionModes.ts` exposes `reviewLocalAction(...)`. The protocol adapter (A1) or individual tool wrappers can call it before executing.

## Path containment
- Normalize with `path.resolve` and ensure the resolved path starts with one of the granted folder paths (after `realpath` where possible).
- Reject symlinks that escape the grant; the caller is responsible for `realpath` before invoking the policy.
- The policy supports a one-shot grant that is consumed after first use.

## Bridging Loam approvals
- Loam's `src/server/approvals.ts` stores records keyed by `id`, with status `pending | approved | denied | expired`.
- For `localExecutionApprovalRequested`, generate a spec-shaped event where `requestId` is the Loam approval id. The resolution frame `resolve_local_execution_approval` calls Loam `decideApproval(requestId, resolution)`. If denied, the caller returns a tool error and must not run the action.
- For workspace-directory access, maintain a separate in-memory pending map in `src/protocol/approvals.ts` because Loam approvals currently only cover sensitive host-input tools. This map uses the same timeout/abort pattern and emits `workspaceDirectoryAccessResult`.

## Model / effort mapping
- Manus UI menu labels: Max, 2.0, Lite, Flex. These are design-time strings; they map to Loam run parameters:
  - `max`  → mode `max` / model from settings / effort `ultra` / step budget high
  - `2.0`  → mode `standard` / default model / effort `high`
  - `lite` → mode `lite` / light model / effort `medium`
  - `flex` → mode `standard` with a user-supplied model id (BYOK)
- Effort panel labels Medium/High/Extra/Ultra map to step/verify/reflection budgets. Since BUILD_SPEC leaves exact numbers as a design decision, choose a clear linear scale and expose it as a function so A1/A5 can read it.

## Frontend components
- Components accept a typed `t` prop so they do not depend on the not-yet-existing global i18n layer owned by A6.
- Components are self-contained TSX files under `packages/web/src/components/approval/**` and `packages/web/src/components/model-menu/**`; they will integrate with A2/A3's shell when branches merge.
- Icons use `lucide-react` per BUILD_SPEC §6.2.
