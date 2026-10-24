# Loam long-horizon guide (EN)

This guide covers the four long-horizon surfaces of Loam: the **Canvas** that shows a run as a graph, the **Recipe** the agent plans step by step, the **Knowledge Garden** you fill with sources the agent can cite, and **Missions**, which are runs without a fixed step cap.

Every behaviour described here is the behaviour shipped in this build. Where a feature is off by default, the guide says so and names the setting that turns it on. Where a provider has to be configured first, the guide names the provider instead of implying it works out of the box.

Start here: [canvas.md](canvas.md) · [recipe.md](recipe.md) · [knowledge-garden.md](knowledge-garden.md) · [missions.md](missions.md)

Arabic edition: [docs/neo/README.ar.md](README.ar.md) · [دليل لُوام للمهام الطويلة (عربي)](README.ar.md)

---

## 1. What "long horizon" means here

A Loam task is not limited to a single answer. When the request is open-ended, Loam plans a **Recipe** of steps, executes them one at a time, and draws each step on the **Canvas** as a typed node. Outputs live on their nodes rather than in the transcript, so a run with two hundred steps does not need two hundred steps of context to continue.

Two things make that work, and both are worth understanding before you run anything large:

- **Per-step context selection.** Before each step, Loam picks the prior node outputs, Knowledge Garden seeds and memories that step actually needs, inside a token budget. The rest of the transcript stays on its nodes, available when a later step asks for it. Selection is on by default (`contextSelector.enabled`); the context compressor still runs when the selected set is too large.
- **Budgets instead of caps.** An ordinary run is capped by `agent.maxSteps` (40 by default). A **Mission** lifts that cap and is bounded instead by a budget of steps, tokens, wall-clock time and cost, checkpointed after every step.

## 2. The four surfaces at a glance

| Surface | Where it lives | What it is for |
|---|---|---|
| Canvas | Workspace tab of a task | The run graph: nodes, edges, layout, annotations, node detail |
| Recipe | Canvas side panel | The agent's step list, its remaining-step estimate and the restart point |
| Knowledge Garden | Settings › Knowledge Garden | Named bases of retrievable **seeds** the agent can cite, plus the per-run toggle in the composer |
| Missions | A run type, plus Automations for wake-ups | Unbounded runs bounded by a budget, resumable after a restart |

The Canvas, the Recipe and the Knowledge Garden toggle are all reachable without leaving the task. Mission behaviour is a property of the run, so it is described from the run's side: [missions.md](missions.md).

## 3. Reading this guide

- **Bold terms** are the names the UI uses. When the guide says *Knowledge Garden*, the settings section is called exactly that.
- Each page ends with a **"If it does not look like this"** section listing the honest failure states: what the UI shows and what to check. Loam does not hide a provider problem behind an empty success message, and neither does this guide.
- Arabic readers: the Arabic edition is a translation of this text, not a summary. Both editions carry the same headings and the same cross-references, so switching language never loses your place.

## 4. Prerequisites

| Surface | Needs | Notes |
|---|---|---|
| Canvas | `runGraph.enabled` (default on) | The tab is always available; a run with no graph shows the empty state instead of an error |
| Recipe | a run using Recipe mode | The Recipe panel is drawn from the run's own events, so it stays truthful for any run |
| Knowledge Garden | none to browse; a memory embedder for vector search | Without the embedder, search runs lexically only and new seeds are stored without vectors. The settings page says so in a notice |
| Missions | nothing to start; a restart-survivable store for resume | Checkpoints are written after every step and survive a server restart |

## 5. Quick start

1. Open a task and send a request that needs more than one step, for example "research three vendors and draft a comparison page".
2. The Canvas tab opens on its own when the run produces its first node. If it does not, open it from the Workspace panel.
3. While the run is going, use the Recipe panel to watch the step list and the remaining-step estimate.
4. Fill a Knowledge Garden base with a document the agent should know about, then turn on the honeycomb toggle in the composer for the next run. Cited seeds appear on the Canvas as **knowledge seed** nodes.
5. To let the same request keep working across wake-ups, ask for a Mission and set a budget instead of a step count. See [missions.md](missions.md).

## 6. Honest limitations

- Loam runs locally. A run stops when the machine stops, unless the mission checkpoint is resumed. Auto-resume is off by default (`recovery.autoResume`).
- External sends stay behind the approval gate. A Mission that is supposed to email a report asks for approval first; it does not send silently.
- The Canvas is a local, single-user view. There is no realtime multi-user collaboration; sharing a run produces a read-only replay.
- Knowledge Garden retrieval is hybrid: lexical always, vector only when the memory embedder is available and has embedded the seeds. A base imported while the embedder is off cannot be searched by meaning until it is re-embedded.
