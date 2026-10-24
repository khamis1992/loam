# Recipe (EN)

The Recipe is the agent's step plan, shown live. It is the side panel of the Canvas: it lists the steps in order, marks the one that is running, shows the remaining-step estimate, and gives you the controls to pause, stop, and restart from a step.

Related: [README.md](README.md) · [canvas.md](canvas.md) · [knowledge-garden.md](knowledge-garden.md) · [missions.md](missions.md)

---

## What the Recipe is

Loam does not plan a whole run up front and then execute it blindly. After each step, the planner proposes the next step from the results, and the Recipe panel shows the plan as it grows. A step can be added, rewritten or dropped based on what the previous step produced, and the plan can grow for as long as the run's budget allows.

That is the difference between a Recipe and a fixed script:

- A fixed script fails if step 3 returns something unexpected, because step 4 was written before step 3 ran.
- A Recipe re-plans. If a tool fails, the planner re-routes to an alternative tool, and the Recipe shows the new step in place of the old one.

The panel shows:

- **The step list**, in execution order, with each step's status.
- **The remaining-step estimate**, so you can tell whether a run is nearly done or has hours to go.
- **Pause and Stop**, for the running step.

## Reading a step

Each step is a node on the Canvas as well as a line in the Recipe. The status is one of `init`, `running`, `finished`, `failed`, `skipped`. A step marked `failed` has failed cleanly: the run recorded the failure as a node and continues, rather than aborting the whole run.

A step can also be **re-routed**. When the planner replaces a step, the new step appears in the list where the old one was, and the old step is marked as dropped. Nothing is silently discarded.

## Restarting from a step

Restarting is the control that makes long runs recoverable. Choose a step and restart from it:

- The chosen step and everything **downstream** of it are regenerated.
- The steps **upstream** of it are not re-run. Their outputs are kept exactly as they were, so the tools above the restart point are not called again.
- The downstream nodes that were built on the old state are marked stale, so you can see what was regenerated.

Use it when a step produced something wrong and you want the run to rebuild from there, or when you want to try a different approach from a known-good point without paying for the steps above it again.

## When the agent asks you something

A step can be an **Ask User More** node. When the planner is not confident enough to continue, it pauses the run and asks you a structured question with options and an optional file upload. The run stays paused until you answer, and your answer plus any file are attached as context to the next step.

The run does not sit silently waiting for you to notice it. The node is drawn on the Canvas, the Recipe marks the step as waiting, and the question appears in the task view.

## If it does not look like this

- **The estimate does not decrease.** The estimate is the planner's count of steps it still expects. If it stays flat, the planner is adding steps at the same rate it finishes them. A run that keeps re-routing can grow; that is a signal to read the Recipe rather than to assume it will converge.
- **A step is marked failed and the run continued.** That is intended. A failed step is recorded as a node so the rest of the run can work around it. If every step fails, the run ends with a failure node rather than a silent success.
- **Restarting did not re-run the earlier steps.** That is intended. The steps above the restart point keep their outputs.
- **The Recipe panel is empty.** The panel is drawn from the run's own events. An ordinary question-and-answer run has no Recipe; a run using Recipe mode does.

## Honest limits

- The estimate is an estimate. It counts the steps the planner currently expects, not a guarantee of the run's total length.
- Re-planning is bounded by the run's budget. A Recipe can grow, but not without limit, unless the run is a Mission.
- Restart-from-step regenerates the downstream of the chosen node. It cannot un-run a side effect that the earlier steps already caused, such as a file written or a message sent.
