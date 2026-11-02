# Load

Live measurements against hauhau were not taken in this build. The acceptance checks that need the loaded model are listed in `E2E.md`.

| Item | Estimate | Measured |
|---|---|---|
| Rerank p50 | 1.5–3.5 s, deadline 3.5 s, auto-off above 3 s over 20 calls | not measured |
| Read-mode review p50 | 20–50 s | not measured |
| Nightly cycle | 2–8 min | not measured |
| Search on 10k memories | 5–30 ms | not measured |

DD-4 stays at a 3.5 s deadline with the circuit breaker. DD-12 stays at read for build, write, data and legal, and off for ask, chat and research. Legal cannot be set to run.
