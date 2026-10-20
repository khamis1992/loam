# Grok Bot-style Agents Page — Implementation Report

Branch: `manus-parity`
Status: implemented and type-checked; static export builds successfully.

## Files changed / added

| File | Change |
|---|---|
| `packages/web/src/app/app/agents/page.tsx` | Converted to server component with `Suspense` boundary; renders `AgentsPageClient`. |
| `packages/web/src/app/app/agents/AgentsPageClient.tsx` | New orchestrator: 3-column layout, query-param state (`?agent=<id>`), dialog/edit/start handlers, unread computation, `Ctrl+Shift+I` toggle. |
| `packages/web/src/components/agents/AgentSidebarList.tsx` | New 260px left sidebar: search, `+` → `NewAgentDialog`, sections MY AGENTS / BUILT-IN / TEAM RUNS, emoji avatar rows, unread dot, right-click context menu Open/Edit/Duplicate/Archive-with-confirm. |
| `packages/web/src/components/agents/AgentThreadView.tsx` | New center permanent chat: thread resolution (localStorage → newest `/api/tasks?agentId` → lazy creation), socket join/send via `ChatSocket`, message list loaded from `/api/tasks/<uid>`, composer reuses existing `Composer`, header toggles info pane + "Open in task view". |
| `packages/web/src/components/agents/AgentInfoPane.tsx` | New 340px right info pane: close X + gear → `AgentEditDrawer`, avatar/name/description, tabs Overview/Routines/Media/Computer/Members with data from `/api/agents/:id/memory`, `/api/schedules` (+ run-now), `/api/tasks/<uid>/files`, `TeamRunsList`. |

## Commits

- `01b74a9` — `feat(agents-gb): rebuild agents page into 3-column Grok Bot-style layout`
- `2ff59e1` — `feat(agents-gb): add implementation report`

## Verification

- `npx tsc --noEmit -p packages/web/tsconfig.json` → 0 errors
- `npm run build` inside `packages/web` → static export builds successfully

## Constraints followed

- Used only existing Tailwind tokens: `bg-bg-main`, `bg-bg-menu`, `border-border-main`, `text-text-primary/secondary/tertiary`, `hover:bg-fill-hover`, `rounded-control`, `rounded-card`, `h-row`.
- All user-visible strings wrapped with `t()`.
- Title kept as `Agent Loam`; the word "Cue" is not used.
- `NewAgentDialog`, `AgentEditDrawer` (POST save), and `AgentStartDialog` are reused unchanged.
- No files under `src/server` were modified.
- The listed uncommitted files (`src/server/companionGateway.ts`, `src/setup/runtime.ts`, `src/tools/companionTeamTools.ts`, `scripts/stt_server.py`, `src/scripts/*`) were not touched or committed.

## Not done / known limitations

- **Built-in agents**: clicking a built-in row currently opens the existing `AgentStartDialog` (matching spec "opens the existing built-in start behaviour"), but no dedicated permanent thread is created.
- **Computer tab**: shows a placeholder rather than the live `ComputerPanel`, because `ComputerPanel` requires a `ToolUsedEvent` and the agent thread may not have one. The inline chat still auto-opens a compact computer placeholder on the first tool event.
- **Unread counts**: computed by reading each agent's resolved thread and comparing assistant message timestamps to `loam.agentSeen.<id>`; this is correct but loads threads eagerly on mount.
- **Archive restore**: only soft-archive is implemented (via `/api/agents/:id/archive`), matching Loam semantics; there is no hard delete.
- **Team Runs sidebar section**: shows a compact inline list; full details remain in the existing `TeamRunsList` component under the Members tab.
