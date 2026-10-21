# MF9 — Group chats between agents (handoff + Members tab)

Branch: `mf/mf9` (worktree `mf9`). No push.

## Commits

- `5a6dcc8` feat(groups): group chat store, mention routing, handoff collection and agent tool (MF9)
- `2ae354f` feat(web): Groups sidebar, group thread, composer and Members tab (MF9)

## Files

Server / tools

- `src/server/groupChats.ts` (new) — group tables, membership, messages, mention routing,
  task creation, reply collection/handoff chaining.
- `src/server/routes/groupChats.ts` (new) — HTTP handler.
- `src/tools/groupTools.ts` (new) — `handoff_to_agent` tool.
- `src/index.ts` — registers `createGroupTools()` (2 localized lines).
- `src/server/runTools.ts` — adds `handoff_to_agent` to `ALWAYS_ON_TOOLS`.
- `src/server/__tests__/groupChats.test.ts` (new) — routing/handoff/tool tests.
- `src/server/__tests__/runTools.test.ts` — registers group tools + asserts exposure.

Web

- `packages/web/src/components/agents/groupTypes.ts` (new)
- `packages/web/src/components/agents/GroupCreateDialog.tsx` (new)
- `packages/web/src/components/agents/GroupThreadView.tsx` (new)
- `packages/web/src/components/agents/GroupMembersTab.tsx` (new)
- `packages/web/src/components/agents/AgentInfoPane.tsx` (minimal group variant: Members tab)
- `packages/web/src/components/agents/AgentSidebarList.tsx` (Groups section + create)
- `packages/web/src/app/app/agents/AgentsPageClient.tsx` (group selection, dialogs, info pane)

`src/server/http.ts` was **not** modified.

## Supervisor: mount the routes in `src/server/http.ts`

Add the import near the other route imports (around the `handleScratchpadRoutes` import):

```ts
import { handleGroupChatsRoutes } from "./routes/groupChats.js";
```

Add the dispatch immediately before/after the existing `handleScratchpadRoutes` call (around line 1630):

```ts
if (await handleGroupChatsRoutes(req, res, p, { runTask })) return;
```

`{ runTask }` is required for group messages to start agent runs and to poll finished
replies; without `ctx.runTask` the transcript still records messages but no agent runs.

## Routes (exact shapes)

Base path `/api/groups`.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/groups` | — | `{ groups: GroupWithMembers[] }` |
| POST | `/api/groups` | `{ name, memberIds? }` | `{ group: GroupWithMembers }` |
| GET | `/api/groups/:id` | — | `{ group: GroupWithMembers, messages: GroupMessage[] }` |
| POST | `/api/groups/:id/members` | `{ agentId }` | `{ group: GroupWithMembers }` |
| DELETE | `/api/groups/:id/members/:agentId` | — | `{ group: GroupWithMembers }` |
| GET | `/api/groups/:id/messages` | — | `{ group, messages }` |
| POST | `/api/groups/:id/messages` | `{ text, author? }` (`author` defaults `"user"`) | `{ message, targetAgentId, taskId, messages }` |

`GroupWithMembers` = `{ id, name, createdAt, memberIds, members: { id, name, emoji }[] }`.
`GroupMessage` = `{ id, groupId, author, text, createdAt, handoffTo, handoffNote }`;
`author` is `"user"` or an agent id.

GET list/messages also polls finished group tasks and may start a handoff target's task.

## Agent tool

`handoff_to_agent { agentName: string, note?: string }`

- Always registered and in `ALWAYS_ON_TOOLS`, so every run sees it.
- Refuses outside a task started from a group (`ok: false`, explanatory text).
- Resolves `agentName` against group member ids/names; non-members are rejected.
- Records the target + note on the task; when the task finishes, the next agent gets
  a new task whose prompt contains the group transcript and the handoff note.

## Storage

Idempotent SQLite tables created from `groupChats.ts`:

- `group_chats(id, name, created_at)`
- `group_members(group_id, agent_id)` (PK group_id+agent_id)
- `group_messages(id, group_id, author, text, created_at, handoff_to, handoff_note)`
- `group_tasks(task_id, group_id, agent_id, handoff_to, handoff_note, created_at)` (reply/handoff tracking)

## Tests

```
npx tsc --noEmit
npx tsc --noEmit -p packages/web/tsconfig.json
npx tsx --test src/server/__tests__/*.test.ts
npm run check:encoding
```

Results: server tsc 0 errors, web tsc 0 errors, 34/34 tests pass, encoding OK.
`npm run build` in `packages/web` fails with the known worktree Turbopack
`Could not find the Next.js package (next/package.json)` junction error (pre-existing).

## How to test live

1. Mount the two http.ts lines above and start Loam (`npm run dev` / desktop).
2. Open Agents → Groups → `+`; name the group and pick at least two agents.
3. Send `@AgentName investigate X` (mention routes there; no mention routes to the first member).
4. The addressed agent runs a normal Loam task; its reply appears in the group thread.
5. When it calls `handoff_to_agent`, the reply shows a handoff chip and the next member's
   task starts automatically with the transcript context.

## What's left / notes

- Group deletion is not exposed (not requested).
- Reply collection is poll-driven (UI polls every 4s; GET endpoints also poll). No
  background timer was added to `index.ts`.
- UI strings rely on the existing `t()` English fallback; no i18n JSON entries were added
  to keep the shared catalog merge small.
