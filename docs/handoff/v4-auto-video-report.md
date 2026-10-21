# V4 report — Auto video features (clean-room FilmCraft reference)

Branch `mf/v4`. Commits: `0d3da41` auto.ts, `bc71bf6` auto tests, `30b31fa` route + http.ts mount, `d3a9235` route test.

## Files (all in scope)
- `src/creative/auto.ts` — pure TS helpers, NOTICE credit at top (Rakazo/Apache-2.0 "FilmCraft" design ideas, original code):
  - `detectScenes(diffs, {threshold,minSceneSeconds,duration})` → `Scene[]` (cuts at descending threshold-crossing frame-diff peaks, min-gap merge keeps the stronger cut).
  - `pickHighlights(scenes, energy, {targetSeconds,minClipSeconds,maxClipSeconds})` → `AutoClip[]` (score = 0.6·audio energy + 0.4·visual peak, long scenes split into maxClip windows, greedy fill of targetSeconds, last clip trimmed).
  - `computeReframe({width,height,aspect,subjects,start,end})` → `ReframeWindow[]` (pixel crop rect fitting target aspect, follows area-weighted subject centroid with linear interpolation between subject keyframes, edge-clamped, centered when no subjects).
  - `buildCaptions(segments, {maxChars,maxSeconds})` + `wrapCaptionText` → `CaptionCue[]` (word-wrap, hard-split oversized words, time split proportional to text, monotonic/overlap-clamped cue times).
  - `planAutoEdit(path, options, probe)` → `{scenes,clips,reframes,captions,warnings}` over the injected `MediaProbe` (all 4 lanes optional; each missing lane degrades with a warning).
  - `parseSceneLog`/`parseLoudnessLog` — pure ffmpeg-text parsers (shared by the live probe and fixtures).
- `src/creative/__tests__/auto.test.ts` — 21 tests, fixture probes only, no ffmpeg.
- `src/server/routes/autoVideo.ts` — `handleAutoVideoRoutes`; real probe lane spawns bundled `ffmpeg-static` (`fps+select scene metadata=print` / `ebur128`), 2 GB + timeout guards; `sanitizeOptions` exported (clamps/drops every client number).
- `src/server/__tests__/autoVideo.test.ts` — 4 tests for option sanitization.
- `src/server/http.ts` — **only 2 lines added** (import at line 81 `./routes/autoVideo.js`, dispatch after the schedules route line); http.ts was clean at edit time and committed immediately in `30b31fa`. If a merge conflict arises, these are the two lines to keep:
  ```ts
  import { handleAutoVideoRoutes } from "./routes/autoVideo.js";
  if (await handleAutoVideoRoutes(req, res, p)) return;
  ```

## API shapes
- `GET /api/auto-video/environment` → `{ffmpegAvailable:boolean, frameFps:number}`
- `POST /api/auto-video/plan` body `{taskId, path:"assets/timeline/<uuid>.mp4|webm|mov|m4v", options?}` →
  `200 {scenes:[{index,start,end,peak}], clips:[{start,end,score,sceneIndex}], reframes:[{start,end,crop:{x,y,width,height}}], captions:[{index,start,end,text}], warnings:[string]}`
  Errors are `400 {error}`.
- `options`: `threshold (0..1)`, `minSceneSeconds`, `duration`, `targetSeconds`, `minClipSeconds`, `maxClipSeconds`, `aspect (w/h, e.g. 9/16)`, `width`, `height`, `maxChars`, `maxCueSeconds`, `language`, `transcript:[{start,end,text}]`, `subjects:[{t,boxes:[{x,y,w,h} normalized]}]`.
- No new agent tools, so no runTools.ts/ALWAYS_ON_TOOLS change (the routes are HTTP-level; transcript/subjects are structured inputs — the STT/ML lanes stay pluggable).

## Live test
1. `npm run dev`, create a media task, upload a video via existing `/api/timeline/asset`.
2. `curl -X POST http://localhost:<port>/api/auto-video/plan -d '{"taskId":"<id>","path":"assets/timeline/<file>","options":{"aspect":0.5625,"targetSeconds":15,"transcript":[{"start":0,"end":3,"text":"hello world"}]}}'` → expect scenes/clips/reframes/captions with warnings for the omitted subject lane.
3. Without ffmpeg-static the route answers `400 ffmpeg is not available`.

## Verification
- `npx tsc --noEmit` (root): 0 errors. `npx tsc --noEmit -p packages/web/tsconfig.json`: 0 errors.
- `npx tsx --test src/server/__tests__/*.test.ts src/creative/__tests__/*.test.ts`: 80/80 pass.
- `npm run build` in packages/web fails with the known worktree Turbopack `next/package.json` junction error (pre-existing; web untouched by this task).

## Left / follow-ups
- STT adapter for `probe.transcribe` (e.g. wire the companion STT service) and an ML subject-detection adapter for `probe.subjects`; both slots already typed in `MediaProbe`.
- UI surface (timeline "auto-cut" button applying `plan.clips` as edits) — deliberately out of V4 file scope.
- Reframe smoothing is linear between subject keyframes; a velocity-damped tracker can replace `centroidAt` later.
