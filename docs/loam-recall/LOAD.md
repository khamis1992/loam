# Load

Measured on this PC on 2026-11-03. Embeddings used `nomic-embed-text:latest`. The generator was `qwen36-uncensored-hauhau:latest`, already installed. The first classification call used a 4k context and hit the 15 s limit while the model moved to the 32k context. After a 32k warmup the same path finished.

| Item | Estimate | Measured |
|---|---|---|
| Search, 200 real nomic memories, p50 of 20 queries | under 50 ms | 18 ms, including the query embedding |
| Search, 10k synthetic memories, p50 of 10 queries | 5–30 ms | 550 ms. In-process BM25 walks every latest row; the vectors were 8 dimensions, so this is not the 768-dimension disk case |
| Decay over those 10k rows | about 1 s | 5.8 s |
| Disk, 200 nomic memories | – | 244 KB |
| Disk, 10k synthetic memories | 60–80 MB at 768 dimensions | 4.6 MB at 8 dimensions |
| Process RSS after the 10k run | +60–120 MB for the store | 470 MB for the whole Node process |
| Generator warmup to a 32k context | – | 39 s, then the reply was `ok` |
| Rerank p50, 7 searches, model already warm | 1.5–3.5 s, deadline 3.5 s | 490 ms. Every call returned scores. The gate is 3.5 s |
| Read-mode review p50, 3 calls, one small file | 20–50 s | 1.6 s. A real `return 10` bug was reported as a finding in 1.2 s |
| Run-mode review, one call, same bug | 45–180 s | 1.2 s. The model gave a finding on the first round and did not ask for a probe |
| Sleep tick, 2 memories, forced | 2–8 min on a full night | 1.8 s. Decay, forget, NREM, REM, and reflection all returned. Reflection took 1.8 s. This is not a 10k-memory night |
| Preference round trip | recall, then an update supersedes the old row | Stored «اسمي خميس وأفضل التقارير بالعربي», search returned it, and the update left the old row `superseded` |
| MCP recall | the preference comes back, writes stay off | `memory_recall` for «خميس» returned the updated Arabic preference |

DD-4 stays at a 3.5 s deadline with the circuit breaker. The measured rerank p50 is under that deadline. DD-12 stays at read for build, write, data and legal, and off for ask, chat and research. Legal cannot be set to run. A turn with no tools in ask mode is skipped as `off`.
