# Loam benchmark harness (`bench/`)

A reproducible RAM benchmark for Loam coding sessions. It runs a **scripted fake
model** (no real API calls) and measures the process-tree working set of the
sessions it spawns, so memory regressions can be caught offline and in CI.

Adapted from jcode (MIT, Copyright (c) 2025 Jeremy Huang). See
`packages/web/public/marketplace/THIRD_PARTY_NOTICES` for the license entry.

## What is here

| File | Role |
|---|---|
| `bench/fakeModel.ts` | Scripted OpenAI-compatible server: `/v1/chat/completions` (SSE + non-stream JSON), `/v1/models`, `/api/tags`, `/api/version`. Replays a configurable turn sequence (default: `read` -> `edit` -> `bash` -> final text) driven by the number of `tool` messages in the request. Default port **11435** so it never clashes with real Ollama on 11434. |
| `bench/rssSampler.ts` | Samples the total working set / RSS of a process tree at a fixed interval. Windows: one streaming PowerShell snapshot per sample. Linux: `/proc/<pid>/stat` for the tree plus `smaps_rollup` for PSS. Returns `idleMB`, `peakMB`, `finalMB`. |
| `bench/memBench.ts` | Orchestrator: generates a tiny repo with an `add()` bug, spawns `N` sessions of a pluggable launcher, samples memory, and prints a JSON report with a per-session threshold gate. |
| `bench/appRamBench.ts` | J6 app-level variant: drives a fixed scenario (a chat run + a large memory-store POST per iteration) against the local server over loopback and reports the process-tree growth plus the server's own bounded-cache counters. Use `npm run bench:ram:app`. |
| `bench/__tests__/` | Unit tests (`node --import tsx --test`). |
| `bench/results/` | Recorded baseline measurements. |

## Quick start

```bash
# One offline session (built-in node-echo launcher fixes calc.py itself)
npm run bench:mem -- --n 1 --launcher node-echo

# Ten sessions, longer sampling window, also write the JSON report
npm run bench:mem -- --n 10 --sample-ms 12000 --json-out bench/results/J2-baseline.json

# Show all flags
npm run bench:mem -- --help

# Unit tests
npm run test:bench
```

## J6 app-RAM benchmark

```bash
# Drive the fixed scenario against the real local server, write the JSON report
npm run bench:ram:app -- --iterations 25 --json-out bench/results/J6-after.json

# Or drive an already-running server instead of spawning one
npm run bench:ram:app -- --base-url http://127.0.0.1:3947 --iterations 4
```

`bench/appRamBench.ts` starts `src/index.ts` as a child (auth disabled, port
3947 by default, override with `--port`), waits for `/api/health`, then runs the
scenario: each iteration opens a chat run (a fresh task, SSE stream and
transcript) and posts a large memory-store entry. It then samples the process
tree and reads the server's bounded-cache counters back from
`GET /api/debug/memory`. The report records `idleMB`, `peakMB`, `finalMB`,
`growthMB` and the cache totals, so a bounded cache shows a plateau while an
unbounded one shows monotonic growth. It exits non-zero when `growthMB` exceeds
`--threshold` (default 64 MB).

### Isolated server data dir

The server takes an exclusive lease on `<data dir>/manus.db` and refuses to
start while another process holds it, so the harness never points the child at
the app's live `data/`. By default each run gets a fresh temp dir
(`loam-bench-data-<pid>-<rand>` under `%TEMP%`) that is removed after the run;
pass `--data-dir <path>` to use your own.

### Provenance

Each report records `sourceCommit` (`git rev-parse HEAD`, suffixed `-dirty` when
the tree has uncommitted changes) and `debugRoutePresent` (whether
`/api/debug/memory` answered 200). The BEFORE measurement is taken on a clean
detached worktree at the base commit with the harness committed on top, so its
provenance is distinct from the AFTER run. `bench/__tests__/appRamBench.test.ts`
asserts the committed pair is self-consistent, so a hand-edited or stale result
file fails the test suite.

### Options (this harness)

| Flag | Default | Notes |
|---|---|---|
| `--spawn` | off | Start the real server (`src/index.ts`) first, then stop it. |
| `--port <n>` | 3947 | Port for the spawned server. |
| `--base-url <url>` | from `--port` | Drive an already-running server instead. |
| `--iterations <n>` | 25 | Scenario iterations (one chat run + memory POST each). |
| `--fixture-chars <n>` | 200000 | Characters per memory-store POST. |
| `--threshold <mb>` | 64 | Fail (exit 1) when `growthMB > threshold`. |
| `--sample-ms <ms>` | 4000 | Sampling window. |
| `--interval-ms <ms>` | 100 | Interval between samples. |
| `--data-dir <path>` | fresh temp | Data dir the spawned server owns (must be isolated). |
| `--ready-timeout-ms <ms>` | 120000 | How long to wait for `/api/health` (cold Node + tsx can be slow). |
| `--json-out <path>` | - | Also write the JSON report here. |
| `-h, --help` | - | Print the help text. |

The flags in the next table (`-n`, `--launcher`, `--cwd`, `--keep-cwd`) belong
to `bench/memBench.ts`, not this harness.

## Options (bench/memBench.ts)

| Flag | Default | Notes |
|---|---|---|
| `-n, --n <count>` | `1` | Number of sessions. Try `1`, `10`, `30`. Also `LOAM_BENCH_N`. |
| `--launcher <name>` | `node-echo` | Built-in offline launcher. Any other name uses the pluggable launcher. |
| `--threshold <mb>` | `250` | Fail (exit 1) when `perSessionMB > threshold`. Also `LOAM_BENCH_THRESHOLD_MB`. |
| `--sample-ms <ms>` | `4000` | Sampling window. Each sample costs one OS snapshot. |
| `--interval-ms <ms>` | `100` | Interval between samples. |
| `--cwd <dir>` | generated | Reuse an existing repo instead of generating one. |
| `--keep-cwd` | off | Do not delete the generated repo. |
| `--json-out <path>` | - | Also write the JSON report here. |
| `-h, --help` | - | Print the help text. |

## Launchers

`node-echo` is the built-in, fully offline launcher: it is a small Node program
that applies the `add()` fix and exits, so it exercises spawning, sampling and
the report path with no network and no model.

To benchmark a real coding CLI, set `LOAM_BENCH_LAUNCHER_FILE` to the executable
and pass its name as `--launcher`. The child receives the fake model URL as
`OPENAI_BASE_URL` (and `OPENAI_API_KEY=mock`); run `bench/fakeModel.ts` alongside
it so it has a scripted model to talk to:

```bash
# 1. start the fake model
node --import tsx bench/fakeModel.ts &      # or: LOAM_BENCH_FAKE_MODEL_URL

# 2. point the launcher at it
set LOAM_BENCH_LAUNCHER_FILE=opencode
set OPENAI_BASE_URL=http://127.0.0.1:11435
npm run bench:mem -- --n 10 --launcher opencode
```

The launcher is spawned as `<file> <cwd> <index>` with the session repo as cwd.

## Report shape (memBench)

```json
{
  "launcher": "node-echo",
  "N": 1,
  "idleMB": 156.6,
  "peakMB": 160.3,
  "finalMB": 160.3,
  "perSessionMB": 3.7,
  "fixed": 1,
  "sessions": [{ "index": 0, "cwd": "...", "pid": 37264, "exitCode": 0, "fixed": true, "output": "" }],
  "thresholdMB": 250,
  "thresholdExceeded": false,
  "durationMs": 7921,
  "platform": "win32",
  "notes": []
}
```

`perSessionMB` is `(peakMB - idleMB) / N`, i.e. the memory cost attributed to
each session. `fixed` counts sessions whose `calc.py` ended up with
`return a + b`.

## Baseline

`bench/results/J2-baseline.json` holds one recorded offline run
(`node-echo`, `N=1`). Numbers are machine-specific; treat them as a reference
point, not a budget.

### J6 before/after

`bench/results/J6-before.json` and `bench/results/J6-after.json` are the
committed pair for the J6 bounded-cache change, measured with identical
parameters (4 iterations, `--sample-ms 4000`, `--interval-ms 100`, port 3948):

| Metric | BEFORE (base commit) | AFTER (J6) |
|---|---:|---:|
| `idleMB` | 538.4 | 548.5 |
| `peakMB` | 538.4 | 548.5 |
| `finalMB` | 476.4 | 458.2 |
| `growthMB` | 0 | 0 |
| `cacheCount` | 0 | 39 |
| `cacheEntries` | 0 | 2 |
| `debugRoutePresent` | false | true |
| `thresholdExceeded` | false | false |

The `growthMB` of 0 in both runs is the point: the scenario is designed so a
leak shows as `finalMB` staying near `peakMB` after the workload ends, and
neither run does. The AFTER row additionally proves the J6 surface is live: the
debug route answers 200 and 39 bounded caches are registered (one counter row
per cache, plus the per-run stall-guard rows). The ~10 MB `idleMB` difference
is the cost of the new module graph being loaded; it is one-time startup, not
per-iteration growth.

## Notes

- The sampler uses one OS snapshot per sample. On Windows a snapshot costs a
  PowerShell process (~0.5-1s), so short `--sample-ms` windows may only produce
  one sample; use a window comfortably larger than the interval when you need
  a peak.
- Windows reports the working set; Linux reports PSS. The two are not identical,
  so compare numbers within a platform.
- No real model API is called anywhere in the harness or its tests.
- The J6 scenario's memory-store POST returns 500 in both runs. That is expected:
  the bench posts to `/api/memory`, which needs a store the throwaway data dir
  has not been seeded with. The chat run (200) is the workload that matters, and
  the bounded-cache counters are read over a separate debug route.
