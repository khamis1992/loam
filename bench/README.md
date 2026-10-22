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

The command exits non-zero when `perSessionMB` exceeds the threshold (default
250 MB), so it can gate a CI job.

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
