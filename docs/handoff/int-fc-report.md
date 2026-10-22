# int-fc Handoff Report

## Commit

```
6ec3527 feat(agents): blank/custom agent creation and full agent editing
```

Files committed (owned):
- `packages/web/src/app/app/agents/page.tsx`
- `packages/web/src/components/agents/AgentEditDrawer.tsx`
- `packages/web/src/components/agents/NewAgentDialog.tsx`
- `packages/web/src/components/agents/agentLabels.ts`

## What changed

### NewAgentDialog.tsx
- Replaced the template-only flow with a two-step creation dialog.
- Step 1: starter selection. The first option is now **Blank / Custom agent** (Arabic: وكيل فارغ / مخصص), followed by the existing backend templates.
- Step 2: an editable configuration form that is shown for both blank and template selections. Selecting a template prefills every field (name, emoji, description, instructions, Loam mode, model, effort, capabilities, memory/workMode), and the user can edit any field before saving.
- Creation is now done with `POST /api/agents` (not `POST /api/agents/from-template`) so all edits are honored.
- Added fields:
  - Name (required)
  - Avatar / Emoji
  - Description
  - System instructions (multiline textarea)
  - Loam mode dropdown (ask/research/build/write/data/media/security/automate)
  - Model dropdown populated from `/api/config` (configured model) plus `/api/tags` (Ollama tags), with a "Custom model" option
  - Effort dropdown (max/high/medium/low)
  - Capabilities multi-select backed by `/api/work-modes` services, `/api/skills`, and `/api/mcp/status` connectors
  - Memory on/off toggle

### AgentEditDrawer.tsx
- Extended the edit drawer to edit all agent fields:
  - Name, emoji, description, system instructions
  - Loam mode
  - Model dropdown (same source as creation dialog)
  - Work mode dropdown (from `/api/work-modes`)
  - Memory on/off toggle (syncs with loam/chat work modes)
  - Effort
  - Capabilities multi-select (services, skills, connectors)
- Changed save method to `POST /api/agents/:id` (the backend update route expects POST, not PUT).

### agents/page.tsx
- Updated the empty-state button label from "New agent from template" to "New agent" to match the new blank + template flow.

### agentLabels.ts (new)
- Shared bilingual (English/Arabic) label helper for all new agent UI copy, without touching the central i18n JSON files.

## Request bodies used

### `POST /api/agents` (NewAgentDialog)

```json
{
  "name": "string (required)",
  "emoji": "string",
  "description": "string",
  "instructions": "string",
  "mode": "ask | research | build | write | data | media | security | automate",
  "effort": "max | high | medium | low",
  "workMode": "loam | chat",
  "allowedServices": ["string"],
  "model": "string (optional, omitted when empty / default)"
}
```

`allowedServices` contains the selected service IDs from `/api/work-modes`, plus selected skill names from `/api/skills` and selected connector names from `/api/mcp/status`.

### `POST /api/agents/:id` (AgentEditDrawer)

```json
{
  "name": "string",
  "emoji": "string",
  "description": "string",
  "instructions": "string",
  "mode": "ask | research | build | write | data | media | security | automate",
  "workMode": "chat | loam | user_device | own_device | team | continuous",
  "effort": "max | high | medium | low",
  "allowedServices": ["string"],
  "model": "string | null"
}
```

## Memory → workMode mapping

- **Memory ON** → `workMode: "loam"` ("تنفيذ داخل Loam")
- **Memory OFF** → `workMode: "chat"` ("المحادثة")

In `NewAgentDialog` this is the only mapping because the UI exposes a simple toggle. In `AgentEditDrawer` the full `workMode` dropdown is preserved so other modes (team, own_device, continuous, user_device) remain editable; the memory toggle is enabled only when the current work mode is `loam` or `chat`, and toggling updates the work mode between those two values.

## Verification

- `npx tsc --noEmit -p .` → 0 errors
- `npm --prefix packages/web run build` → succeeded

## Notes / caveats

- The backend's `allowedServices` validation (`validateServiceIds` in `src/server/companionGateway.ts`) currently accepts only known companion service IDs. Skill names and connector names are therefore included in the `allowedServices` array per the task instruction, but they may be rejected by the backend unless validation is relaxed or a separate field is added for skill/connector grants. Service IDs work correctly today.
- No backend code was changed. All changes are in the web UI.
- No changes to `AgentStartDialog.tsx`; it still passes `extData.agentId` when starting a task with an agent.

## Bug fix

**Bug:** The "Blank / Custom agent" starter used `id: null`, which collided with the initial unselected state. This prevented the details form from rendering and kept the Create button permanently disabled, so users could not create a blank agent.

**Fix commit:** `d67fef7 fix(agents): use distinct sentinel id for blank starter`

**Change in `packages/web/src/components/agents/NewAgentDialog.tsx`:**
- Added `const BLANK_TEMPLATE_ID = '__blank__'`.
- The blank starter option now uses `BLANK_TEMPLATE_ID` instead of `null`.
- `handleSelectTemplate(BLANK_TEMPLATE_ID)` now resets the form, and `null` only represents the truly unselected initial state.
- The details form renders for any non-null selection (`selectedTemplateId !== null`), including `BLANK_TEMPLATE_ID`.
- The Create button is enabled when a starter is selected and a name is provided.
- Visual selection highlight works for the blank option the same way as for templates (`selectedTemplateId === BLANK_TEMPLATE_ID`).

**Verified flow:** Open dialog → click Blank → form appears with empty fields → type a name → Create enabled → `POST /api/agents`.

## Bug fix

**Bug:** Editing an agent returned 404. The `AgentEditDrawer` saved edits with `PUT /api/agents/:id`, but the backend update route only accepts `POST /api/agents/:id`.

**Fix:** Changed the save request method in `packages/web/src/components/agents/AgentEditDrawer.tsx` from `'PUT'` to `'POST'` (same URL, same JSON body, same headers).

## Bug fix

**Bug:** When a task was started from an agent (`extData.agentId` sent by the client), the created task record persisted with `agentId = null`. As a result, `/api/tasks?agentId=...` and usage attribution missed tasks that originated from a custom agent.

**Root cause:** In `src/protocol/socket.ts`, `createTask` was called with a hard-coded `null` for the `agentId` argument.

**Fix:** Pass `um.extData.agentId ?? null` instead of `null`:

```ts
const task = createTask(text, text.slice(0, 80), um.extData.projectId ?? null, um.extData.agentId ?? null);
```

**Scope:** `src/protocol/socket.ts` only; no changes to `src/server/http.ts` or any other file.

**Verification:** `npx tsc --noEmit -p .` → 0 errors.
