# Evidence refresh

Observed on `origin/main` at `cab46c2` before the recall edits. `manus-parity` is not a branch in this clone. Labels: OBSERVED.

| Symbol | OBSERVED file:line |
|---|---|
| `MemoryStore` class | `src/memory/store.ts:125` |
| `startMemoryDreamJob` | `src/memory/store.ts:542` |
| Embedder construction | `src/setup/runtime.ts:174` |
| `memory.model` default `nomic-embed-text:latest` | `src/config.ts:418` |
| `DatabaseSync` import | `src/server/sqliteStore.ts:3` |
| WAL pragma | `src/server/sqliteStore.ts:16` |
| `transaction` | `src/server/sqliteStore.ts:48` |
| `findSecret` | `src/memory/redact.ts:26` |
| `containsSecret` | `src/memory/redact.ts:33` |
| `assertNoSecret` | `src/memory/redact.ts:38` |
| `runAgent` | `src/agent/loop.ts:434` |
| System suffix | `src/agent/loop.ts:480` |
| End of turn when the model returns no tool calls | `src/agent/loop.ts:946` |
| Turn return after verification | `src/agent/loop.ts:997` |
| MCP client bridge | `src/tools/mcp.ts` (`registerMcpTools`) |
| BM25 helpers | `src/agent/contextSelector.ts` and `src/memory/hybrid.ts` |

FTS5 probe on Node v25.2.1: available (OBSERVED).

UNKNOWN: hauhau prefill speed. Not measured here.
