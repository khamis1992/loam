# Load

Measured on this PC on 2026-11-03. The embedding model was `nomic-embed-text:latest`. No generator was loaded (`ollama ps` was empty), so the 22 GB hauhau model was not started. Rerank, read-mode review, and the nightly GPU cycle stay unmeasured. The deadline and the circuit breaker are covered by the unit suite.

| Item | Estimate | Measured |
|---|---|---|
| Search, 200 real nomic memories, p50 of 20 queries | under 50 ms | 18 ms, including the query embedding |
| Search, 10k synthetic memories, p50 of 10 queries | 5–30 ms | 550 ms. In-process BM25 walks every latest row; the vectors were 8 dimensions, so this is not the 768-dimension disk case |
| Decay over those 10k rows | about 1 s | 5.8 s |
| Disk, 200 nomic memories | – | 244 KB |
| Disk, 10k synthetic memories | 60–80 MB at 768 dimensions | 4.6 MB at 8 dimensions |
| Process RSS after the 10k run | +60–120 MB for the store | 470 MB for the whole Node process |
| Rerank p50 | 1.5–3.5 s, deadline 3.5 s, auto-off above 3 s over 20 calls | not measured |
| Read-mode review p50 | 20–50 s | not measured |
| Nightly cycle | 2–8 min | not measured |

DD-4 stays at a 3.5 s deadline with the circuit breaker. DD-12 stays at read for build, write, data and legal, and off for ask, chat and research. Legal cannot be set to run.
