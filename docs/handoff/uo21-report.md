# uo21 — Creations and Library pages load real data

## Problem (option #21)

The sidebar Creations and Library pages used to call `/api/creative`, `/api/media`
and `/api/files` with none of the required parameters, so every screenload got
HTTP 400 ("taskId required" / "path required"). An earlier pass (int-p4/cb75519)
had already made the pages enumerate `/api/tasks` and hit `/api/files`
per-task, which works but is an N+1 fan-out of up to 50 requests per page and
still leaves the endpoints 400-ing anything without a full taskId/path.

## What was done

**Server (`src/server/http.ts`, the three handlers only):**

- `/api/files` — new sane-default list mode: `GET /api/files?list=1[&max=N]`
  with **no taskId** aggregates the files of every task that already has a
  workspace (newest task first, capped at the 200 most recent tasks), sorted by
  mtime descending, and tags every entry with `taskId` so media links stay
  per-task. The strict per-task contract is untouched: a paramless
  `/api/files` still returns 400 (task isolation, asserted by
  `check-isolation-http.ts`), and the existing `requireTaskWorkspace` flow,
  404 behavior, symlink/traversal guards and per-task scan caps are unchanged.
- `/api/creative` — new list mode: `GET /api/creative?list=1` with no taskId
  returns `{ scenes: [{ taskId, title, revision, updatedAt }] }` by scanning
  `.loam/creative.json` across media-mode tasks (newest first). Paramless
  `/api/creative` still returns 400 as `check-creative-http.ts` asserts, and
  the per-task GET/POST/asset paths are byte-for-byte unchanged.
- `/api/media` — instead of `400 "path required"` when a `taskId` is given
  without a `path`, it now returns a list of the task's streamable media files
  (`{ entries }`, newest first, media extensions only — png/jpg/webp/gif/svg/
  mp4/webm/mov/mkv/audio). Requests **with** a path stream bytes exactly as
  before (Range support, 404/416, `../` traversal → 400).

**Web pages (`packages/web/src/app/app/creations/page.tsx`, `.../library/page.tsx`):**

- Both pages now load with a **single** `GET /api/files?list=1&max=400` call
  instead of `/api/tasks` + one request per task. They keep the same kind
  filters (Creations: images/videos/svg; Library: docs/slides/sheets), the
  `isTaskId` guard on the server-provided `taskId`, newest-first sorting, and
  the same rendering/media-link markup built on
  `/api/media?taskId=…&path=…`.

## Verification

- `npx tsc --noEmit` (root) — 0 errors; `npx tsc --noEmit -p packages/web/tsconfig.json` — 0 errors.
- New integration check `src/scripts/check-library-pages.ts` boots the real
  server twice and asserts: aggregate listing across two tasks with correct
  taskId tags, `/api/files` and `/api/creative` paramless 400s preserved,
  media-path traversal 400, media list filtering, scene list contents, and
  survival across a server restart. **PASS.**
- Regression note (pre-existing, not from this change):
  `src/scripts/check-isolation-http.ts` (and other older check scripts) time
  out at startup on this branch because they don't send the local auth token
  that was added by the merged OPA work (`x-loam-local-token` gate in
  `src/server/http.ts`); the failure occurs before any uo21 code path is
  exercised, and my own check passes by setting `LOAM_AUTH_DISABLED=true`.
  Maintainers may want to either make those scripts send the token or set
  `LOAM_AUTH_DISABLED=true` in their child env.

## Files touched

- `src/server/http.ts` (three route handlers: files/media/creative) — additive
  list modes only.
- `packages/web/src/app/app/creations/page.tsx`, `packages/web/src/app/app/library/page.tsx`.
- New: `src/scripts/check-library-pages.ts`.
- No protected files (runtime.ts, companionGateway.ts, companionTeamTools.ts,
  serviceBridgeTools.ts, serviceGapTools.ts, stt_server.py) were touched.
