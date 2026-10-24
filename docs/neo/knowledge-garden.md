# Knowledge Garden (EN)

The Knowledge Garden is where you keep sources Loam can cite. It lives in **Settings › Knowledge Garden** and it is per-base: a *base* holds *seeds*, and each seed is a short retrievable piece of text with tags, a title, a preview and a record of where it came from.

Related: [README.md](README.md) · [canvas.md](canvas.md) · [recipe.md](recipe.md) · [missions.md](missions.md)

---

## Bases and seeds

A **base** is a named collection, such as *Brand Voice* or *Research Notes*. A **seed** is one retrievable unit inside it: a paragraph-sized piece of text that the agent can pull into a run when it is relevant.

Every seed carries:

- **Title** and **body**, the text the agent reads.
- **Tags**, free-form, so you can group seeds by topic.
- **Provenance**, where the seed came from: the file, link, node or paste you imported it from.
- **An optional embedding**, used for vector search.

Think of a base as a folder and a seed as one index card in it. The agent does not read the whole base; it retrieves the cards that match the step it is on.

## Filling a base

Add seeds in three ways:

- **Paste text.** Type or drop text and add it as a seed.
- **From file.** A PDF, Markdown, plain text, DOCX, XLSX or PPTX document. It is split into seeds on sentence boundaries, with a smart split when the model can help and a fixed fallback when it cannot. A 20-page document produces many seeds, each tagged.
- **From a web link.** Loam fetches the page and splits it the same way.

You can also add a seed **from a node**: a document node's detail view has an "Add to Knowledge Base" action that creates a seed whose provenance is the node, so the run and the base stay linked.

## Turning it on for a run

A base is not read by every run automatically. In the composer, the **Knowledge Garden** toggle lets the current run read your bases. When it is on, the agent's search can retrieve seeds, and each seed it cites is drawn on the Canvas as a **knowledge seed** node linked to the step that used it.

That link is the useful part: you can see, step by step, which source the agent actually relied on, instead of trusting a summary that hides its sources.

## Searching

Search is **hybrid**:

- **Lexical** search always runs, matching words and phrases.
- **Vector** search runs when a memory embedder is available and has embedded the seeds.

When the embedder is not available, the settings page says so in a notice and search still works lexically. Seeds imported while the embedder is off are stored without vectors; re-embed them to make them searchable by meaning. A base imported without embeddings cannot be found by meaning until it is re-embedded.

Search returns the best-matching seeds, ranked. A query that names a fact usually returns the seed that states it near the top.

## If it does not look like this

- **A base is empty.** A base is only as good as what you put in it. Seeds are added by paste, file, link or from a node; nothing is imported on its own.
- **Search returns nothing relevant.** Check the toggle in the composer: the run must have the Knowledge Garden on to read your bases. Also check whether the embedder is configured; without it, only lexical matches work.
- **A seed has no embedding.** The embedder was off when the seed was imported, or embedding failed. The settings page shows the state; re-embed the base.
- **The agent cited a seed you did not expect.** The toggle was on and the seed matched. Follow the **knowledge seed** node on the Canvas to see which step used it.
- **Tags do not filter a run.** Tags are for you, to organise seeds. Retrieval is by relevance, not by tag.

## Honest limits

- Retrieval is not a guarantee of citation. The agent cites what it actually used; a seed in the base does not mean the agent read it.
- A large base is not read in full. Seeds are retrieved per step, so a run reads a slice of the base, not the whole thing.
- Splitting is a heuristic. Sentence-boundary splitting is deterministic and safe; the smart split is only as good as the model that produces it. Review the seeds of a long document if the exact boundaries matter to you.
- Knowledge Garden does not replace the transcript. Seeds are context the agent pulls in; the run's own history stays on its nodes.
