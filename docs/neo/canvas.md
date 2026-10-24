# Canvas (EN)

The Canvas is the Workspace tab that draws a run as a graph instead of a vertical transcript. It is the view Loam opens on its own when a run produces its first node, and it is available for any task whether or not that run has produced one.

Related: [README.md](README.md) · [recipe.md](recipe.md) · [knowledge-garden.md](knowledge-garden.md) · [missions.md](missions.md)

---

## What you are looking at

Each step the agent takes becomes a **node**. Each node is typed, so you can tell a search from a document from a question at a glance:

| Type | Meaning |
|---|---|
| `question` | The request the run is answering |
| `recipe_step` | One planned step of the Recipe |
| `search` | A web or connector search |
| `document` | A generated document (versioned) |
| `webpage` | A generated webpage |
| `media` | An image, video or audio artefact |
| `ask_user` | A question the agent paused to ask you |
| `complete` | The run finished |
| `sibling` | One arm of a multi-model A/B comparison |
| `branch` / `merge` | A fan-out branch, and the node that collects it |
| `note` | A free note you added |
| `failed` | A step that failed cleanly |
| `round` | One round of a recurring wake-up |
| `kb_seed` | A Knowledge Garden seed the agent cited |

Nodes carry a **status**: `init` (not started), `running`, `finished`, `failed`, `skipped`. Edges show the order: an edge means the lower node was produced using the one above it.

## Reading the run

- **Pan and zoom.** Drag empty canvas to pan, scroll or use the zoom controls to zoom. The minimap in the corner shows where you are in the whole graph.
- **Organize.** Re-lays the graph out so no two nodes overlap. Loam keeps the position you moved a node to, so organizing never undoes your arrangement.
- **E opens node detail.** Select a node and press `E` (or use the panel action) to open the detail view on the right, where a document's versions, diff, Knowledge Garden preview and webpage artefact actions live.
- **Search.** The search box highlights the nodes whose text matches, so you can find a step in a run with two hundred nodes.
- **Keyboard sheet.** The shortcut control lists every key binding the canvas supports. Nothing is hidden behind a gesture you have to guess.

## Your own layer: annotations

Everything you add lives on the server as an annotation, never inside the agent's run record. The agent's history stays exactly what the agent wrote.

- **Colour tags.** Tag a node blue, green, amber, red or violet to mark it for yourself. `None` is a real choice, not a gap.
- **Comments.** Start a thread on a node. A comment thread is per node and is visible to anyone who can open the run.
- **Free notes.** Drop a note anywhere on the surface, move it, edit it, or delete it.

## Editing the run as context

Editing a node is not cosmetic. It changes what the agent sees next:

- **Edit** replaces a node's text with a new version; the downstream nodes are marked stale so you know they were built on the old text.
- **Cut** removes an edge, so the node above is no longer passed to the step below.
- **Duplicate** makes a copy as a new branch.
- **Group** selects several nodes into one merged context for the next step.

Because these are context edits, they are also how you correct a run: fix a node, cut the bad edge, and let the next step rebuild from the corrected state rather than from the transcript.

## Webpage and document nodes

A document node keeps **versions**. The detail view shows the diff between two versions and lets you push a version into a Knowledge Garden base, which records the node as the seed's provenance.

A webpage node can be **opened in a sandbox tab** or **downloaded as a ZIP** containing `index.html` and its assets, so the page opens offline.

## If it does not look like this

- **The tab is empty.** A run with no graph shows the empty state, not an error. The Canvas draws only what the run has produced; an ordinary question-and-answer run has no nodes.
- **The tab is missing.** The Canvas is drawn when `runGraph.enabled` is true, which is the default. If your build turns it off, the tab is not rendered.
- **A node's status will not change.** Status comes from the run's own events. If the agent is stuck, the node is stuck; the Canvas is not ahead of the run.
- **Annotations do not appear for someone else.** Annotations are stored with the run and are shared with anyone who can open it, but the Canvas is a local, single-user surface. There is no live multi-user collaboration.
- **A cut edge did not change the model's input.** A cut takes effect on the *next* step. A step that already ran keeps the context it was given.

## Honest limits

- The Canvas is a projection of the run, not a second source of truth. If you edit a node, the edit is recorded as an annotation and a new version, and the original run events are left alone.
- Layout is automatic. Loam lays the graph out so nodes do not overlap and keeps your manual positions, but it does not let you arrange nodes into a hand-drawn picture.
- A run that is stopped mid-step keeps its partial state. Restarting from a step regenerates that step and everything downstream; it does not replay the steps above it.
