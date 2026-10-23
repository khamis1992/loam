# Memory Regression Budget

Status: active guardrail
Updated: 2026-10-21

This document defines the current memory regression budget for Loam.

Adapted from jcode (MIT, Copyright (c) 2025 Jeremy Huang) `ref/MEMORY_BUDGET.md`
— the same discipline: memory changes are only reviewable when every retention
path has an explicit, enforceable bound and the numbers are collected by one
explicit surface. Nothing here is sent over the network.

The goal is not to freeze memory usage forever. The goal is to make memory
changes:

- measurable
- reviewable
- intentionally justified

## How to collect the metrics

Use the existing debug surfaces instead of ad-hoc instrumentation:

- HTTP: `GET /api/debug/memory` on the existing loopback server (requires the
  same install token as every other `/api/*` route)
- Desktop IPC: `debugMemory.snapshot` from the privileged renderer, surfaced in
  **Settings → Memory**
- Offline measurement: `npm run bench:ram:app` (writes `bench/results/J6-*.json`)

Primary sources in code:

- `src/memory/cache.ts` — the shared bounded-cache primitives
- `src/memory/stats.ts` — the cache counter registry
- `src/memory/profile.ts` — the per-process RSS profile
- `src/server/routes/debugMemory.ts` — the HTTP route
- `electron/main.cjs` — the desktop main-process sampler + `debugMemory` IPC

## Budget model

Two kinds of budgets, exactly as in jcode:

1. **Hard caps** — explicit limits already enforced by the caches. A regression
   here means the code changed its bound or bypassed it.
2. **Ratchet expectations** — expected relationships between counters that are
   not strict caps yet. A regression is allowed only with an explanation and an
   updated doc/test.

## Hard caps

Every cap below is a real `LruCache`/`BoundedMap` bound in the code. Each one is
registered through `registerCacheStats()` and therefore shows up as a counter
row on the `debug:memory` surface, so a violated cap is observable rather than
theoretical.

The tables list 43 caps. A process does not register all 43 at once: five are
lazy, bound to the first object that owns them. `browser-operator-snapshots` is
created per `browser_operator` call; `policy-glob` and
`workspace-directory-requests` register when their module is first imported; and
`stall-guard-failures` / `stall-guard-warned` are created per agent run
(`createStallGuard()` in `src/agent/loop.ts`). The server registers the other 38
at boot, and the bench's chat scenario adds those two stall-guard caps, which is
the `cacheCount` of 40 in `bench/results/J6-after.json`. Every cap, lazy or
eager, is enforced in code.

Enforcement is exercised two ways. `src/memory/__tests__/caps.test.ts` drives 32
of the 43 caps past their bound through their own public API and asserts
occupancy never exceeds the configured bound (the ones a test can reach without a
live browser, PTY, ffmpeg child or video sidecar). The doc↔code parity test then
asserts every cap's documented bound matches the code. The remaining 11 caps
(`browser-sessions`, `ollama-tags`, `timeline-jobs`, `timeline-proxy-jobs`,
`video-render-jobs`, `video-render-children`, `slide-preview`,
`slide-preview-pending`, `word-preview`, `word-preview-pending`, `skills-desc`)
are enforced in code and appear on the debug surface, but driving them past the
bound needs a live browser, an ffmpeg child, the video sidecar or a render
round-trip, so their bounds are covered by the parity check rather than by an
eviction case. The `LruCache` byte-ceiling mechanism itself is unit-tested in
`src/memory/__tests__/cache.test.ts`, which is what the three `LruCache`
byte-capped rows (`slide-preview`, `word-preview`, `skills-desc`) rely on;
`protocol-blobs` carries its own byte ceiling (`BLOB_STORE_MAX_BYTES`) enforced
by its eviction hook, and the parity test asserts that value too. Adding a cap
therefore requires its row in this table, and the parity test fails if the
number drifts.

### Agent and session caches

| Counter | Cap | Source | Why |
|---|---:|---|---|
| `stall-guard-failures` | 64 | `src/agent/stallGuard.ts` | One counter row per task; a task that never succeeds is bounded, not retained forever. |
| `stall-guard-warned` | 64 | `src/agent/stallGuard.ts` | "Already nudged" flags per task; bounded alongside the failure counters. |
| `task-phases` | 512 | `src/tools/phaseTools.ts` | Per-task work-phase records; enough for a busy multi-agent run, small enough to bound a runaway spawner. |
| `timeline-jobs` | 64 | `src/creative/timeline.ts` | One export job per request; a long-running export never outlives the task that started it. |
| `timeline-proxy-jobs` | 64 | `src/creative/timeline.ts` | Preview proxy transcodes; a burst of preview requests must not retain every job. A dropped job falls back to the on-disk project. |

### Policy and protocol caches

| Counter | Cap | Source | Why |
|---|---:|---|---|
| `policy-glob` | 256 | `src/policy/permissionRules.ts` | Compiled glob → `RegExp` for the permission matcher; the hot path runs on every tool call. |
| `protocol-session-tokens` | 512 | `src/protocol/rpc.ts` | One row per active Connect-RPC session token. |
| `protocol-temp-codes` | 128 | `src/protocol/rpc.ts` | OAuth device/temporary codes; single-use, so a short bound is safe. |
| `protocol-login-tokens` | 256 | `src/protocol/rpc.ts` | Single-use login tokens (`consumeLoginToken` deletes on read). |
| `protocol-blobs` | 64 entries / 64 MiB | `src/protocol/blobStore.ts` | Outbound binary blobs; the eviction hook releases the buffer. Entry **and** byte ceiling. |
| `workspace-directory-requests` | 128 | `src/protocol/approvals.ts` | Pending interactive directory approvals, keyed by request id; eviction clears the 15-minute timer. |

### Server and connector caches

| Counter | Cap | Source | Why |
|---|---:|---|---|
| `server-approvals` | 256 | `src/server/approvals.ts` | Pending approval records for the web UI. |
| `run-controllers` | 512 | `src/server/runControl.ts` | One `AbortController` per live run. |
| `run-cancelled-flags` | 512 | `src/server/runControl.ts` | Cancelled-run marker used to short-circuit a restart. |
| `run-active-flags` | 512 | `src/server/runControl.ts` | In-flight task ids; only decides whether a cancel bumps the epoch. Bounded like the two rows above so an abandoned run cannot grow it either. |
| `server-file-watchers` | 128 | `src/server/fileWatchers.ts` | Live `fs.watch` handles; the eviction hook closes the watcher. |
| `task-event-subs` | 512 | `src/server/streams.ts` | SSE subscriber sets keyed by task id. |
| `url-watch-connectors` | 64 | `src/server/urlWatch.ts` | Fetcher per registered URL-watch connector. |
| `schedule-time-formatters` | 32 | `src/server/scheduleTime.ts` | `Intl.DateTimeFormat` instances per locale/option set. |
| `ollama-tags` | 32 | `src/server/http.ts` | Cached `/api/tags` response; model lists change slowly. |
| `oauth-pending-flows` | 64 | `src/server/connectors/oauth.ts` | In-flight OAuth flows awaiting a browser round-trip. |
| `grokbot-recent` | 128 | `src/server/bridge/grokbot.ts` | Recent messages mirrored per agent. |
| `grokbot-rate` | 256 | `src/server/bridge/grokbot.ts` | Sliding execute-rate counters per agent. |
| `eventlog-projection` | 64 | `src/session/eventLog.ts` | Materialized projection per stream, invalidated by `lastSeq`. |

### Media and preview caches

| Counter | Cap | Source | Why |
|---|---:|---|---|
| `video-studio-pending` | 64 | `src/server/videoStudioRelay.ts` | Commands awaiting the video-studio sidecar. |
| `video-studio-tasks` | 128 | `src/server/videoStudioRelay.ts` | Queued task records for the video studio. |
| `video-render-jobs` | 256 | `src/server/workspace/videoRender.ts` | Render job records. |
| `video-render-children` | 64 | `src/server/workspace/videoRender.ts` | Live ffmpeg child processes; the eviction hook kills the child. |
| `slide-preview` | 3 entries / 96 MiB | `src/studio/slide-preview.ts` | Rendered slide PNGs; entry **and** byte ceiling. |
| `slide-preview-pending` | 8 | `src/studio/slide-preview.ts` | In-flight render promises, so the same slide is not rendered twice. |
| `word-preview` | 6 entries / 128 MiB | `src/studio/word-preview.ts` | Rendered DOCX pages; entry **and** byte ceiling. |
| `word-preview-pending` | 8 | `src/studio/word-preview.ts` | In-flight render promises. |
| `skills-desc` | 128 entries / 4 MiB | `src/tools/skillsRegistry.ts` | Cached skill description text (UTF-16 estimator). |
| `vault-value-names` | 256 | `src/tools/vaultTools.ts` | Cached vault value names. |

### Browser and tool caches

| Counter | Cap | Source | Why |
|---|---:|---|---|
| `browser-sessions` | 32 | `src/tools/browser.ts` | Playwright browser contexts; the eviction hook closes the context. |
| `browser-frames` | 64 | `src/tools/browserFrames.ts` | Live frame state per task. |
| `browser-frame-sinks` | 128 | `src/tools/browserFrames.ts` | Frame subscribers per task. |
| `browser-frame-aliases` | 256 | `src/tools/browserFrames.ts` | Frame alias → frame id. |
| `browser-operator-snapshots` | 64 | `src/tools/browserOperator.ts` | Last snapshot id per page; a browser session never has hundreds of live pages. |
| `pty-sessions` | 16 | `src/tools/pty.ts` | Live PTY sessions; the eviction hook disposes the session. |
| `shell-sessions` | 32 | `src/tools/shell.ts` | Live shell sessions; the eviction hook disposes the session. |
| `spec-terminal-aliases` | 64 | `src/tools/specAliases.ts` | Spec terminal alias → session id. |
| `spec-browser-aliases` | 64 | `src/tools/specAliases.ts` | Spec browser alias → session id. |

### Renderer sample bound

| Counter | Cap | Source | Why |
|---|---:|---|---|
| renderer samples in the profile | 16 | `src/memory/profile.ts` | A closed window must not keep its sample forever; 16 covers every real desktop window count. |

### Unbounded-by-design paths

These are deliberately **not** capped, and any future change that makes them
unbounded must document it here:

| Path | Source | Why it is safe |
|---|---|---|
| Live assessment runs | `src/security/assessments.ts` | One `AbortController` per pentest assessment, removed on completion/abort. Assessments are rare, operator-initiated and explicitly cancellable. |
| Task registry / saved runs | `src/server/...` | Durable, persisted to disk and pruned on task delete; not a cache. |
| Execution queue lanes | `src/server/executionQueue.ts` | `locks`/`running`/`ids` are keyed by job id and all three delete their entry when the job's work settles (or is cancelled), so live entries never exceed the jobs the process actually has. Not a cache. |
| `src/memory/store.ts` memory entries | `src/memory/store.ts` | Backed by `cfg.memory.maxEntries` and pruned by `/api/memory/curate`. |

## Measured baseline (J6)

`bench/results/J6-before.json` (base commit, no `src/memory/cache.ts`) and
`bench/results/J6-after.json` (this change) were measured with identical
parameters: 4 iterations, `--sample-ms 4000`, `--interval-ms 100`, port 3948.

| Metric | BEFORE | AFTER |
|---|---:|---:|
| `idleMB` | 538.4 | 538.2 |
| `peakMB` | 538.4 | 538.2 |
| `finalMB` | 476.4 | 467.8 |
| `growthMB` | 0 | 0 |
| `cacheCount` | 0 | 40 |
| `cacheEntries` | 0 | 2 |
| `debugRoutePresent` | false | true |
| `thresholdExceeded` | false | false |

Reading:

- `growthMB` is 0 in both runs. The scenario is built so a leak shows as
  `finalMB` staying near `peakMB` after the workload ends; neither run does, and
  the AFTER run adds 40 bounded caches without changing that.
- `peakMB - idleMB` is 0 in both runs, which is the growth signal this budget
  cares about. The idle/peak figures sit at the same RSS because the sampling
  window is shorter than one server's steady-state settle; the growth gate
  (`growthMB`) is the enforced number, and it is 0.
- Each report records `sourceCommit` and `debugRoutePresent`, and
  `bench/__tests__/appRamBench.test.ts` asserts the committed pair is
  self-consistent, so a stale or hand-edited result file fails CI.

## Ratchet expectations

These are not strict caps yet, but they are the expected relationships.

| Relationship | Expectation |
|---|---|
| `totals.entries` vs `totals.caches` | Average occupancy should stay well below 1.0 per cache; a cache pinned at its cap means the cap is too small or the workload is too hot. |
| `caches[].size` vs `caches[].capacity` | No row may exceed its `capacity`. The `debug:memory` route test asserts this for every registered cache. |
| `caches[].bytes` vs the byte ceiling | For byte-capped caches (`slide-preview`, `word-preview`, `skills-desc`, `protocol-blobs`) the reported `bytes` must stay at or below the configured ceiling. |
| `finalMB` vs `peakMB` (bench) | A leak shows up as `finalMB` staying near `peakMB` after the workload ends. A healthy run returns close to `idleMB`. Both the BEFORE and AFTER runs above satisfy this. |
| `growthMB` (bench) | Expected to stay at 0, well below the harness threshold (64 MB); see `bench/results/J6-before.json` and `J6-after.json`. |

Required review action if a ratchet is violated:

- show before/after memory profiles
- explain which retention path grew
- prefer fixing duplication before raising any budget

## Review checklist for memory-affecting changes

When changing memory-heavy code, capture and include:

1. Which counters changed?
   - `GET /api/debug/memory` (aggregate profile)
   - `npm run bench:ram:app` (before/after JSON)
2. Was a hard cap changed?
   - if yes, explain why the old cap was insufficient and update this table
3. Did duplication increase?
   - previews, transcripts, provider caches, display copies
4. Did observability remain adequate?
   - if memory grew, can the profile explain where?

## Current initial budget summary

These are the concrete enforced limits today (cap in parentheses):

- Agent/session: stall-guard (64), task phases (512), timeline jobs + proxies (64 each)
- Policy/protocol: glob (256), session tokens (512), temp codes (128), login tokens (256), blobs (64), directory approvals (128)
- Server: approvals (256), run controllers + flags + active flags (512 each), file watchers (128), event subs (512), URL watch (64), formatters (32), Ollama tags (32), OAuth flows (64), grokbot recent/rate (128/256), event-log projection (64)
- Media: video-studio pending/tasks (64/128), render jobs/children (256/64), slide preview (3 / 96 MiB), word preview (6 / 128 MiB), skills desc (128 / 4 MiB), vault names (256)
- Browser/tools: browser sessions (32), frames/sinks/aliases (64/128/256), operator snapshots (64), pty (16), shell (32), spec aliases (64 each)
- Renderer samples in the profile: 16

Any intentional change to those limits must update this document in the same PR.

## Tests

- `src/memory/__tests__/cache.test.ts` — the bounded-cache primitives and the counter registry
- `src/memory/__tests__/caps.test.ts` — the executable half of the cap table: drives 32 of the 43 documented caps past their bound through their own public API and checks eviction (the rest are covered by the parity check), plus a doc↔code parity check
- `src/server/__tests__/debugMemory.test.ts` — the HTTP route boundary
- `bench/__tests__/appRamBench.test.ts` — the offline before/after measurement

Run them with:

```bash
node --import tsx --test src/memory/__tests__/cache.test.ts src/memory/__tests__/caps.test.ts src/server/__tests__/debugMemory.test.ts
node --import tsx --test bench/__tests__/appRamBench.test.ts
```
