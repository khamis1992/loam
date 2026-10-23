# Coding eval harness

The measuring stick for the Claude-Code parity work (task C18). It runs the Loam
coding agent headless on 20 small, self-contained fixture repos and reports
`pass@1`. Run it **before and after every merge** that touches the agent, the
prompt, the tools or the sandbox: a drop here is a regression, not a vibe.

## Layout

```
evals/coding/
  tasks/<id>/task.json     metadata: prompt, category, language, testCommand
  tasks/<id>/files/        the starting tree (this is what the agent sees)
  tasks/<id>/tests/        hidden grader (never present while the agent runs)
  tasks/<id>/reference/    reference solution overlay
  BASELINE.md              the recorded baseline note
  baseline.json            the recorded baseline numbers
  results/                 generated sandboxes + reports (gitignored)
```

A fixture is one of three categories:

- `bug-fix` — the starting tree is broken; the agent repairs it.
- `refactor` — the tree works but has a smell (duplication, weak naming, mixed
  concerns); the agent reshapes it without changing behaviour.
- `add-test` — the tree ships no tests; the agent writes real ones.

Languages: TypeScript and JavaScript for most tasks, Python for a few.

## Commands

```bash
npm run eval:coding                          # agent mode: the real benchmark
npm run eval:coding -- --self-check          # offline: reference solutions, must all pass
npm run eval:coding -- --baseline            # offline: untouched trees, must all fail
npm run eval:coding -- --only=task-001,task-005
npm run eval:coding -- --mode=agent --min=0.8
npm run eval:coding -- --record-baseline     # refresh BASELINE.md / baseline.json
npm run test:coding-eval                     # unit tests for the harness itself
```

`--mode=agent` (the default) drives the configured model through the coding agent
with the coding tool profile, then grades the sandbox. It is only meaningful when
a model is reachable; it is not a unit test. `--self-check` and `--baseline` are
the offline CI gates: they apply no model at all and finish in seconds.

Grading is the fixture's `testCommand` exit code plus a handful of file
assertions (`requireFiles`, `forbidPatterns`, `expectExit`), so a pass is
objective. `add-test` fixtures go further: the grader mutates the source and
requires the agent's new tests to fail, so a test that only asserts `true`
cannot pass.

## Baseline

`BASELINE.md` and `baseline.json` record the committed evidence. Re-record with
`--record-baseline` after any fixture change. The self-check baseline is 20/20:
every fixture and its hidden test agree. The real-agent baseline is the number to
track across merges; it is only valid while the recorded model is reachable.

The `agent` mode in this environment had no reachable model at recording time
(no API keys, no local Ollama), so the committed baseline is the offline
self-check result. Re-record with a reachable model to capture the real
benchmark:

```bash
npm run eval:coding -- --mode=agent --record-baseline
```
