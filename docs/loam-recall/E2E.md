# Loam Recall and Second Look — end-to-end checklist

Run these on this PC only when you want a live model pass. The automated suites do not call Ollama.

1. Say «اسمي خميس وأفضل التقارير بالعربي». In a new session ask «وش اللغة اللي أفضلها؟». Expect a recall. Change the preference and check that the old row is `superseded` with an `UPDATES` edge.
2. Seed 200 synthetic memories. Search p50 should be under 50 ms, and rerank should finish inside its deadline or switch itself off.
3. Force a sleep tick (`gardener.tick('sleep', { force: true })`) and read `recall_gardener_runs`.
4. Point Cursor at `bin/loam-recall-mcp.cmd` and recall the preference. Writes stay off until `LOAM_RECALL_MCP_WRITE=1`.
5. Ask for a function with a planted quantity-0 bug. Read mode should flag it. Run mode should reproduce it inside `%TEMP%\loam-review-*` and delete that copy.
6. Send a chat turn that changes no files. Expect no Second Look.
7. Compare measured load with the estimates in the build spec and record them in `LOAD.md`.
