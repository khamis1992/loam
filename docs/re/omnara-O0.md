# O0 — Omnara durable event log: read-only recon of manus-local (manus-parity)

Task: `O0` (BUILD_SPEC §11 plan row, phase 0). Read-only recon. **No source file was
modified.** This report is the only committed artifact.

Baseline verified: worktree `om-o0`, branch `khamis1992/om-o0`, HEAD `a8130cc`
("merge khamis1992/devin-d2 (D2 via loam-jcode-run) into manus-parity").
`git rev-list manus-parity..HEAD` is empty, so this branch carries no commits of its
own yet; the recon was taken against the tree at `a8130cc`.

Method: `git grep` / `read` over the worktree only. Every claim below carries a
`file:line`. Paths are relative to the worktree root. `node_modules` was excluded from
all searches.

---

## U1 — `sqliteStore` `transaction` implementation and get/set metadata helpers

### `transaction` — exists, exact signature

`src/server/sqliteStore.ts:48-53`

```ts
export function transaction<T>(fn: () => T): T {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
```

- Signature matches the spec exactly: `transaction<T>(fn: () => T): T`
  (BUILD_SPEC §6.1 note, §13 E9).
- It uses **`BEGIN IMMEDIATE`** (not plain `BEGIN`), so a writer takes the write lock
  up front. `database()` opens the connection with
  `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;`
  (`src/server/sqliteStore.ts:16`).
- **`transaction` is NOT re-entrant.** A nested `transaction()` call would issue a
  second `BEGIN IMMEDIATE` on the same connection and throw
  `cannot start a transaction within a transaction`. BUILD_SPEC **U2** asked about
  nesting; the answer is **decision B: document no nesting**. Consequence for O1: the
  `append()` body must not call any helper that itself calls `transaction()`. The
  spec's `purgeSession` (§6.1) sets and deletes a `metadata` row *inside* its own
  transaction, which is fine (raw `prepare().run()`, no nested `transaction`).
- The connection is a single process-wide singleton (`src/server/sqliteStore.ts:10-19`),
  so `MAX(seq)+1` inside the transaction is race-free within one process, as the spec
  assumes. Cross-process safety comes from `acquireRuntimeLease()`
  (`src/server/sqliteStore.ts:83-95`, TTL record key `runtime-pid`).

### Metadata helpers — **do NOT exist as exports**

The `metadata` table is created at `src/server/sqliteStore.ts:18`
(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`),
but `sqliteStore.ts` exports **no** `getMeta`/`setMeta`. It only touches the table with
inline SQL:

- `src/server/sqliteStore.ts:22` — `SELECT value FROM metadata WHERE key='legacy-import'`
- `src/server/sqliteStore.ts:43` — `INSERT INTO metadata(key,value) VALUES('legacy-import','1')`
- `src/server/sqliteStore.ts:85` / `:93` / `:97` — `runtime-pid` read / upsert / delete

Private, non-exported copies of the same two helpers already exist in two other
modules (this is the duplication O2 should collapse, not extend):

- `src/server/credits.ts:98-105` — `getMeta(key)` / `setMeta(key, value)`
- `src/server/assets.ts:52-58` — `getMeta(key)` / `setMeta(key, value)`
- `src/memory/codeIndex.ts:260` — a `setMeta` that writes to an in-memory cache, **not**
  the SQLite `metadata` table (do not mistake it for the DB helper).

**Answer for O2:** `getMeta`/`setMeta` must be **added** to `src/server/sqliteStore.ts`
as two small exported functions over the existing `metadata` table. BUILD_SPEC §6.2
line 173 already anticipated this ("O0 confirms or O2 adds these two tiny helpers").

### Related store API (for O3)

`src/server/sqliteStore.ts` exports: `database` (`:11`), `transaction` (`:48`),
`putEntity` (`:54`), `getEntity` (`:58`), `allEntities` (`:62`), `removeEntity`
(`:66`), `closeDb` (`:69`), `resetDb` (`:78`), `acquireRuntimeLease` (`:83`),
`releaseRuntimeLease` (`:96`), `backupDatabase` (`:100`), `onDatabaseReset` (`:8`).
`dataDir()` comes from `src/config.ts:33-35` and honours `LOAM_DATA_DIR` /
`MANUS_LOCAL_DATA_DIR` (`src/config.ts:28-31`).

---

## U2 — `socket.ts` resume/replay handler

File: `src/protocol/socket.ts`.

- The socket is created in `createChatSocket(deps)` at `src/protocol/socket.ts:318`;
  `io.on("connection", ...)` at `:338`; the inbound handler is
  `socket.on("message", async (m: ClientMessage) => {` at `:341`.
- **Replay is driven by `join_session`, not by a dedicated `resume` event.** The
  branch is `if (m.type === "join_session") {` at `src/protocol/socket.ts:343`.
- The replay call is at **`src/protocol/socket.ts:345`**:

  ```ts
  let replay = store.eventsAfter(m.sessionId, m.lastMessageId);
  ```

- Fallback when the protocol store has no events: it synthesizes history from the
  Loam task (`buildHistoryFromTask`, defined at `src/protocol/socket.ts:273-316`,
  called at `:362`). The synthesized events are wrapped into an
  `eventsNotifyEventsAfter` envelope at `:372-387` and emitted with
  `noPersistent: true` (`:384`).
- **There is no `lastSeq` handling anywhere in `socket.ts`.** The only cursor field
  read is `m.lastMessageId` (`:345`, echoed back as `eventId` at `:383`).
- `ClientMessage` union: `src/protocol/types.ts:106-113`
  (`JoinSession | LeaveSession | UserMessage | StopSession |
  SubmitWorkspaceDirectoryAccess | ResolveLocalExecutionApproval |
  ResolvePlanApproval`). `JoinSession` is `src/protocol/types.ts:29-34` and carries
  `lastMessageId?: string` at `:32` and `version: 2` at `:33`. **No `lastSeq` field.**
- Server→client envelope `ServerEnvelope` is `src/protocol/types.ts:115-122`; it has
  `id`, `type`, `sessionId`, `timestamp`, `event`, `webdevAddonEnabled?` and **no
  `seq` field** (BUILD_SPEC §6.4 wants an optional `seq` added here).
- `ProtocolStore.eventsAfter` is `src/protocol/store.ts:122-128`. It replays with
  `findIndex` on `lastMessageId` (`:126`); an unknown id makes `findIndex` return `-1`
  and **everything is replayed** (`:127`), exactly as BUILD_SPEC §6.3 states.
- `ProtocolStore.appendEvent` is `src/protocol/store.ts:112-119`; it pushes to an
  in-memory array and schedules a whole-file JSON save (`scheduleSave` `:167-173`,
  100 ms debounce; `save` `:175-192`). This is the durability gap O3 removes.

**Answer for O4:** the replay branch to change is `src/protocol/socket.ts:343-389`
(the `join_session` handler), and the store method to add is
`ProtocolStore.eventsAfterSeq` in `src/protocol/store.ts`.

---

## U3 — Web client file that reconnects and sends `lastMessageId`

File: **`packages/web/src/services/chatSocket.ts`** (class `ChatSocket`).

- Reconnect is socket.io's own: `reconnection: true` with a 1 s→10 s backoff at
  `packages/web/src/services/chatSocket.ts:46-49`.
- The rejoin hook is registered on the `connect` event at
  `packages/web/src/services/chatSocket.ts:62` (`this.socket.on('connect', () => this.rejoin?.())`).
- `join(sessionId, lastMessageId?, getLastId?)` at
  `packages/web/src/services/chatSocket.ts:115-122` stores `this.rejoin` (`:116-120`),
  which re-emits `join_session` with `getLastId?.() ?? lastMessageId` on every
  reconnect.
- `emitJoin` builds the wire payload at
  `packages/web/src/services/chatSocket.ts:99-108`; `lastMessageId` is written at `:105`.
- `leave` clears the rejoin hook at `:125-133`.
- The shared wire type is `packages/shared/src/socket.ts:22-27` (`JoinSession` with
  `lastMessageId?: string` at `:25`); `ClientMessage` union at
  `packages/shared/src/socket.ts:70`.

**Callers that join a session (all currently pass no cursor):**

| Caller | Line | Cursor passed |
|---|---|---|
| `packages/web/src/app/app/[sessionUid]/TaskPageClient.tsx` | `:205` | none (`socket.join(sessionUid)`) |
| `packages/web/src/components/agents/AgentStartDialog.tsx` | `:79` | none |
| `packages/web/src/components/agents/AgentThreadView.tsx` | `:265` | none |
| `packages/web/src/components/agents/AgentThreadView.tsx` | `:323` | none |
| `packages/web/src/components/workspace/WorkspacePanel.tsx` | `:63` | none |
| `packages/web/src/components/workspace/WorkspacePanel.tsx` | `:116` | none |

**Answer for O4:** update `packages/web/src/services/chatSocket.ts` (add a `lastSeq`
parameter to `emitJoin`/`join` and a `getLastSeq` callback beside `getLastId`), and
update the `TaskPageClient.tsx:205` call site to supply the highest `seq` the UI has
rendered. The wire type must be extended in **both** `packages/shared/src/socket.ts:22-27`
and `src/protocol/types.ts:29-34`. BUILD_SPEC §6.4 decision **A** (update the client)
is the right one; decision B (server-only, via `seqOfId`) is not needed.

Note: `packages/web/src/store/websocketSlice.ts` is a Redux slice and is unrelated to
the chat socket.

---

## U4 — Any sensitive-tool flag

**There is no boolean `sensitive` flag on tool descriptors.** The closest existing
mechanism is **risk-tier classification**, which O5 should reuse (BUILD_SPEC §10 U6
decision A).

- Risk tiers: `src/policy/riskTier.ts:23-40`
  (`read | write-workspace | write-outside | exec | network-external | destructive | secret`).
- The classifier: `src/policy/riskTier.ts:385-418` `classifyToolCall(toolName, args,
  workspaceRoot): RiskTier`. Exact-name sets are authoritative:
  `SECRET_TOOL_NAMES` at `src/policy/riskTier.ts:248-258`
  (`secrets`, `secrets_read`, `secret_read`, `read_secret`, `get_secret`, `env_read`,
  `read_env`, `api_key_read`, `credentials_read`), plus `WRITE_TOOL_NAMES` (`:140`),
  `EXEC_TOOL_NAMES` (`:183`), `NETWORK_TOOL_NAMES` (`:225`), `READ_TOOL_NAMES` (`:66`).
  Unknown names fall back to name heuristics (`:407-417`) and default to `"exec"`.
- Callers of `classifyToolCall` (the gate path O5 must hook):
  - `src/policy/permissionModes.ts:471`
  - `src/policy/permissionRules.ts:281`
  - `src/tools/planApprovalGate.ts:120`
- Gate decision matrix: `src/policy/riskTier.ts:474` `GATE_MATRIX`,
  `decideGate` at `:505`, `canAutoApprove` at `:523`, `resolveGate` at `:542`.
- The "sensitive action" approval concept lives in
  `src/server/approvals.ts:2` (header comment: "Sensitive-action approvals (frontier
  section 18): host input-injection tools") and the per-task auto-approve flag is
  documented at `src/server/approvalRules.ts:247` ("Per-task 'Approve for me': when on,
  the gate approves sensitive tool calls"). The flag is carried on the wire as
  `approveForMe` (`src/protocol/types.ts:67`) and applied at
  `src/protocol/socket.ts:544-545` via `setTaskApprovalAuto`.
- The corresponding agent event is `{ type: "approval_required"; approvalId; tool;
  summary }` at `src/agent/events.ts:88-89`.

**Answer for O5:** reuse `classifyToolCall(name, args, workspaceRoot) === "secret"`
(or `!== "read"`, depending on how broad the redaction should be) to decide whether a
`tool_result` payload stores a full `brief` or a redacted one. BUILD_SPEC §10 U6
decision **A** is correct; there is no existing flag to read, so the tier is the flag.

---

## U5 — Agent-loop spots where tools start/finish, and where `ExecutionCheckpoint` is saved

### Tool start / finish in the linear loop — `src/agent/loop.ts`

Two branches, both emitting the same `AgentEvent` shapes:

| Branch | `tool_call` emit | `tools.exec(...)` | `tool_result` emit |
|---|---|---|---|
| Batched parallel (read-only tools) | `src/agent/loop.ts:488` | `src/agent/loop.ts:491-502` | `src/agent/loop.ts:519-525` |
| Per-call (default) | `src/agent/loop.ts:534` | `src/agent/loop.ts:537-546` | `src/agent/loop.ts:548` |

- `AgentEvent` shapes: `{ type: "tool_call"; name; args }` at
  `src/agent/events.ts:65`; `{ type: "tool_result"; name; ok; summary; ms? }` at
  `src/agent/events.ts:66`.
- The `RunOptions` interface is `src/agent/loop.ts:40-92`; `RunResult` is
  `src/agent/loop.ts:94-102`.
- **Important gap for O5:** the model's tool-call **id is never captured.** The loop
  reads `call.function?.name` and `call.function?.arguments`
  (`src/agent/loop.ts:486-487` and `:532-533`) but discards `call.id`. There is no
  `toolCallId` threaded into `tool_call`/`tool_result` events, and `ToolTraceItem`
  (`src/agent/events.ts:36`) has no id field either. O5 must therefore derive a stable
  per-call id (e.g. `newId("call")` from `src/server/db.ts:120`, or
  `shortUid()` from `src/protocol/events.ts:26`) at the emit site, because
  BUILD_SPEC §6.5 keys the in-flight detection on `toolCallId`.
- The worker (sub-checkpoint) save in the loop is
  `opts.saveWorker?.(structuredClone({ prompt, messages, trace, steps, model, usage }))`
  at `src/agent/loop.ts:585`; its type `WorkerCheckpoint` is
  `src/agent/checkpoint.ts:6-13`. This is a *different* checkpoint from
  `ExecutionCheckpoint`.

### `ExecutionCheckpoint` — type and where it is saved

- Type: `src/agent/checkpoint.ts:15-38` (`ExecutionCheckpoint`, with `inFlight` at
  `:26`, `complete` at `:27`). **No `logSeq` field yet** (BUILD_SPEC §6.5 adds it).
- The checkpoint is built and saved by the **orchestrator**, not the linear loop:
  - `src/agent/orchestrator.ts:246-249` — the `checkpoint(inFlight, complete, usage)`
    closure that calls `o.saveCheckpoint?.(structuredClone({...}))`.
  - `src/agent/orchestrator.ts:250` — `checkpoint(restored?.inFlight ?? false)` on entry.
  - `src/agent/orchestrator.ts:261` — `checkpoint(true)` before each worker run.
  - `src/agent/orchestrator.ts:281` — `checkpoint(false, true)` in `finish()`.
  - `src/agent/orchestrator.ts:296` — `checkpoint(false)` after final repair.
  - `RunOptions.saveCheckpoint` is declared at `src/agent/orchestrator.ts:25`.
- The production wiring that persists it is in **`src/index.ts:502-505`**:

  ```ts
  const result = opts.savedRun.orchestrated ? await runOrchestratedAgent({
    ...agentOpts, verdicts: verdicts as VerdictRecord[], resume: opts.savedRun.checkpoint, lifecycleHooks: true,
    saveCheckpoint: (checkpoint) => { opts.savedRun.checkpoint = checkpoint; saveRun(task, opts.savedRun, opts.lease); },
  }) : await runAgent(agentOpts);
  ```

  So the durable write is `saveRun` (`src/server/db.ts:305-308`), which puts the whole
  `SavedRun` (including `checkpoint`) into the `entities` table under kind `"runs"`
  (`src/server/db.ts:309` `getSavedRun`, `:310` `clearSavedRun`). The task row itself
  is `entities` kind `"tasks"` (`src/server/db.ts:144`).
- `SavedRun` type: `src/server/recovery.ts:4-20`; `checkpoint?: ExecutionCheckpoint`
  at `:17`.
- **Resume gate:** `requiresReplayConfirmation(run)` at
  `src/server/recovery.ts:21-23` returns `run.checkpoint ? run.checkpoint.inFlight :
  run.started`. Callers: `src/server/http.ts:2497` and `src/server/http.ts:2692`
  (the latter throws unless `body.retryInterruptedStep === true`).
- **Boot recovery:** `recoverInterruptedTasks()` at `src/server/db.ts:123-137` marks
  every `running`/`queued` task `interrupted` with the message
  "Execution interrupted by application shutdown. Resume requires review." and then
  calls `expireAllRunLeases()` (`:135`).
- `ExecutionCheckpoint` is referenced across the recovery scripts
  (`src/scripts/check-bot-recovery-live.ts:10`, `:35`, `:68`;
  `src/scripts/check-bot-final-repair-resume.ts:7`, `:15`;
  `src/scripts/check-bot-exhausted-repair-resume.ts:7`;
  `src/scripts/check-bot-usage-recovery.ts:7`; `src/scripts/check-orchestrator.ts:9`),
  which are the regression surface O5/O6b must keep green.

**Answer for O5:** append `tool_result` started/terminal events at the four emit sites
in `src/agent/loop.ts` (`:488/:519` and `:534/:548`), and call `writeCheckpoint` from
the orchestrator's `checkpoint` closure (`src/agent/orchestrator.ts:246-249`), which is
the single place that already has the full `ExecutionCheckpoint`. The
`requiresReplayConfirmation` predicate (`src/server/recovery.ts:21-23`) is where the
"started without a terminal row" rule must land.

---

## U6 — The exact web build npm script

- **`packages/web/package.json:8`** — `"build": "next build"`.
- The root `package.json` has **no** web build script; the gate is run as
  `(cd packages/web && npx next build)` (BUILD_SPEC §0.6, §11). The root scripts
  `build:server` (`package.json`, `esbuild src/index.ts ...`) and `typecheck`
  (`tsc --noEmit`) are the other two gates.
- `packages/web/package.json` scripts in full (`:7-13`): `dev` = `next dev`,
  `build` = `next build`, `start` = `npx serve out`, `typecheck` = `tsc --noEmit`,
  `test` = `vitest run`, `e2e` = `playwright test`,
  `verify:tokens` = `node scripts/verify-tokens.mjs`.
- The web tsconfig typecheck is `packages/web/tsconfig.json` (referenced by the
  `typecheck` script). Next is `^16.3.3`, React `^19.2.0`, socket.io-client `4.8.1`
  (`packages/web/package.json:16-34`).

---

## Spec assumptions that are wrong (or imprecise)

Recorded per BUILD_SPEC §11 acceptance item 5.

1. **§2 "replay at line ~325"** — the real replay call is
   **`src/protocol/socket.ts:345`**, not ~325. (Line 325 is inside the socket.io
   `new Server(...)` options object.)
2. **§6.5 "[O `src/server/recovery.ts:19`]"** — `requiresReplayConfirmation` is at
   **`src/server/recovery.ts:21-23`**, not `:19`.
3. **§6.6 "[O `src/server/db.ts:104`]"** — `recoverInterruptedTasks` is at
   **`src/server/db.ts:123-137`**, not `:104`.
4. **§2 "`newId()` in `src/server/db.ts:101`"** — `newId` is at
   **`src/server/db.ts:120`**, not `:101`.
5. **§6.2 "getMeta/setMeta ... O0 confirms or O2 adds"** — confirmed **absent** from
   `sqliteStore.ts`; only private copies exist (`src/server/credits.ts:98-105`,
   `src/server/assets.ts:52-58`). O2 must add them.
6. **§6.5 "Tool calls ... `{toolCallId, state:"started"}`"** — the loop has **no
   `toolCallId`** available (`src/agent/loop.ts:486-487`, `:532-533` drop `call.id`).
   O5 must synthesize one; the spec's payload shape cannot be filled from existing
   data as written.
7. **§6.1 `transaction` note** — the real implementation is `BEGIN IMMEDIATE`
   (`src/server/sqliteStore.ts:50`), and it is **not re-entrant**; BUILD_SPEC U2 is
   answered "no nesting".
8. **§2 "Loam build (decided): the existing socket.io channel ... replay at line ~325
   [O]"** — the channel is real, but replay is keyed on `lastMessageId` via
   `findIndex` (`src/protocol/store.ts:126`), and there is **no sequence field** on
   `ServerEnvelope` (`src/protocol/types.ts:115-122`) or on `JoinSession`
   (`src/protocol/types.ts:29-34`). The `seq`-based replay O4 adds does not exist in
   any form today.
9. **§10 U6 "does Loam have a sensitive-tool flag?"** — **no boolean flag**; the
   equivalent is `classifyToolCall(...) === "secret"` (`src/policy/riskTier.ts:385-418`,
   `SECRET_TOOL_NAMES` at `:248-258`). Decision A (reuse it) is correct.
10. **§6.1 purge trigger** reads `(SELECT value FROM metadata WHERE key='eventlog-purge')`
    — the `metadata` table does exist (`src/server/sqliteStore.ts:18`), so the DDL is
    compatible. No change needed.
11. **§6.5 "This feeds the existing `requiresReplayConfirmation`"** — correct, but the
    function only looks at `checkpoint.inFlight` / `started`
    (`src/server/recovery.ts:21-23`); it has no notion of per-tool started/terminal
    rows, so O5 must extend it (or add a sibling predicate) rather than just call it.
12. **§11 O0 row "Verify: file exists"** — satisfied by this file.

---

## Gate commands (all run from the worktree root)

```
npx tsc --noEmit
npm run build:server
(cd packages/web && npx next build)
npm run check:encoding
```

The O0 Verify column is `file exists` (`docs/re/omnara-O0.md`), which this report
satisfies. No source file was touched, so the gates are expected to be unchanged from
the `a8130cc` baseline; they were run to confirm the worktree is green before commit.
