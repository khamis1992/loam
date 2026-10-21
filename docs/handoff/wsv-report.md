# WSV — Workspace video editor (montage) handoff

Branch: `mf/wsv` (worktree `wsv`). Owner scope: `packages/web/src/components/workspace/video/`,
`src/server/workspace/videoRender.ts`, `src/server/routes/workspaceVideo.ts`.

## What exists

### Web editor — `packages/web/src/components/workspace/video/`
- `Editor.tsx` implements `WorkspaceEditorProps` (`file`, `live`, `onSave`, `onChatEdit`). The
  interface is untouched, so a richer editor can replace it.
- HTML5 `<video>` preview streams the source (or the last rendered output) with byte ranges.
- Timeline of clips/segments. On mount it hydrates `GET /api/workspace/video/hydrate`:
  - reads the sidecar `<file>.edl.json` when the task/previous session produced one;
  - otherwise derives a single clip `[0, duration]` from the probed source;
  - accepts EDL variants `{clips|segments:[{in|start,out|end}]}`.
- Manual edits: trim in / trim out to playhead, split at playhead, delete segment, reorder
  (Move earlier/later), add/edit/remove text overlays (text, start/end on the output timeline,
  x/y percent).
- `Save EDL` writes the sidecar atomically (`PUT /api/workspace/video/file`).
- `Apply` posts the current EDL, polls the job (progress from ffmpeg `-progress pipe:2`), and
  switches the preview to the rendered output. `Cancel render` DELETEs the job.
- Live mode (`live === true`): polls `GET /api/workspace/video/meta` every 3s (cheap `stat`);
  refreshes the `<video>` (cache-busting nonce) and duration when the file mtime changes.
- Chat-driven edits: sends `Edit <file path>: <instruction>` through the shell's
  `onChatEdit(instruction)`.
- `register.ts` side-effect: `registerEditor({ kind: 'video', extensions: ['.mp4',...], load: () => import('./Editor') })`.

### Server — `src/server/workspace/videoRender.ts`
- Canonical ffmpeg path reused from the creative tools:
  `ROOT/node_modules/ffmpeg-static/ffmpeg[.exe]` (same path as `src/creative/timeline.ts`).
- `normalizeEdl` validates/clamps clips and overlays (aliases supported), `probeVideo` reads
  duration/audio via `ffmpeg -i` stderr, `edlDuration`, `chooseOutputPath` (never overwrites),
  `buildFfmpegArgs` (per-clip trim → interleaved `concat` → `drawtext` overlays → H.264/AAC mp4
  with `+faststart`).
- Render queue: one ffmpeg child at a time, FIFO, job persisted through `sqliteStore`
  (`workspace-video-job`), statuses `queued|running|done|error|canceled`, progress 0–100,
  cancellation of queued or running jobs.
- `streamVideoFile` supports HTTP Range/ETag for seeking.

### Routes — `src/server/routes/workspaceVideo.ts`
Signature matches the shared contract: `handleWorkspaceVideoRoutes(req, res, p, ctx)`.

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/api/workspace/video/file?taskId&path` | — | raw bytes, Range supported |
| PUT | `/api/workspace/video/file?taskId&path` | body bytes | `{saved,bytes,mtime}` |
| GET | `/api/workspace/video/edl?taskId&path` | — | sidecar JSON |
| GET | `/api/workspace/video/meta?taskId&path[&probe=1]` | — | `{bytes,mtime,duration?,hasAudio?}` |
| GET | `/api/workspace/video/hydrate?taskId&path` | — | `{edl,persisted,bytes,mtime,duration?,hasAudio?}` |
| POST | `/api/workspace/video/render` | `{taskId,path,edl}` | `202 {jobId,status,progress,output}` |
| GET | `/api/workspace/video/render/:jobId` | — | job incl. `output` (new file path) |
| DELETE | `/api/workspace/video/render/:jobId` | — | `{canceled,status}` |

All paths resolve through `taskPath` (traversal/symlink guarded). Non-GET requests require a
same-origin / non-cross-site origin. Rendered files are siblings: `<base>.edit.mp4`,
`<base>.edit-2.mp4`, ...

If mounting in a tree where `src/server/http.ts` is not yet patched (this worktree already is,
commit `f75176c`), add exactly:

```ts
import { handleWorkspaceVideoRoutes } from "./routes/workspaceVideo.js";
```

```ts
if (await handleWorkspaceVideoRoutes(req, res, p, { workspace: cfg.workspace })) return;
```

## Verification

- `npx tsc --noEmit` → 0 errors.
- `npx tsc --noEmit -p packages/web/tsconfig.json` → 0 errors.
- `npx tsx --test src/server/__tests__/workspaceVideo.test.ts src/server/__tests__/workspaceVideoRoutes.test.ts`
  → 13/13 pass (includes a real ffmpeg cut+overlay render when ffmpeg-static is present, plus
  route save/read, traversal rejection, render validation, cross-site guard, progress parsing).
- `npm run check:encoding` → OK.
- `npm run build` in `packages/web` fails with the known worktree Turbopack
  `Could not find the Next.js package (next/package.json)` junction error, as documented for
  this environment; rely on web `tsc`.

### Commits on `mf/wsv`
- `d2c96e2` detect audio + interleave concat inputs
- `038f91f` same-origin mutation guard; cheap stat meta poll
- `4222905` overlays use output timeline; live poll after hydrate
- `7d66ea1` concat interleaving + EDL aliases tests
- `f8e5041` route tests
- `efe93b1` / `36b9c66` ffmpeg `-progress` (ms/us)
- `62dcce2` cancel running render
- `b0fcaa9` / `7e545d5` progress tests
- plus `02c982a` (auto checkpoint of videoRender)

## How to test live
1. Run the server + web app (`npm run dev`, `npm run dev` in `packages/web`).
2. Create a task with a video in its workspace (e.g. copy an `.mp4` into the task folder).
3. Register the video editor in the shell and open the `.mp4` (`.mp4`/`.mov`/`.webm`/…).
4. Trim/split/reorder, add an overlay, press `Apply`; watch progress and the preview switch to
   `<name>.edit.mp4`.
5. While the task is running, overwrite the source file and confirm the preview refreshes within
   ~3s.
6. Type a chat instruction and confirm the task receives `Edit <path>: <instruction>`.

## Left / notes
- Shell-owned files (`types.ts`, `registry.ts`, `WorkspacePanel.tsx`, `workspace/index.ts`) are
  not present in this worktree; `video/register.ts` already matches the shared contract.
- EDL is persisted as a sidecar next to the video (`<file>.edl.json`); the render output is a new
  sibling mp4 and never overwrites the source.
- Overlays use the rendered/output timeline (concatenated), not source time; trims after adding
  an overlay do not retime it (basic editor scope).
