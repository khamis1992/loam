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
| P9 | 21 unit tests passed (`npm run test:recall`) plus the existing memory store suites. Live e2e and LOAD numbers were not measured: no model was downloaded and no GPU run was started. |
| P10 | This branch is the merge candidate for local `main`. |

Clean room: implementation follows the behaviour spec only.
