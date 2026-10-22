# OPH report — options #17, #18, #22, #23 (rebuilt on merged mainline a96179c)

NOTE: mid-session this worktree was reset to the merged base (`merge mf/mf3`); the earlier
OPH commits (built on the old pre-redesign tree with `src/web`, dev-plan page, api.ts) were
pruned and unrecoverable. Everything below was re-implemented against the NEW base, where
the Grok-bot-style web app (`packages/web/src/app/app/...`), full project CRUD and the
companion-device lifecycle APIs already exist.

## Commits (branch mf/oph)

- ef2fbca feat(server): model tiers config, git worktree helpers, project-context routes (17/18/22)
- dc66294 feat(run): bind composer folder/worktree to tasks, route model tier + flex BYOK (17/18)
- 4d0e210 test(server): tiers, worktree creation, project-context routes (17/18/22)
- 0c178f0 feat(web): project chip popover + worktree start + tier send + Flex BYOK form (17/18)
- cea1b88 feat(web): projects + automations create/edit/delete, run-now, enable toggle (22)
- 1b74747 feat(web): computers pairing flow, golden prep, start/stop/delete actions (23)
- 7e1235c i18n: keys for tier picker, project picker, automations, computers (17/18/22/23)

## Files

Server (new): `src/server/modelTiers.ts`, `src/server/worktrees.ts`, `src/server/routes/projectContext.ts`,
tests `src/server/__tests__/{modelTiers,worktrees,projectContext}.test.ts`.
Server (touched, localized): `src/server/settings.ts` (+flexBaseUrl/flexModel), `src/server/db.ts`
(Project.folder, updateProject folder patch, updateSchedule, getSchedule), `src/protocol/socket.ts`
(task folder/worktree bind at task creation; extData.modelTier -> runTask.model), `src/protocol/types.ts`
+`packages/shared/src/socket.ts` (extData: worktreeEnabled?, modelTier?), `src/index.ts` (flex run-scoped
OllamaClient when chosen model == flex model id).

Web: `packages/web/src/components/chat/Composer.tsx` (context bar popover picker: projects from
GET /api/projects, "Use a folder", "Clear project", enabled Worktree checkbox; Composer sends
modelTier/projectId/worktreeEnabled in extData), `packages/web/src/app/app/page.tsx` (project state,
branch via GET /api/projects/:id/git falling back to desktop useBranch), `packages/web/src/components/home/ModelMenu.tsx`
(Flex BYOK form: base URL, model id, key input; key stored via vault, never fetched/displayed; remove-key),
`packages/web/src/app/app/projects/page.tsx` + `automations/page.tsx` (full CRUD dialogs, two-step delete,
run-now, enable toggle, empty-state CTAs), `packages/web/src/app/app/computers/page.tsx` (pair dialog:
companion + template + name, golden-image prep when providers.wsl && !goldenReady, start/stop/suspend/resume/delete),
`packages/web/src/i18n/en.json` + `ar.json` (+51 keys each, appended at EOF only).

## Route module — MOUNT REQUIRED (http.ts not edited, per parallel-worktree rule)

`src/server/routes/projectContext.ts` exports `handleProjectContextRoutes(req, res, p): Promise<boolean>`.
Add these 2 lines to `src/server/http.ts`:

```ts
import { handleProjectContextRoutes } from "./routes/projectContext.js";
```

then the dispatch immediately after the existing schedules dispatch (currently http.ts:1633
`if (await handleSchedulesRoutes(req, res, p)) return;`), so it runs BEFORE the generic
`p.startsWith("/api/projects/")` block (http.ts:~1902):

```ts
if (await handleProjectContextRoutes(req, res, p)) return;
```

Endpoints:
- GET /api/model-tiers -> `{ tiers: [{ id: "max"|"standard"|"lite"|"flex", model, flex }], flex: { baseUrl, model, hasKey } }` (key never present)
- PUT /api/model-tiers/flex `{ key?, baseUrl?, model? }` -> `{ ok, flex }`; `key: ""` clears the sealed key (AES-256-GCM vault scope "model-tiers")
- DELETE /api/model-tiers/flex/key -> `{ cleared, flex }`
- GET /api/projects/:id/git -> `{ folder?, isGit, branch, reason? }`
- PUT /api/projects/:id/folder `{ path }` -> `{ project }` (validates directory; "" clears)
- POST /api/projects/:id/worktrees `{ name? }` -> 201 `{ path, branch }` | 409 `{ error }` (git worktree add under `<folder>/.loam-worktrees/<name>`, branch `loam/<name>`)
- PATCH /api/schedules/:id `{ prompt?, enabled? }` -> `{ schedule }`

Run behavior (already wired, no extra mount): composer sends extData `{ modelTier, projectId, worktreeEnabled, desktopBinding.folderPath }`; socket binds
the task workspace to the folder (or a fresh worktree when worktreeEnabled), and index.ts swaps in a flex provider client for flex runs.

## How to test live

1. Apply the 2 mount lines above, `npm run dev` + web dev.
2. #17: Home composer — chip opens project list (seed a project first on /app/projects with a folder +
   browse), branch chip then shows the real branch; pick a folder ("Use a folder"), tick Worktree, send
   -> new task workspace is a git worktree under `.loam-worktrees/` (verify in task pty/files).
3. #18: Model menu — Max/Lite map to cfg model/fallback; pick Flex, save base URL + model + key; send a
   task -> telemetry model is `<flexModel>:cloud` and calls hit the flex provider; GET /api/model-tiers
   shows only `hasKey`.
4. #22: /app/projects and /app/automations — create/edit/delete; toggle + "Run now" on routines.
5. #23: /app/computers — empty state CTA opens pair dialog; on WSL hosts prepare golden image first,
   then create devices; start/stop/delete act on companionDevices lifecycle.

## Verification done

- `npx tsc --noEmit` (server): 0 errors.
- `npx tsc --noEmit -p packages/web/tsconfig.json`: 0 errors.
- `npm run check:encoding`: OK.
- New server tests 12 pass; all server `__tests__` 48 pass; `src/protocol/__tests__/run.ts` PASS;
  web vitest i18n suites pass (27 tests).
- `npm run build` in packages/web fails with the known worktree Turbopack "Could not find next/package.json"
  junction error (documented for this worktree; relied on web tsc instead).
- `check:isolation-http` could not run: port 8787 is occupied by another session's dev server (EADDRINUSE);
  it only exercises http.ts, which is untouched.

## Left / follow-ups

- Supervisor must add the 2 http.ts mount lines above (module is inert without them; web tier/Flex,
  project git chip, worktree POST and schedule PATCH degrade to 404 until mounted).
- Automations "edit" only changes prompt (schedule cadence is recreate-only, by design).
- Devices page (/app/devices, desktop connect API) untouched; #23's pairing scope was companion computers.
- Resume path recomputes model from opts/agent/settings (pre-existing); flex tier is honored at run start.
