# OPI handoff report — options #15, #16, #19, #20

Branch `mf/opi` (worktree `C:\Users\khamis\Desktop\mf-wt\opi`). All work committed; nothing pushed.

## Commits

| Commit | What |
|---|---|
| `0bb341f` | feat(home): promo carousel slides from `/promos.json` + composer pre-fill (#15) |
| `d34a9e5` | wip checkpoint (UNIMPLEMENTED_OPTIONS.md context copy, first templates.json) |
| `437ffdc` | feat(home): template gallery dialog with search + category filter (#16) |
| `28f513d` | feat(voice): mic → STT proxy + SpeechSynthesis voice mode (#19) |
| `d78f939` | feat(notifications): store + hooks + routes + tests (#20) |
| `f362ab1` | feat(sidebar): notification bell + devices → /app/computers (#20) |
| `6cb2f34` | i18n: Arabic strings for gallery/voice/notifications |

## #15 Home promo banner carousel

- `packages/web/public/promos.json` — content source: `[{ title, subtitle, prompt, image }]`.
- `packages/web/src/components/home/PromoBanner.tsx` — fetches `/promos.json` (fallback to the previous hard-coded slides if unavailable), keeps the existing visuals/interval; clicking CTA pre-fills the composer with `prompt` (falls back to the title) via the existing `onSelect` → `prefillComposer` in `packages/web/src/app/app/page.tsx`.

## #16 Template gallery

- `packages/web/public/templates.json` — 24 templates: `{ category, title, prompt, icon, image }` (categories: Website, App, Slides, Docs, Image, Video, Sheets, Research; images reuse the existing `/templates/*.svg`).
- `packages/web/src/components/home/TemplateGalleryDialog.tsx` — portal dialog with search box (matches title+prompt), category filter chips, 3-col grid; selecting a template calls `prefillComposer(tpl.prompt)` and closes.
- `packages/web/src/app/app/page.tsx` — template row is now `grid-cols-4` with a "More templates" card opening the dialog.

## #19 Voice

- STT server facts (read-only, `scripts/stt_server.py` untouched): `POST /transcribe` (raw audio body → `{segments:[{start,end,text}],...}`), `GET /health`; default port `3941` (`python stt_server.py <port> <model>`). The server-side convention is `LOAM_STT_URL`, default `http://127.0.0.1:3947` (see `src/server/voiceTranscript.ts:28` and `src/scripts/check-companions.ts:1584`), so start it as `python scripts/stt_server.py 3947` or set `LOAM_STT_URL`. An agent-scoped proxy already existed at `POST /api/agents/:agentId/voice/transcribe`; it requires an existing agent, so I added a composer-level proxy (below).
- `src/server/routes/voice.ts` — `handleVoiceRoutes(req,res,p,ctx)`: `POST /api/voice/transcribe` (raw `application/octet-stream` body ≤25MB) → reuses `transcribeAudio()` → `200 { segments, text }` (text = joined transcript), `400` empty/malformed body, `502 { error }` when the STT server is unreachable.
- `packages/web/src/components/chat/useVoiceTranscribe.ts` — MediaRecorder hook (webm/opus with fallbacks), states `idle|recording|transcribing`, posts the bytes to `/api/voice/transcribe`, returns the transcript to the composer.
- `packages/web/src/services/speech.ts` — SpeechSynthesis wrapper: `speak/stopSpeaking/isSpeaking`, chunks long/markdown text.
- `packages/web/src/components/chat/Composer.tsx` — the existing mic button now records (click again stops+transcribes; spinner while transcribing; transcript appended at the cursor end); the existing voice-mode button toggles TTS (persisted in `localStorage['agent-studio:voice-mode']`, `aria-pressed`); while ON it speaks each new assistant reply, clicking again stops speech (stop control). Both buttons now render in home, task and agent-thread composers (`hidden sm:flex` preserved). New prop `assistantReply?: string` supplies the latest reply.
- `AgentThreadView.tsx` and `TaskPageClient.tsx` pass their existing `assistantText` as `assistantReply` (2-line localized edits).

## #20 Bell notifications

- `src/server/notifications.ts` — store in the existing sqlite `entities` table, kind `"notifications"`, record `{ id, kind, title, body, taskId, readAt, createdAt }` with kinds `task-done | task-failed | approval-pending | schedule-failed`. 10-second same-event dedupe, read retention pruning at 200. API: `createNotification`, `notifyTaskStatus`, `notifyScheduleFailed`, `notifyApprovalPending`, `listNotifications`, `unreadNotifications`, `markNotificationRead`, `markAllNotificationsRead`, `toApi`.
- Minimal hooks: `src/server/db.ts` `setTaskStatus` (done/error, outside the transaction), `completeTaskRun` (done), `recordScheduleOutcome` (final "failed" state only — not the first retry, outside the transaction); `src/server/approvals.ts` `createApproval` (pending approval).
- `src/server/routes/notifications.ts` — `handleNotificationsRoutes`:
  - `GET /api/notifications?unread=1&limit=N` → `{ notifications: [{ id, kind, title, body, task_id, read_at, created_at }], unread }` (newest first, default limit 100)
  - `POST /api/notifications/:id/read` → `{ ok, notification, unread }` (404 unknown id)
  - `POST /api/notifications/read-all` → `{ ok, affected, unread }`
- `packages/web/src/components/shell/NotificationBell.tsx` — sidebar bell: unread badge (polls every 20s), dropdown list with kind chips, per-item mark-read on open, "Mark all read", footer link to computers. `Sidebar.tsx`: devices icon now links to `/app/computers` (was `/app/devices`), bell replaced by `<NotificationBell />`.
- Tests: `src/server/__tests__/notifications.test.ts` (node:test; 6 cases: create/dedupe, list/unread/limit, mark-read idempotent, read-all, empty title rejection) — pass; full `src/server/__tests__` suite 42/42 pass.

## http.ts mounts for the supervisor (per parallel-worktree rule I did NOT edit src/server/http.ts)

Add after the other route imports (`src/server/http.ts` ~line 78):

```ts
import { handleNotificationsRoutes } from "./routes/notifications.js";
import { handleVoiceRoutes } from "./routes/voice.js";
```

Add one dispatch near the other route dispatches (~line 1631, right after `if (await handleSchedulesRoutes(req, res, p)) return;`):

```ts
if (await handleNotificationsRoutes(req, res, p)) return;
if (await handleVoiceRoutes(req, res, p)) return;
```

Verified live in a throwaway harness (not committed): mounting exactly this pattern and exercising the endpoints gives — task hook fires on `setTaskStatus(id,"done")`, GET returns the API shape above, `:id/read` sets `read_at` and decrements `unread`, `read-all` zeroes it, unknown id → 404, `POST /api/voice/transcribe` → 502 typed error with STT down, empty body → 400, non-matching paths fall through (`false`). 11/11 PASS.

## New routes/tools

No new agent tools were needed (no ALWAYS_ON_TOOLS/approvals changes; #19/#20 are HTTP+UI, not model-facing tools). New HTTP routes as listed above.

## Verification

- `npx tsc --noEmit` (root/server): 0 errors.
- `npx tsc --noEmit -p packages/web/tsconfig.json`: 0 errors.
- `npx tsx --test src/server/__tests__/*.test.ts`: 42/42 pass (includes the new notifications tests and the untouched schedulerRetry suite, proving the db.ts hooks didn't regress).
- `npm run build` in `packages/web`: fails with the known worktree Turbopack `Could not find next/package.json` (node_modules is a junction to the main checkout) — per the task brief, web tsc is the gate here.
- `npm run check:encoding` not re-run on ar.json edit — file remains valid UTF-8 JSON (parsed + tsc clean).

## How to test live

1. Supervisor adds the 2 imports + 2 dispatch lines to `src/server/http.ts`, restarts the server (`npm run dev`).
2. Start STT: `python scripts/stt_server.py 3947` (or set `LOAM_STT_URL`), verify `http://127.0.0.1:3947/health`.
3. Home: carousel rotates through `promos.json`; clicking a slide fills the composer. "More templates" opens the gallery; search/filter/select pre-fills.
4. Composer mic: click → allow mic → speak → click again → transcript appended. Voice icon: toggle on, run a task; the assistant reply is spoken; click again to stop.
5. Bell: run a task to completion or fail one (or create an approval-gated action) → unread badge appears; open dropdown, mark read / all read. Devices icon goes to `/app/computers`.
6. API smoke: `curl :3939/api/notifications` etc.

## Left / limitations

- `setTaskStatus("done")` and `completeTaskRun` both notify; the 10s dedupe window absorbs double-emits, and a genuinely later re-run still notifies again.
- Approval notifications are created when the approval is requested; deciding it does not auto-clear the feed entry (per feed semantics; the approvals center remains the decision UI).
- The mic sends MediaRecorder webm/opus; faster-whisper decodes via PyAV — if the deployed Python env lacks PyAV the STT server itself errors (surfaced as the typed 502).
- Bell item click marks read and routes to `/app/computers` (same target as the devices icon); deep-linking a notification to its task session is future work since session uids are client-generated.