# MF10 Handoff — Shared Ticket Board (worktree `mf/mf10`)

## Commits (branch `mf/mf10`, never pushed)
1. `675e330` feat(board): shared ticket board domain + always-on agent ticket tools (MF10)
2. `b1aa1e3` feat(board): /api/board tickets routes (create/list/patch/comments/assign/release)
3. `55bde20` test(board): atomic claim, status transitions, tool exposure
4. `99daf2b` feat(web): kanban ticket board page with drawer, comments, assign (MF10)
5. `12f200d` feat(web): Board link in agents sidebar + board i18n keys (MF10)
6. `d6d0860` test(runTools): MF10 board tools join the always-on tool registration suite

## Files
- **New** `src/server/board.ts` — domain layer (idempotent tables `boards`, `tickets`, `ticket_comments`; atomic `claimTicket`).
- **New** `src/tools/boardTools.ts` — agent tools `ticket_create`, `ticket_list`, `ticket_claim`, `ticket_update`.
- **New** `src/server/routes/board.ts` — HTTP routes (see mounting below).
- **New** `packages/web/src/app/app/board/page.tsx` — kanban page (4 columns, drag + move buttons, detail drawer, comments, assign, New ticket).
- **New** `src/server/__tests__/board.test.ts` — 8 tests.
- **Edited (minimal)** `src/index.ts` (2 lines: import + `registerAll`), `src/server/runTools.ts` (4 names in `ALWAYS_ON_TOOLS`), `packages/web/src/components/agents/AgentSidebarList.tsx` (BoardLink component + one render line + lucide `Kanban` + `useRouter`), `packages/web/src/i18n/{en,ar}.json` (appended board keys only, textual insert — no reformat).
- `src/server/http.ts` **NOT edited** (parallel-worktree rule honored).

## SUPERVISOR ACTION REQUIRED — add exactly these 2 lines to `src/server/http.ts`
Near the other route imports (~line 78, next to `handleAgentThreadRoutes`):
```ts
import { handleBoardRoutes } from "./routes/board.js";
```
Near the other dispatch calls (~line 1631, next to `if (await handleScratchpadRoutes(req, res, p)) return;`):
```ts
if (await handleBoardRoutes(req, res, p)) return;
```

## HTTP routes (all under `/api/board/tickets`)
| Method + path | Body | Response |
|---|---|---|
| `GET /api/board/tickets` | — (optional `?status=todo|doing|review|done`) | `{ tickets: Ticket[] }` |
| `POST /api/board/tickets` | `{ title, body?, priority?, createdBy? }` | `{ ticket }` |
| `GET /api/board/tickets/:id` | — | `{ ticket, comments }` |
| `PATCH /api/board/tickets/:id` | `{ status?, priority? }` | `{ ticket }` |
| `POST /api/board/tickets/:id/comments` | `{ text, author? }` | `{ comment }` |
| `POST /api/board/tickets/:id/assign` | `{ agentId }` | `{ ticket, taskId }` — atomic claim + queued task for the agent via `db.createTask` (ticket as prompt); 409 when already claimed/done; 404 unknown agent |
| `POST /api/board/tickets/:id/release` | `{}` | `{ ticket }` (assignee → null) |

## Agent tools (always-on, in `ALWAYS_ON_TOOLS`)
- `ticket_create { title, body, priority? }` → creates ticket, `created_by` = agent id (or "user" outside a task).
- `ticket_list { status?, mine? }` → text list; `mine=true` filters to the calling agent.
- `ticket_claim { id }` → atomic; failure text when another agent/none found.
- `ticket_update { id, status?, comment? }` → status transition and/or threaded comment.

## Data model
- `boards(id, name)` — one shared board created idempotently on first use.
- `tickets(id, board_id, title, body, status CHECK todo|doing|review|done, assignee_agent_id NULL, created_by, priority CHECK low|normal|high|urgent, created_at, updated_at)`.
- `ticket_comments(id, ticket_id, author, text, created_at)`.
- Claim atomicity: single `UPDATE ... WHERE id = ? AND assignee_agent_id IS NULL AND status <> 'done'` inside `transaction`; loser keeps `undefined`.

## Tests (all pass)
`npx tsx --test src/server/__tests__/board.test.ts` — atomic claim (3 concurrent race + sequential loser + release/re-claim), done-ticket claim refusal, full todo→doing→review→done→todo transitions, invalid status/priority rejection, comment ordering + updatedAt stamp, always-on tool exposure (mergeAlwaysOnTools), tool shape (create/claim/update via `Tool.run`). Existing suites: scratchpad/agentThreads/schedulerRetry/scheduleTime/instructionHistory (30 pass) and runTools.test.ts (6 pass, updated to register board tools).

## How to test live
1. Supervisor adds the 2 http.ts lines above.
2. Start: `npm run dev`. Web: `packages/web` dev server → Agents page → sidebar "Board" → kanban; drag a card between columns or use the ◄ ► move buttons; open a card → drawer shows comments, status move, assign/Unassign (Assign creates a queued task for that agent); header "New ticket" opens the create dialog. Comments + assign persisted in SQLite; lang arabic uses the new ar.json keys.
3. Agent path: run an agent (say "create a ticket …"), it can `ticket_create`/`ticket_claim`; assign it a card from the UI and the queued task appears in its thread list.

## Verification status
- `npx tsc --noEmit` (root): 0 errors.
- `npx tsc --noEmit -p packages/web/tsconfig.json`: 0 errors.
- `npm run build` in `packages/web`: fails with the **known** Turbopack 'Could not find next/package.json' node_modules-junction error in this worktree; web tsc used instead (per task brief).
- Do-not-touch files untouched (`git status` clean on all).

## What's left
- Supervisor mounting of `handleBoardRoutes` in `src/server/http.ts` (2 lines above).
- Multiple named boards exist in schema via `boards.text` but the UI/lists hardcode the single default board (fine for MF10; boardId param already plumbed).
- i18n lint (`check:loam-ui`) only audits `components/`, but all board strings already use `t()`.
