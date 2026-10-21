# WSS — Manus-style side-panel Workspace shell (handoff)

Branch: `mf/wss` · Worktree: `C:\Users\khamis\Desktop\mf-wt\wss`

## Commits
- `4caeb3c` wss: workspace shell types, registry, auto-open, panel + stub editors
- `89d24fa` wss: integrate Workspace tab into task right panel, auto-open, onChatEdit, tests, i18n

## Files (all owned by the shell session)
- `packages/web/src/components/workspace/types.ts` — exact contract types (`WorkspaceKind`, `WorkspaceFile`, `WorkspaceEditorProps`, `WorkspaceEditorDef`).
- `packages/web/src/components/workspace/registry.ts` — `registerEditor`, `getEditorForFile` (extension first, kind fallback), `getEditorForKind`, `getEditorForPath`, `listEditors`, `extensionOf`, plus `subscribeWorkspaceEditors`/`workspaceEditorsVersion` so late (dynamic) registrations re-render the panel.
- `packages/web/src/components/workspace/autoOpen.ts` — pure decision helpers: `isWorkspaceToolName`, `decideWorkspaceOpen(event)`, `latestWorkspaceDecision(events)`. Opens when a tool names a file whose extension matches a registered editor, or when the tool is `office_*` / `video*` / docx/xlsx/pptx/slides/sheet-named.
- `packages/web/src/components/workspace/index.ts` — side-effect bootstrap; guarded `import('./{video,doc,sheet,slides}/register').catch()` so a missing/broken register module never breaks the shell. Re-exports the public surface.
- `packages/web/src/components/workspace/WorkspacePanel.tsx` — live progress strip (running dot + latest tool/brief from task events), file switcher (workspace files from `GET /api/files?taskId=...` filtered by registered editors, newest-mtime first), lazy editor area (Suspense + `React.lazy(def.load)`), empty state, per-file selection honoring `requestedPath`.
  - `onSave(data)` → `PUT /api/workspace/<kind>/file?taskId&path` (text/plain or octet-stream). The 404 until the editor sessions add their route modules is expected per contract.
  - `onChatEdit(instruction)` bound per file → shell sends `Edit <path>: <instruction>`.
- Stubs (overwrite freely by editor sessions): `workspace/<kind>/register.ts` + `workspace/<kind>/Editor.tsx` for `video|doc|sheet|slides`, rendering "Preview not available yet".

## Integration (minimal, localized)
- `packages/web/src/components/computer/ComputerPanel.tsx`:
  - new optional props `workspaceSlot?: ReactNode`, `focusWorkspace?: boolean`;
  - Workspace tab appended to the tab strip only when `workspaceSlot` is provided;
  - tabs became clickable (`userTab` state, reset when the driving event changes); `focusWorkspace` pre-selects Workspace; existing Terminal/Editor/Browser/Preview/Files/Studio content unchanged.
- `packages/web/src/app/app/[sessionUid]/TaskPageClient.tsx`:
  - `latestWorkspaceDecision(events)` effect auto-opens the right panel on the Workspace tab and selects the touched file (once per `actionId`);
  - manual tool-row clicks clear the workspace focus unless the clicked event is the workspace one;
  - `handleWorkspaceChatEdit` sends `Edit <file path>: <instruction>` via the existing `ChatSocket.sendText` with the current task mode;
  - `WorkspacePanel` is mounted with `taskId` (from attachment/clock events), `live = running`, `events`.
- i18n: 5 new keys appended to `en.json`/`ar.json` only (last lines, easy merge).

## Server
- No server code touched. `src/server/http.ts` remains unmodified — **no import/dispatch lines are needed from the supervisor for this shell**. Editor sessions will add `src/server/workspace/<kind>*` + `src/server/routes/workspace<Kind>.ts` (raw GET/PUT `/api/workspace/<kind>/file?taskId&path`) and report their own http.ts 2-liners.

## Tests
- `packages/web/src/components/workspace/__tests__/registry.test.ts` (5) — extension resolution incl. dots/case, kind fallback, `extensionOf`.
- `.../__tests__/autoOpen.test.ts` (6) — auto-open decision incl. office/video tools without paths, non-editor paths, description-scanned paths, latest-event pick.
- `npx vitest run src/components/workspace` in `packages/web`: 11/11 pass.

## Verification
- `npx tsc --noEmit` (root): 0 errors. `npx tsc --noEmit -p packages/web/tsconfig.json`: 0 errors.
- `npm run build` in packages/web fails only with the known worktree Turbopack `Could not find next/package.json` junction error (documented as expected); rely on web tsc.
- Pre-existing (not from this change): `src/components/settings/__tests__/settings.test.tsx` fails under vitest because `vitest.config.ts` has no `@` alias; e2e Playwright specs are matched by vitest. Both fail identically without this work.

## Live test steps
1. `npm run start` (or existing dev flow) server + web dev; open a task that runs an `office_*` tool or writes a `.docx/.xlsx/.pptx/.mp4` file.
2. Right panel ("Loam's computer") opens on the **Workspace** tab; progress strip shows the running tool; the produced file is selected once present in the task workspace (`GET /api/files` refreshes on each new tool event).
3. Switch files via the pill row; with stub editors you see "Preview not available yet".
4. Editor sessions replace `workspace/<kind>/Editor.tsx`+`register.ts` and add their PUT route; Save then hits `/api/workspace/<kind>/file`; the editor's chat-edit box posts `Edit <path>: <instruction>` into the task.

## Left
- Real editors + `GET/PUT /api/workspace/<kind>/file` routes (editor sessions).
- Optional: server-side MIME for `WorkspaceFile.mime` (currently a small client map).
