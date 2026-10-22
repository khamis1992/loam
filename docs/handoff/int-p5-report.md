# int-p5 Handoff Report — Agent Loam Page

## Summary
Rebuilt `packages/web/src/app/app/agents/page.tsx` ("Agent Loam") into a full companion management page with a grid of editable companion cards, a template-based creation dialog, an edit drawer, direct task-start that forwards `extData.agentId`, plus read-only built-in agents and team runs sections. All work stayed within the int-p5 ownership boundary.

## Changes

### New components (`packages/web/src/components/agents/`)
- `AgentCard.tsx` — companion card showing name/emoji, mode, workMode, model, and Chat/Task/Edit actions.
- `BuiltInAgentCard.tsx` — static read-only cards for `explore`, `reviewer`, `coder`.
- `NewAgentDialog.tsx` — dialog populated from `GET /api/agent-templates`, creates via `POST /api/agents/from-template`.
- `AgentStartDialog.tsx` — prompt + quality-mode dialog. Connects `ChatSocket`, sends `user_message` with `extData.agentId` (and `loamMode` when the agent has a mode), adds the session to the store, then navigates to `/app/:uid` so the task page renders the run.
- `AgentEditDrawer.tsx` — right-side drawer with fields for name, Loam mode, work mode, allowed-services toggles (populated from `GET /api/work-modes`), model, and effort. Saves via `POST /api/agents/:id`.
- `TeamRunsList.tsx` — read-only list from `GET /api/swarm/runs`.

### Modified page
- `packages/web/src/app/app/agents/page.tsx` — orchestrates the sections and dialogs, keeps title as `t('Agent Loam')`, uses existing styling tokens (`bg-bg-main`, `rounded-card`, `border-border-main`, etc.).

## API usage
- `GET /api/agents` — list companions.
- `GET /api/agent-templates` — populate template dialog.
- `POST /api/agents/from-template` — create from template.
- `GET /api/work-modes` — work-mode selector + service catalog for allowed-services toggles.
- `POST /api/agents/:id` — save edits (backend exposes this as POST; used accordingly).
- `GET /api/swarm/runs` — team runs.

## Task-start mechanism
Because `TaskPageClient` only forwards `desktopBinding` from the URL into `extData`, the agents page starts tasks directly via `ChatSocket` so it can include `extData.agentId`. The flow:
1. Generate `uid`.
2. Connect/join `ChatSocket` to `uid`.
3. Emit `user_message(text, mode, [], { agentId, loamMode })`.
4. `dispatch(addSession(...))` then `router.push(`/app/${uid}`)`.
5. The temporary socket disconnects; `/app/:uid` renders the running task.

## Verification
- `npx tsc --noEmit -p .` — 0 errors.
- `npm --prefix packages/web run build` — succeeded.

## Commit
```
0a6b251 int-p5: rebuild Agent Loam page with companion cards, template dialog, edit drawer, task start with extData.agentId, built-ins, and team runs
```

## Owned files only
Committed:
- `packages/web/src/app/app/agents/page.tsx`
- `packages/web/src/components/agents/AgentCard.tsx`
- `packages/web/src/components/agents/BuiltInAgentCard.tsx`
- `packages/web/src/components/agents/NewAgentDialog.tsx`
- `packages/web/src/components/agents/AgentStartDialog.tsx`
- `packages/web/src/components/agents/AgentEditDrawer.tsx`
- `packages/web/src/components/agents/TeamRunsList.tsx`

No restricted files were edited.
