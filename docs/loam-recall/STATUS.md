# Loam Recall status

Branch: `feat/loam-recall-second-look` from `origin/main` (`cab46c2`).

| Phase | State |
|---|---|
| P0 | Evidence refresh written. The dirty `feat/model-registry` checkout was left in place so unrelated work was not discarded and release artifacts were not committed. |
| P1 | Schema, repo, normaliser, BM25, LSH |
| P2 | Fusion, rerank, MMR, activation, injection |
| P3 | Ingest, link, redaction, idle queue |
| P4 | Decay, forget, gardener, dream, core memory |
| P5 | Agent tools, stdio MCP server, launcher |
| P6 | Legacy migration, store mirror, runtime wiring |
| P7 | Second Look read and run modes |
| P8 | Settings Memory controls and Second Look pane, stream chip |
| P9 | 23 unit tests passed (`node --import tsx --test` on the recall, review, and MCP suites) and `tsc --noEmit` is clean. Live timings are in LOAD.md. |
| P10 | Merged into local `main`. Not pushed. No backup branch was created, so there was no archive to delete. |

Follow-up on the same branch: keyword search uses FTS5, decay writes in one transaction, run mode waits for a probe, node probes run under `--permission`, and changing the embedder starts a re-embed whose progress is on the Memory settings pane. That pane was not opened in a browser. A larger sleep was not timed because no generator was loaded.

Clean room: implementation follows the behaviour spec only.
