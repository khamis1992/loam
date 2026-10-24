# Missions (EN)

A Mission is a run with no fixed step cap. An ordinary run stops after `agent.maxSteps` steps (40 by default). A Mission lifts that cap and is bounded instead by a **budget** of steps, tokens, wall-clock time and cost, checkpointed after every step so it can survive a restart.

Related: [README.md](README.md) · [canvas.md](canvas.md) · [recipe.md](recipe.md) · [knowledge-garden.md](knowledge-garden.md)

---

## Why a Mission exists

Long work does not fit a step count. A task that takes 200 steps is not "40 steps and then it gives up"; it is a different shape of work that needs a different shape of bound. A Mission trades the step cap for a budget you can reason about in the units that matter to you: how many tokens, how long, how much money.

The budget is configured in `config.ts` under `mission`:

| Field | Meaning |
|---|---|
| `steps` | Step ceiling. `0` or omitted means unbounded steps |
| `tokens` | Token ceiling for the run |
| `minutes` | Wall-clock ceiling |
| `costUsd` | Cost ceiling in USD |

A Mission with no limits in any dimension is genuinely unbounded. The defaults are `{ steps: 0, tokens: 5_000_000, minutes: 0, costUsd: 0 }`, so the default Mission is unbounded in steps and wall-clock and capped only at five million tokens.

## Budget stops are clean ends

A Mission that hits its budget does not fail. It ends **cleanly**:

- The run stops at its last safe boundary, after the last completed step.
- A summary node is emitted explaining where the Mission got to, which of the budget dimensions it hit (if any) and the counters it burned.
- The Mission is resumable. Raise the budget and continue from the checkpoint; the Mission picks up where it stopped instead of starting over.

That distinction matters: a budget stop is a *planned* end, not a crash. The UI treats it as a completion, and the summary tells you what to do next.

## Checkpoints and restarts

After every completed step, the Mission writes a **checkpoint** recording:

- The step it reached.
- The prompt it is still working on.
- The budget counters burned so far.
- Why it last stopped, if it did.

The checkpoint is written to the durable store, so it survives a server restart. Kill the server in the middle of a Mission and, when it comes back, the Mission is resumable at its last checkpoint rather than lost.

Auto-resume after a restart is off by default (`recovery.autoResume`). When it is off, the Mission is resumed when you choose to, not silently in the background.

## Stop and pause

A running Mission can be stopped or paused from the task controls. Stopping records the checkpoint at the last safe boundary; pausing keeps the Mission ready to continue.

Stopping is not a failure. It is the same clean end as a budget stop, with a checkpoint you can resume from.

## Wake-ups

A Mission can be given a recurring wake-up: a schedule that resumes the same Mission with a new **round** node, so each wake-up is a visible step in the run rather than an invisible background tick. Each round's external sends, such as an email, go through the approval gate first.

Wake-ups are the mechanism behind recurring work: a weekly report, a tracker that checks something every hour, a research sweep that repeats until told to stop. The run graph shows each round as a node, so you can see how many times the Mission woke up and what each round produced.

## If it does not look like this

- **The run stopped at 40 steps.** The run is not a Mission. Ask for a Mission, or raise the budget. A step-capped run does not continue on its own.
- **The Mission stopped and the summary says "budget".** It hit one of its ceilings. The summary names which dimension and what was burned. Raise that dimension and resume.
- **The Mission did not resume after a restart.** Auto-resume is off by default. Resume it from the task controls; the checkpoint is there.
- **A round did not appear.** The Mission has no wake-up schedule, or the schedule was cancelled. Each round is a node on the Canvas; if there is no `round` node, no wake-up ran.
- **The Mission did not send the email it said it would.** External sends stay behind the approval gate. Check the pending approvals; the send is waiting, not lost.

## Honest limits

- A Mission is not a service. It runs on your machine, so it stops when the machine stops, unless the checkpoint is resumed.
- Budgets are ceilings, not guarantees of a finish. A Mission that never converges will keep burning budget until a ceiling is hit.
- Wake-ups resume the same Mission. They do not start a fresh run each time, so state carries across rounds.
- A Mission that is mid-step when stopped loses the in-flight step. The checkpoint is written after a step completes, so the partial step is not recovered.
