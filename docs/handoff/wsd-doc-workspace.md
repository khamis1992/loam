# WSD handoff — Word (.docx) workspace editor

Branch `mf/wsd`. Everything committed; nothing pushed.

## What was built

A .docx workspace editor under the shared workspace-panel contract (types/registry per
spec). Rendering and saving reuse the existing studio office machinery
(`office_import`/`office_export` logic) — no new npm dependencies.

### Server
- `src/server/workspace/docIO.ts` — DOCX ⇄ HTML:
  - `loadWorkspaceDoc(workspace, rel)` — parses `word/document.xml` via the studio word
    import (`importWordBlocks`/`importWordRegions`), persists an original-bytes snapshot +
    baseline into `.loam/imports/<uuid>.zip|json` (same layout `loadImport` expects, in a
    shadow store that never touches the task's `.loam/studio.json`), and renders the blocks
    to an editable HTML fragment. The payload starts with an opaque concurrency token:
    `<!-- doc-session <uuid> <mtimeMs> -->`. Documents whose body contains elements the
    studio text flow cannot model (e.g. 7+-column tables, legacy drawings) are reported as
    `editable:false` + a warning instead of risking data loss; saving such a doc without a
    re-import is refused.
  - `saveWorkspaceDoc(workspace, rel, html)` — validates the marker against the current file
    mtime (409 on external change), rebuilds `DocumentBlock[]` from the edited HTML
    (headings/bullets/paragraphs, bold/italic/underline segments folded exactly like
    `importWordBlocks`, tables/stats/images round-trip via the same rich-block rules),
    `validateStudio` + `exportStudio` (round trip patching preserves original parts/media),
    then an atomic tmp+rename write.
  - Shadow snapshots are pruned (max 50, 7 days, never the id referenced by studio.json).
- `src/server/routes/workspaceDoc.ts` — `handleWorkspaceDocRoutes(req, res, p, ctx)`:
  - `GET /api/workspace/doc/file?taskId&path` → `{ html, session, mtimeMs, size, name, warnings, editable }`
  - `GET /api/workspace/doc/file?taskId&path&metaOnly=1` → `{ mtimeMs, size, name }`
  - `PUT /api/workspace/doc/file?taskId&path` — JSON body `{ html: "<!-- doc-session … -->…" }`
    → `{ ok, marker, mtimeMs, size }`; 409 when the file changed on disk, 404 for missing
    files/tasks, 400 for unsupported content.
- Test: `src/server/__tests__/workspaceDoc.test.ts` (`npx tsx --test src/server/__tests__/workspaceDoc.test.ts`)
  covers the full round trip, stale-marker 409, and non-editable detection. All green.

### Web (packages/web)
- `components/workspace/types.ts`, `registry.ts` — exact contract shapes.
- `components/workspace/workspace` shell stubs I had to create (this worktree had no shell work;
  the shell session owns these going forward): `index.ts`, `WorkspacePanel.tsx` (resolve → load
  editor → PUT `/api/workspace/<kind>/file` on onSave; onChatEdit opens a ChatSocket and sends
  `Edit <path>: <instruction>` as a task message), plus empty `video|sheet|slides` register stubs.
- `components/workspace/doc/` — `register.ts` (+ default export editor), `Editor.tsx`
  (contenteditable surface; toolbar: bold/italic/underline, H1–H3, paragraph, bullet & numbered
  lists; Save button; "Task running" badge; chat-edit instruction row; live reload banner),
  `serialize.ts` (DOM → well-formed fragment, only data-*/src/alt/limited style attrs survive),
  `loadDoc.ts` (GET/metaOnly helpers).
  - Live refresh: polls `metaOnly` every 2.5 s; external mtime change → banner + automatic reload.
  - Save flow: serialize with the marker → onSave (panel PUTs) → refresh mtime token; 409 →
    auto reload with a message.
- Integration (minimal, meant for the shell to absorb): `AgentInfoPane.tsx` — MediaTab rows for
  `.docx` get an "Edit" button that opens WorkspacePanel in the info pane (replaces the aside
  while a file is open).

### http.ts mounting (NOT edited — parallel-worktree rule; supervisor adds these 2 lines)
```ts
// 1) with the other routes/… imports near line 80:
import { handleWorkspaceDocRoutes } from "./routes/workspaceDoc.js";
// 2) inside the /api dispatch, right after the other handle*Routes calls (near line 1637):
if (await handleWorkspaceDocRoutes(req, res, p, { workspace: cfg.workspace })) return;
```

## How to test live
1. `npm run dev` (server) with a task that has a `.docx` in its workspace.
2. With the media tab open, click "Edit" on a `.docx` row → editor loads; edit, Save → the file
   on disk changes (verify via the files list or Word).
3. While the editor is open, have the agent rewrite the file → the editor shows
   "Document updated by another writer — reloaded." within ~2.5 s.
4. Type an instruction into the chat-edit row → a message `Edit <path>: …` appears in the task chat.
5. Unit round trip: `npx tsx --test src/server/__tests__/workspaceDoc.test.ts`.

## Known limits (v1)
- Editor subset: headings/paragraph/bullets, bold/italic/underline, tables & images preserved
  (cell text edits, image replace supported by the round trip). Heading levels are preserved as
  headings (level changes don't rewrite pStyle); underline survives via segment list only.
- Documents with unmodelled body elements open read-only (warning shown) — saving is refused by
  the server to avoid data loss.
- `npm run build` in packages/web fails in this worktree with the documented Turbopack
  `Could not find next/package.json` junction issue; web `tsc --noEmit` and vitest unit tests
  are the local authority (pre-existing 6 e2e/settings test-file load failures are environmental
  and identical on a clean tree; all 27 executable tests pass).
