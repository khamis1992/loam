# bench/lazy-senior — A/B harness for the coding-discipline levels

Measures **Loam's own** before/after numbers for the lazy-senior discipline:
the same fixture task runs on the local model with the level `off` and `full`,
and `run-ab.ts` reports the deltas between those two arms and nothing else.
No external benchmark's figures appear here, in the results, or in any UI.

## Run

```
node --import tsx bench/lazy-senior/run-ab.ts
```

Env knobs: `LOAM_AB_MODEL` (default `qwen36-uncensored-hauhau:latest`),
`LOAM_AB_OLLAMA` (default `http://127.0.0.1:11434`), `LOAM_AB_RUNS`
(default 3 per arm), `LOAM_AB_KEEP=1` keeps the last staging copy.

## What the task measures (T1, reuse-first)

The fixture `fixtures/reuse-form` is a tiny form app that already has an
`Input` component and a `validateEmail` helper. The task is: *"Add an email
field to the signup form."* A run passes the reuse check when the final
`SignupForm.tsx` uses the existing `validateEmail`/`Input` and no new
component file was created.

## Reading the results

`results/ab-<timestamp>.json` keeps every run's metrics; the script prints a
markdown table with medians per arm (output tokens, wall-clock, turns, files
touched, lines added) and the reuse pass count. Caveats, stated plainly:
small N, one fixture, one local model, and the agent also runs commands —
so the wall-clock delta is diluted by fixed process time. Treat the numbers
as a trend to re-measure, not a guarantee.
