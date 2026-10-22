# MF7 — URL-change triggers (`url-watch`) — handoff report

Branch: `mf/mf7` (worktree). All commits local, never pushed.

## Commits
1. `b431fe1` feat(url-watch): url-watch trigger core + watch_url tool + always-on grant (MF7)
2. `a0701b6` feat(url-watch): watches routes module (mount lines for supervisor in report) (MF7)
3. `492a01f` test(url-watch): fake-fetch poll loop tests + selector/regex + connector mock + always-on exposure (MF7)
4. `48e4f32` feat(web): URL watches section in Routines tab with add/delete form (MF7)
5. `65e9993` feat(url-watch): GitHub issues connector via GITHUB_TOKEN/GH_TOKEN (MF7)
6. `146a6e5` test(url-watch): github-issues connector unit test with stubbed fetch (MF7)
7. `018664a` feat(url-watch): schedule_list exposes url-watch state fields (MF7)

## Files
- **New**: `src/server/urlWatch.ts` (core: extraction, hash, unified diff, poll loop, connector registry, GitHub-issues connector), `src/server/routes/watches.ts`, `src/server/__tests__/urlWatch.test.ts`
- **Minimal edits in shared files**: `src/server/db.ts` (Schedule kind union + `watchSelector`/`watchConnector`/`lastWatchHash`/`lastWatchSnippet`/`lastWatchCheckedAt`/`lastWatchChangedAt`, `getSchedule()`, `updateUrlWatchState()`), `src/server/scheduler.ts` (1 line: skip `url-watch` kind — its poller fires it, prevents double runs), `src/index.ts` (start/stop poller + `registerBuiltInConnectors()`), `src/server/runTools.ts` (`watch_url` in ALWAYS_ON_TOOLS), `src/tools/loamServices.ts` (`watch_url` tool + extended `schedule_list`), `packages/web/src/components/agents/AgentInfoPane.tsx` (WatchesSection in Routines tab), `packages/web/src/i18n/en.json`, `ar.json`

## SUPERVISOR MOUNT LINES for src/server/http.ts (never edited here)
Near the other `/api/agents` handlers (e.g. next to the `handleSchedulesRoutes` dispatch at line ~1633):

```ts
import { handleWatchesRoutes } from "./routes/watches.js";
```
```ts
        if (await handleWatchesRoutes(req, res, p)) return;
```

## Routes / tools (exact names and shapes)
- `GET /api/agents/:id/watches` → `{ watches: [{ id, url, intervalMinutes, intervalSeconds, selector, prompt, enabled, agentId, lastCheckedAt, lastChangedAt, lastHash, snippet, lastTaskId }] }`
- `POST /api/agents/:id/watches` `{ url, intervalMinutes?, selector?, prompt }` → `201 { watch: {...} }`; `400` invalid url/prompt (unclamped interval below 5 min clamps to 5).
- `DELETE /api/watches/:id` → `{ ok: true }` (deletes a url-watch schedule)
- Agent tool `watch_url` (always-on): `{ url, intervalMinutes?, selector?, prompt }` → string; lists via `schedule_list` (now includes `kind`, `url`, `selector`, `lastWatchCheckedAt`, `lastWatchChangedAt`); delete via existing `schedule_delete {id}`.
- Connector hook: `watchConnector(kind, fetcher)` / `getConnector` / `listConnectors()` in `urlWatch.ts`; built-in live connector `github-issues` (`githubIssuesFetcher`, `owner/repo[:label]` or a full API URL; uses `GITHUB_TOKEN`/`GH_TOKEN`) registered at boot via `registerBuiltInConnectors()`.

## Behavior
- Poll loop (30s tick) checks each enabled non-archived url-watch schedule once per its interval (min 5 min). Fetch with 20s timeout → text extraction (full page, or `#id`/`.class`/`tag` selector, or `/re/g`/`re:re`) → sha-256 hash. First read records a baseline only. On change: in-flight run protection, prompt = base prompt + short unified diff (LCS, context 2, line caps) + current excerpt → one task for the schedule's agent via the scheduled-run path. Unchanged → no model call.
- Same loop serves connector watches (watchConnector routes content); a missing connector skips with a log line.

## Tests / verification
- `npx tsx --test src/server/__tests__/*.test.ts` → 34 pass / 0 fail (6 tests new in `urlWatch.test.ts`: unchanged→no task; changed→exactly one task with diff; selector/regex extraction; interval clamps; connector mock; effective-run-tool exposure; github fetcher unit with stubbed fetch).
- `npx tsc --noEmit` (root) and `npx tsc --noEmit -p packages/web/tsconfig.json` → 0 errors.
- `packages/web` build fails with the **known** worktree Turbopack `Could not find next/package.json` junction error (as the task notes; relied on web tsc).

## How to test live
1. Supervisor mounts the 2 lines above; then `POST /api/agents/<agentId>/watches` with `{url: "https://loam.local/x", intervalMinutes: 5, prompt: "summarize changes"}`.
2. Or via agent chat (always-on): "watch_url {url:'https://…', prompt:'الجُملة'}", then `schedule_list`.
3. Routines tab shows the watch with url / interval / last checked / last changed and the add-watch form.
4. Simulate change: `github-issues` connector watch on a busy repo (e.g. `nodejs/node`), or point the url at a locally changing page.

## Left / notes
- Routes are NOT mounted (http.ts owned by another tool) — UI + API live only after the supervisor adds the 2 lines.
- URL watches are stored in the flexible entities store (no schema migration needed).
- Web `npm run build` blocked by the known worktree Turbopack issue (not this feature).
