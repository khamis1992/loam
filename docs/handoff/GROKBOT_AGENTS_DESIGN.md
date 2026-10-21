# Loam: Grok Bot-style Agents Design (Agent Loam)

Status: spec for implementation on branch `manus-parity`. Scope is the **Agent Loam** area only (`packages/web/src/app/app/agents`, `packages/web/src/components/agents/*`). The rest of the Manus-identical shell (global sidebar, home, task chat, computer panel) is unchanged.

Sources:
- Grok Bot UI map (`/home/box/reference/app-ui.md`): a sidebar of agents; each agent has a chat; the agent's name in the chat header opens a per-agent info pane (computer preview, Routines, Channels, Members), with a close "X" and a gear for agent settings (avatar, name, title, description, notifications). Delete is done by right-clicking the agent row, with a confirm.
- Rakazo (`/workspace/re/rakazo/ANALYSIS.md`): one permanent thread per bot (Bot → Thread 1:1). New messages are appended to that thread, and a run is queued against it.
- Loam's existing APIs: `/api/agents[/:id, /archive, /duplicate, /usage, /memory, /integrations]`, `/api/tasks`, `/api/tasks/:id/files`, `/api/schedules[/run-now]`, `/api/memory`, `/api/skills`, plus the socket `ChatSocket` (`join(uid)`, `sendText(..., {agentId})`).

## 1. Model
| Concept | Grok Bot | Loam mapping |
|---|---|---|
| Bot identity | avatar, name, title, description | agent `emoji`, `name`, `description`, `instructions`, `mode`, `model`, `effort`, `allowedServices` (existing form fields kept) |
| Permanent chat | one transcript per bot | **Agent thread** = one task/session uid per agent. Resolve it as follows: (1) `localStorage['loam.agentThread.'+agentId]`; (2) else the newest `/api/tasks` item whose `agentId` matches; (3) else create it lazily on the first message via `ChatSocket.sendText(text, {agentId})`, then store the uid. All later messages go to the same uid (`join(uid)` + `sendText`), so the agent keeps one continuing conversation. This is a frontend-only mechanism with no server changes. |
| Info pane: computer preview | live box preview | the existing `ComputerPanel` for the thread uid, in compact mode |
| Routines | Routines list | `/api/schedules` filtered by `agentId`, with "Run now" (`/run-now`) and delete |
| Media / Files | media of the transcript | `/api/tasks/:uid/files` for the agent thread (artifacts) |
| Memory | (memory) | `/api/agents/:id/memory` |
| Skills / Tools | (tools) | the agent's `allowedServices`, mode, and skills (`/api/skills`), read-only list with an "Edit" link to the drawer |
| Members | group chats only | Loam has no group chat, so the tab shows the "Team runs" list (`TeamRunsList`) |
| Settings gear | per-agent settings | opens the existing `AgentEditDrawer` (POST save, bc9bcc9) |
| Delete | right-click → Delete (confirm) | right-click the row → Archive (with confirm) via `/api/agents/:id/archive`. Loam soft-archives agents; it has no hard delete. |
| Create | "+" | the "+" in the sidebar header opens `NewAgentDialog`. The dialog opens blank by default, and templates only prefill its fields (unchanged behaviour). |

## 2. Layout (ASCII)
```
┌ global app sidebar (unchanged) ┐┌──────────── Agent Loam ───────────────────────────────────────────┐
│ ...  Agent Loam (active)       ││┌ Agents ─────[+]┐┌ chat header: [😀 Name ▾]  mode·model  [ⓘ] ┐┌ info pane ─[⚙][X]┐
│                                │││ 🔍 search       ││                                            ││ 😀 Name           │
│                                │││ MY AGENTS       ││  persistent thread messages                ││ description       │
│                                │││ 😀 Writer    •2 ││  (user right, agent left)                  ││ ┌ computer prev ┐ │
│                                │││ 🤖 Pentester    ││                                            ││ └───────────────┘ │
│                                │││ BUILT-IN        ││                                            ││ Overview|Routines │
│                                │││ 🧭 Researcher   ││                                            ││ Media|Computer|   │
│                                │││ TEAM RUNS  ›    ││ ┌ composer: Message Name…        [send] ┐   ││ Members           │
│                                │││                 ││ └───────────────────────────────────────┘   ││ tab content       │
└────────────────────────────────┘└└─────────────────┘└────────────────────────────────────────────┘└───────────────────┘
   widths: agents list 260px, info pane 340px (toggle), chat flex-1
```
Empty state (no agent selected): centred card "Pick an agent or create one" with a primary "New agent" button.
Built-in agent row: clicking it opens the existing built-in start behaviour; it gets no permanent thread.

## 3. Interaction
- Rows show the avatar (emoji in a 28px rounded square, `bg-fill-tsp-white-dark`), the name (`text-sm text-text-primary`, truncated), and an unread dot or count. Unread = new messages in the agent thread since `localStorage['loam.agentSeen.'+id]`.
- The selected agent is held in the URL query `?agent=<id>` (static export safe).
- Clicking the header name or the ⓘ icon toggles the info pane. **Ctrl+Shift+I** toggles it too. The X closes it.
- Right-clicking a row opens a context menu with Open, Edit, Duplicate, Archive (with confirm).
- Sending a message streams into the thread and opens the full task view with "Open in task view" (`/app/<uid>`) for the Manus side panel.

## 4. Tokens (reused from `styles/tokens.css` / Tailwind theme only)
`bg-bg-main` (canvas), `bg-bg-menu` (lists and pane), `border-border-main` (dividers), `text-text-primary/secondary/tertiary`, `hover:bg-fill-hover`, `rounded-control`, `rounded-card`, `h-row` header height, `text-title-lg` and `text-headline-sm` headings, `--Button-black` primary, `--activity-indicator-running` for the unread dot. No new colours.

## 5. Constraints
Brand: "Loam". The sidebar item stays "Agent Loam", with no "Cue". Create, edit and run of custom agents keep working (bc9bcc9 POST save; 0fb3695 agentId passed to createTask). No server files are touched (`src/server/http.ts` belongs to ZCode).
