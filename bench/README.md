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
| `bench/perProcess.ts` | J1 **BEFORE** launcher: one heavyweight `node --import tsx` process per coding session, the shape Loam's coding launcher has today (`code_session` -> one agent process per task). Runs one Loam agent session against the fake model. |
| `bench/launchers.ts` | J1 **launcher bench**: runs both shapes against the same fixture and fake model, samples them together, and reports per-session and *marginal* per-session cost. Also the CLI that writes `bench/results/J1-*.json`. |
| `bench/rssSampler.ts` | Samples the total working set / RSS of a process tree at a fixed interval. Windows: one streaming PowerShell snapshot per sample. Linux: `/proc/<pid>/stat` for the tree plus `smaps_rollup` for PSS. Returns `idleMB`, `peakMB`, `finalMB`. |
| `bench/memBench.ts` | Orchestrator: generates a tiny repo with an `add()` bug, spawns `N` sessions of a pluggable launcher, samples memory, and prints a JSON report with a per-session threshold gate. |
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

# J1: shared vs per-process launcher (mock model, offline)
npm run bench:j1 -- --n 1,10,30 --before-out bench/results/J1-before.json --after-out bench/results/J1-after.json
```

The command exits non-zero when `perSessionMB` exceeds the threshold (default
250 MB), so it can gate a CI job.

`npm run bench:j1` additionally gates the J1 target: each *additional* shared
session must cost less than **10 MB** (`MARGINAL_SESSION_TARGET_MB`). Only the
shared shape is gated; the per-process shape is the BEFORE baseline.

## Options

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

## J1: shared vs per-process launcher

The J1 question is whether Loam can stop paying a whole Node process per coding
task. `npm run bench:j1` measures both shapes against the *same* generated
fixture and the *same* scripted fake model, so the difference is the launcher
shape rather than the model:

| Shape | What it is | Entry point |
|---|---|---|
| `per-process` (BEFORE) | one heavyweight `node --import tsx` process per session, today's `code_session` behaviour | `bench/perProcess.ts` |
| `shared` (AFTER) | **one** long-lived server process hosting N concurrent sessions over a control socket | `src/server/sharedCodeSession.ts` |

```bash
# Full N=1,10,30 matrix, writing the committed BEFORE/AFTER result files
npm run bench:j1 -- --n 1,10,30 \
  --before-out bench/results/J1-before.json \
  --after-out  bench/results/J1-after.json

# Just the AFTER shape, at one N
npm run bench:j1 -- --kinds shared --n 10

# Show all flags
npm run bench:j1 -- --help
```

| Flag | Default | Notes |
|---|---|---|
| `-n, --n <list>` | `1,10,30` | Comma-separated session counts, run ascending. |
| `--kinds <list>` | `per-process,shared` | Launcher shapes to run. |
| `--sample-ms <ms>` | `4000` | Sampling window; each sample costs one OS snapshot. |
| `--interval-ms <ms>` | `100` | Sample interval. |
| `--cooldown-ms <ms>` | `8000` | Pause between measurements, so the OS can reclaim the previous run's processes. `0` disables it. Measurements are isolated per process regardless. |
| `--json-out <path>` | - | Write the combined before/after report here. |
| `--before-out <path>` | - | Write only the per-process reports (one per N). |
| `--after-out <path>` | - | Write only the shared reports (one per N). |
| `-h, --help` | - | Print the help text. |

The command exits non-zero when any session failed to fix the fixture, or when a
shared session's **marginal** cost (`(peakMB - baselineMB) / (N - 1)`, where
`baselineMB` is the same launcher's peak at N=1) reaches `MARGINAL_SESSION_TARGET_MB`
(10 MB).

Each measurement runs in its **own child process**, launcher-outer (all
per-process, then all shared), with a cooldown between them. Both guards exist
because of the same trap: a shared run that shares a process with a per-process
run that just peaked at ~4.2 GB measures ~36 MB/session, because V8 grows the
shared server's heap in response to the memory pressure it can see. Measured in
its own process the same run costs ~3 MB/session. Without the isolation and the
cooldown the AFTER number describes the measurement order, not the launcher.
`runJ1Bench({ isolateEach: false })` opts out for tests that assert on the
in-process spawn order.

`bench/results/J1-before.json` and `J1-after.json` hold the committed numbers
for N=1/10/30. They are arrays of `LauncherReport` (one entry per N).

The sampler window (`--sample-ms`, default 4000) is a **backstop**, not a cap:
sampling stops as soon as the run's work is done, and a run that outlasts the
window is sampled for its full duration. That matters because N=30 spends ~45s
settling its 30 sessions one by one; a window that capped the run truncated the
peak at 1.49 GB where the real peak is 2.56 GB.

## Report shape

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

## Notes

- The sampler uses one OS snapshot per sample. On Windows a snapshot costs a
  PowerShell process (~0.5-1s), so short `--sample-ms` windows may only produce
  one sample; use a window comfortably larger than the interval when you need
  a peak.
- Windows reports the working set; Linux reports PSS. The two are not identical,
  so compare numbers within a platform.
- No real model API is called anywhere in the harness or its tests.
