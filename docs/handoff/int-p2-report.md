# int-p2 Handoff Report

## Commits

- `bd660f1` — `int-p2: home starters, composer + menu, mode chip, settings panes`
- `b32a157` — `int-p2: handoff report`

## Scope

Phase 2 focused on the home entry points, the chat composer “+” menu, the Loam mode chip, and the settings surfaces for Connectors, Skills, and Memory.

## Changes

### Home starter menu → Loam mode wiring

- `packages/web/src/components/home/StarterMenu.tsx`
  - Extended `StarterItem` with `loamMode?: string` and changed `onSelect` to pass the whole item.
- `packages/web/src/app/app/page.tsx`
  - Mapped every starter entry to a Loam mode:
    - Build/Websites/Apps/Games → `build`
    - Slides/Docs → `write`
    - Images/Videos → `media`
    - Sheets/Data → `data`
    - Research → `research`
    - Security scan → `security`
    - Automation → `automate`
  - Selecting a starter sets both the composer prompt and the pending Loam mode.
  - The run-request path now serializes the full `extData` object (including `loamMode`, `skills`, `connectors`) into the URL via `?extData=<json>` so the task page can include it on the first socket message.

### Composer “+” menu

- `packages/web/src/components/chat/Composer.tsx`
  - Added menu sections: **Skills** (fetched from `GET /api/skills`), **Connectors** (fetched from `GET /api/mcp/status`), and **Agents** (navigates to `/app/agents`).
  - Selecting a skill/connector attaches a chip and includes it in the next send as `extData.skills` / `extData.connectors`.
  - Added `defaultLoamMode` and `resolvedLoamMode` props so the mode chip is controllable from the parent.
  - Changed `onSend` signature to `(text, mode, files, extData?)` so callers receive any extra payload.

### Loam mode chip

- `packages/web/src/components/chat/ModeChip.tsx` (new)
  - Renders next to the existing Standard/Lite/Max selector.
  - Displays the resolved mode from the `mode` chat event, or a user-selected override.
  - Dropdown override sends `extData.loamMode` on the next message.
  - Bilingual labels, brand name is “Loam”.

### Task page extData wiring

- `packages/web/src/app/app/[sessionUid]/TaskPageClient.tsx`
  - Reads `?extData=` from the URL, parses it, and forwards it to `socket.sendText` with the first draft.
  - Computes `resolvedLoamMode` from the latest `mode` chat event and passes it to `<Composer>`.
  - Subsequent composer sends merge `cwd` desktop-binding with the composer-supplied `extData`.

### Settings panes

- `packages/web/src/components/settings/ConnectorsPane.tsx` (new)
  - Lists real MCP servers from `GET /api/mcp/status` with name, tool count, and connection status.
- `packages/web/src/components/settings/SkillsPane.tsx` (new)
  - Lists real skills from `GET /api/skills` with name and description.
- `packages/web/src/components/settings/MemoryPane.tsx` (new)
  - Shows memory status from `GET /api/memory/status` (enabled, count, model) and entries from `GET /api/memory`.
- `packages/web/src/components/settings/SettingsDialog.tsx`
  - Registered the **Connectors**, **Skills**, and **Memory** tabs under Capabilities.
  - Added them to `MVP_TAB_IDS` so they render real panes instead of “Coming soon”.

### i18n

- `packages/web/src/i18n/en.json` and `packages/web/src/i18n/ar.json`
  - Added bilingual keys for Loam modes, new starter labels/prompts, and the settings pane copy.

## Verification

```powershell
npx tsc --noEmit -p .
# exit 0, no errors

npm --prefix packages/web run build
# Compiled successfully; static export generated in packages/web/out
```

## Notes / Known limitations

- The backend currently may ignore `extData.skills` / `extData.connectors`; the UI is wired and payloads are sent, but actual routing depends on the server-side message handler (outside this phase).
- Mode override is sticky per message until the user clears it or navigates away.
