# MF4 + option #14 — Approval cards wired to the Loam permission gate

Branch: `mf/mf4` (worktree `mf4`). No push, no do-not-touch files modified, `src/server/http.ts` untouched.

## Commits (small, explicit paths)
- `b4ef3d8` feat(server): approval rules store, idempotent decision replay, per-task auto-approve state — `src/server/approvalRules.ts`
- `c50970f` feat(server): approval-rule routes module — `src/server/routes/approvalRules.ts`
- `c281fc0` feat(server): approval gate checks rules, per-task auto-approve and replay keys before prompting — `src/index.ts`
- `a3e3e2c` feat(protocol): wire approval resolution into the Loam gate; always-allow creates agent rules; approveForMe ext data — `src/protocol/types.ts`, `src/protocol/socket.ts`
- `69bdf3c` feat(web): tool approval card with Always-allow-for-agent wired to the approval resolution path — `ApprovalCard.tsx`, `EventList.tsx`, `chatSocket.ts`
- `a7f53fb` feat(web): Approve-for-me chip, agent rules list in info pane, i18n — `Composer.tsx`, `AgentThreadView.tsx`, `AgentInfoPane.tsx`, `i18n/{en,ar}.{json,ts}`
- `85dcf4e` test(server): approval rule precedence + replay idempotency — `src/server/__tests__/approvalRules.test.ts`

## What was built

### Server: `src/server/approvalRules.ts`
SQLite tables (idempotent `CREATE TABLE IF NOT EXISTS`):
- `approval_rules(id, agent_id, tool, pattern, decision, created_at)` — `agent_id IS NULL` = global rule; `pattern IS NULL` (or `*`) = any args; non-null pattern = case-insensitive substring match on the canonical (sorted-key) JSON of the args.
- `approval_decisions(key, decision, source, decided_at)` — idempotent replay store; `ON CONFLICT DO NOTHING` so the FIRST decision wins (a conflicting later save cannot change it). Keys: `taskId:toolCallId` when a call id exists, else `hash:sha256(taskId|tool|canonicalArgs)`. Sparse pruning keeps ≤2000 rows.
- `approval_task_modes(task_id, auto, updated_at)` — per-task "Approve for me" state.

Exports: `matchApprovalRule`, `listApprovalRules`, `createApprovalRule` (upsert by scope), `deleteApprovalRule`, `approvalStableKey`, `getReplayDecision`, `saveApprovalDecision`, `setTaskApprovalAuto`, `taskApprovalAuto`, `canonicalArgsJson`.

Rule precedence: agent-specific rules first (newest first), then global. Matched `allow` auto-approves, matched `deny` auto-refuses; unmatched falls through to the user prompt.

### Gate wiring — `src/index.ts` (localized edit)
The sensitive host-input wrapper (`computer_click/type/key/ui_click/ui_set_text`) now, per call:
1. computes the stable key, 2. checks replay (`getReplayDecision`) → same decision, no re-prompt, 3. per-task `Approve for me` (`taskApprovalAuto`), 4. saved rules (`matchApprovalRule`), 5. only otherwise creates the approval card event (`approval_required`) and waits. Every outcome is stored under the stable key (source `user` / `rule` / `auto`).

### Protocol (`src/protocol/*`)
- `types.ts`: `extData.approveForMe?: boolean`; `ResolveLocalExecutionApproval.resolution` accepts `"always"`.
- `socket.ts`: the `resolve_local_execution_approval` handler now **actually decides** the Loam approval record via `decideApproval` (previously it only echoed an event — that was the missing wiring). `"always"` additionally creates an allow rule scoped to the task's agent (global when the task has no agent). `user_message` applies `extData.approveForMe` to the per-task auto-approve state.

### Routes module: `src/server/routes/approvalRules.ts` (exports `handleApprovalRuleRoutes`)
- `GET /api/approval-rules?agentId=<id>` → `{ rules: ApprovalRule[] }` (agent's rules + global; omit agentId = all)
- `POST /api/approval-rules` `{ agentId?, tool, pattern?, decision: 'allow'|'deny' }` → `{ rule }` (upsert, 400 on validation error)
- `DELETE /api/approval-rules/:id` → `{ deleted: boolean }` (404 unknown)
- `GET /api/approval-tasks/:taskId` → `{ taskId, auto }` (404 unknown task)
- `PUT /api/approval-tasks/:taskId` `{ auto: boolean }` → `{ taskId, auto }`

**Supervisor must add exactly 2 lines to `src/server/http.ts`:**
```ts
import { handleApprovalRuleRoutes } from "./routes/approvalRules.js"; // with the other routes imports (~line 76)
if (await handleApprovalRuleRoutes(req, res, p, url)) return;         // next to handleScratchpadRoutes/handleSchedulesRoutes (~line 1631); `url` is in scope there
```
(The protocol adapter already proxies `/api/*` to Loam, so no adapter changes are needed.)

### UI (`packages/web`)
- `components/approval/ApprovalCard.tsx` rewritten: renders a Loam tool approval card (tool name, human summary, pretty-printed args preview fetched from `GET /api/approvals/:id`) with **Approve once / Always allow for this agent / Deny** wired to the existing `resolveLocalExecutionApproval` socket path (`always` → server creates the agent rule). Decided cards collapse to a "Decided" badge. The previous folder-access card is preserved as `FolderAccessApprovalCard` in the same file (EventList updated).
- `components/chat/Composer.tsx`: the inert "Approve for me" chip is now a toggle (`approveForMe` + `onToggleApproveForMe` optional props, backwards compatible).
- `components/agents/AgentThreadView.tsx`: chip state per agent (localStorage `loam.approveForMe.<agentId>`), toggle pushes `PUT /api/approval-tasks/<threadUid>` live for resolved threads and rides `approveForMe` on every message's `extData` so brand-new sessions are covered too.
- `components/agents/AgentInfoPane.tsx` Overview: new **Approval rules** section listing this agent's (+global) rules with decision badge, pattern, scope and remove (X → `DELETE /api/approval-rules/:id`).
- i18n: added keys to `en.json`/`ar.json` (and `.ts` mirrors): Approval request, Approval rules, Approve once, Always allow for this agent, Always allow, No approval rules yet., Decided, Tool, This agent, Global, Remove.

### Tests
`src/server/__tests__/approvalRules.test.ts` (node:test + tsx, 9 tests): rule precedence (agent before global, args patterns, `*`), upsert identity, deletion, validation, replay idempotency (same key returns the same decision; first decision wins), per-task auto toggle.

## Verification
- `npx tsc --noEmit` (root): 0 errors
- `npx tsc -p packages/web/tsconfig.json`: 0 errors
- `npm run build` in packages/web: fails with the **known** Turbopack `Could not find next/package.json` junction issue documented for worktrees → relied on web tsc per task note (all other branches hit the same).
- `npx tsx --test src/server/__tests__/*.test.ts`: 0 failures (incl. pre-existing suites); web vitest i18n suite passes.

## How to test live
1. Import + dispatch lines above into `src/server/http.ts`, then `npm run dev`.
2. Run an agent whose mode grants `computer_click` (user-device work mode); click **Approve once / Always allow for this agent / Deny** on the card in the agent thread — approve/deny resolves the gate, Always allow creates a rule visible in the agent info pane Overview → Approval rules (removable).
3. Retry the same tool call (same args, same task) — no new card appears; the previous decision replays.
4. Toggle the **Approve for me** composer chip — sensitive calls in this task stop prompting; toggle off to ask again.

## Left / notes
- The "Approve for me" chip inside the standalone task page (`app/[sessionUid]/TaskPageClient.tsx`) is still inert there (the shared `EventList` approval cards already work on that page; only the live PUT needs a sessionId→taskId mapping). Wired in the agents thread view, which is the chat surface named by row 14.
- `ExecutionApprovalCard` remains exported (unused by EventList now) for its richer terminal/file/workspace detail rendering; delete if unwanted.
- Decision replay is task-scoped by design; rules themselves persist globally/by-agent forever until removed.
