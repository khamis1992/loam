# Phase one: task reliability

- Executor crashes, exhausted revisions, empty answers, and failed final verification propagate as errors. They do not emit `done` or enter the successful-task learning path.
- Invalid or unavailable verification requests revision. After the bounded final repair, a second verification must pass. Simple tasks still use direct execution without a critic.
- Follow-up runs copy the last 12 user/assistant messages before appending the new request. Planner, workers, and verifiers receive that context. Existing project and agent assignments are inherited when omitted. Unknown tasks and concurrent execution of the same running task are rejected.
- Ask mode exposes an explicit local read-tool allowlist. Shell, browser actions, delegated execution, unknown tools, and MCP tools are excluded. Command hooks, automatic mode switching, MiroFish execution, episodic recording, memory pruning/writes, and background skill improvement are disabled for Ask runs. Conversation and operational logs continue to be saved.
- Retrying or completing a task clears its previous error.

Validation: `npm run verify` runs type checking, encoding validation, evaluation harness tests, and deterministic orchestrator regressions, including malicious tool calls, hook bypass attempts, verifier outages, repair verification, and conversation continuity. These tests use a simulated model; they do not constitute a live-model or desktop UI end-to-end test.
