# H0 recon — real paths and signatures for the Harness² correction-learning workstream

Read-only reconnaissance on branch `khamis1992/h2-h0` (worktree of `manus-local`,
based on `manus-parity`). No source file was modified. Every claim below carries a
`file:line` reference that was read from the working tree, not inferred from the
spec.

Baseline facts used throughout:

- Repo root: this worktree. `git rev-parse --abbrev-ref HEAD` = `khamis1992/h2-h0`;
  `git rev-list --count manus-parity..HEAD` = `0` (no commits of its own yet).
- Only uncommitted change in the tree: `deleted: .jdone` (a worktree setup artifact,
  unrelated to this task and left untouched).
- `docs/re/` does not exist on this baseline; the closest existing report directory is
  `docs/reviews/` (tracked). This report is the first file under `docs/re/`.
- `src/learning/harness/` does not exist yet. Existing learning surface is
  `src/learning/critic.ts`, `src/learning/selfplay.ts`, `src/server/learning.ts`.
- No prior H-task report exists (`docs/re/harness2-H0.md` is this file).

---

## U1 — the embedding method on `OllamaEmbedder` (`src/memory/embeddings.ts`)

**Answer: `embed(texts: string[]): Promise<number[][]>` is the batch method; there is
also `embedOne(text: string): Promise<number[]>`. There is NO `embed(text): Promise<number[]>`**
(the signature assumed in BUILD_SPEC §6.2 note [U1]).

`src/memory/embeddings.ts`:

- `:1` `export class OllamaEmbedder {`
- `:12` `async embed(texts: string[]): Promise<number[][]>` — batch. Tries
  `POST {baseUrl}/api/embed` with `{ model, input: texts }` and returns
  `data.embeddings` only when `Array.isArray(data.embeddings) && data.embeddings.length === texts.length`.
  On any failure it falls back to the legacy per-text `POST {baseUrl}/api/embeddings`
  loop (`:31-45`), which throws `ollama /api/embeddings HTTP <status>` or
  `ollama returned no embedding` when a call fails.
- `:48` `async embedOne(text: string): Promise<number[]>` — `const [v] = await this.embed([text]);`
  and throws `empty embedding` when the batch came back empty. **This is the method
  to use for a single text.**
- `:55` `toBase64(vec)`, `:60` `fromBase64(b64, dim)`, `:68` `normalize(vec)`,
  `:79` `dot(a, b)` — the exact codec BUILD_SPEC §6.2 imports. All four already exist
  and are already used by `src/memory/store.ts:4`.

Consequences for H2 (`src/learning/harness/experienceStore.ts`):

1. BUILD_SPEC §6.2 line `normalize(await args.embedder.embed(`${les.cue}\n${les.lesson}`))`
   must become `normalize(await args.embedder.embedOne(`${les.cue}\n${les.lesson}`))`
   (or `embed([text])` with `[0]`). `embed` takes an **array**, so the spec code as
   written would pass a string and get a compile error.
2. `embedOne` throws on failure, so the `try { ... } catch { /* lexical fallback */ }`
   in the spec is correct and must be kept: the vector is optional and `rankLessons`
   has the lexical fallback.
3. The embedder instance is constructed once in `src/setup/runtime.ts:89`:
   `const embedder = new OllamaEmbedder(cfg.ollamaUrl, cfg.memory.model);`
   (`cfg.ollamaUrl` + `cfg.memory.model`, default `nomic-embed-text:latest` at
   `src/config.ts:256`). It is NOT stored on `MemoryStore` — the store holds it as a
   private field (`src/memory/store.ts:128`) with no accessor. H8 will need to pass the
   embedder explicitly (or construct one) rather than read it off the store.
4. `src/setup/runtime.ts:129-133` also hands the same embedder to semantic code search,
   so the object is shared, not per-store.

## U2 — the exact model chat call used in `src/learning/critic.ts` `critiqueCase`

**Answer: `input.ollama.chat({ model, messages, temperature, timeoutMs })`, returning
`ChatResult`; the text is `result.content`.**

`src/learning/critic.ts`:

- `:52` `export async function critiqueCase(input: CritiqueInput): Promise<CritiqueResult | null>`
- `:53` `const model = input.cfg.selfImprove.model || input.cfg.model;`
- `:6-15` `CritiqueInput` = `{ cfg: Config; ollama: OllamaClient; prompt: string;
  finalText: string; trace: Array<{name,ok,ms?}>; checkpoints: Array<{type,ok,detail}>;
  status: string; error?: string }`
- `:75-84` the call itself, quoted verbatim from `src/learning/critic.ts:75-85`:
  ```ts
  try {                                                     // :75
    const result = await input.ollama.chat({                // :76
      model,                                                // :77
      messages: [                                           // :78
        { role: "system", content: CRITIC_SYSTEM },         // :79
        { role: "user", content: digest },                   // :80
      ],
      temperature: 0.1,                                  // :82
      timeoutMs: 180_000,                                 // :83
    });
    const parsed = parseCritique(result.content);           // :85
  ```
  `model` is `:53` (`input.cfg.selfImprove.model || input.cfg.model`); `digest` is
  assembled at `:59-73`; `CRITIC_SYSTEM` is the JSON-only system prompt at `:17-27`;
  `parseCritique` is at `:29-50`.
- `:86-90` on unparseable output it logs `critic: unparseable output (<120 chars>...)`
  (`:86`) and returns `null` (`:87`); any throw is caught (`:88`), logged as
  `critic failed: <message>` (`:89`), and returns `null` (`:90`).

The client contract is in `src/ollama.ts`:

- `:120` `export class OllamaClient {`
- `:34` `export interface ChatMessage {`; `:42` `export interface ChatOptions { model; messages; tools?; temperature?; timeoutMs?; signal?; onToken?; format? }`
  (`format` is "Optional constrained JSON output for local models" at `:50-51`).
- `:54` `export interface ChatResult { content; toolCalls; model; doneReason?; usage: {...} }`
- `:168` `async chat(opts: ChatOptions): Promise<ChatResult>` — routes `:cloud` models
  to `chatCloud` (`:176`) and everything else to `chatLocal` (`:307`).

**Consequences for H4 (`src/learning/harness/distill.ts`):**

1. BUILD_SPEC §6.4's `(o.ollama as any).chatText({ cfg, system, user, json: true })`
   does not exist. Replace it with the exact critic shape:
   `const r = await o.ollama.chat({ model, messages: [{role:"system",content:DISTILL_SYSTEM},{role:"user",content:user}], temperature: 0.1, timeoutMs: 180_000 });`
   then `parseDistill(r.content)`. The `as any` is removed.
2. The critic passes no `format` object; it relies on the model returning bare JSON
   and `parseCritique` (`:29-50`) salvaging it with `indexOf("{")`/`lastIndexOf("}")`.
   `parseDistill` in the spec uses the same salvage approach, which is consistent.
3. Model selection should mirror `critic.ts:53`: `cfg.selfImprove.model || cfg.model`
   (with the self-improve model also used by `src/agent/reflect.ts:161`).
4. A fake client for tests only needs `chat(opts): Promise<{content: string; ...}>`
   (see the existing fake-embedder pattern in `src/memory/__tests__/storeDream.test.ts:43`,
   which casts a minimal object `as unknown as OllamaEmbedder`).
5. `critiqueCase` is invoked from `src/eval/runner.ts:147` with
   `{ cfg, ollama: deps.ollama, prompt, finalText, trace, checkpoints, status, error }`,
   and the result type `CritiqueResult` (`src/eval/types.ts:45-52`) already has
   `lessons: string[]` — that is the field BUILD_SPEC §6.7 hook point C targets.

## U4 — which route appends user chat messages to a task

**Answer: there is no single route. User text reaches a task's `messages` array through
four distinct paths, and the chat route is `POST /api/chat` in `src/server/http.ts`, which
does NOT call `appendMessage` — it calls `createTask`/`runTask` and the append happens
inside `src/server/db.ts`.**

The primitive is `src/server/db.ts:150`:
```ts
export function appendMessage(id: string, role: TaskMessage["role"], content: string): void
```
(`editTask` → `t.messages.push({role, content, at})`). Callers of `appendMessage` in
production code:

| Site | Line | Role | What it appends |
|---|---|---|---|
| `src/server/routes/sessionControl.ts` | `:157` | `user` | pause/resume take-over note: `user changed: <note>` |
| `src/server/bridge/grokbot.ts` | `:146` | `user` | mirrored bridge message into the thread |
| `src/swarm/service.ts` | `:232` | `user` | company-run brief |
| `src/swarm/service.ts` | `:468` | `assistant` | final node output |

The **chat route** is `src/server/http.ts:2603`:
```ts
if (req.method === "POST" && p === "/api/chat") {
```
It reads `{ prompt, taskId, title, model, projectId, attachments, mode, effort, agentId, workMode }`
(`:2604-2615`), creates the task when `taskId` is absent (`:2656`
`if (!taskId) taskId = createTask(prompt, title, projectId, agentId).id;`), then calls
`runTask({...})` at `:2660-2671` and streams SSE events. **It never calls `appendMessage`
itself.**

The actual user-message append for a chat turn is `src/server/db.ts:320` inside
`queueTaskRun`:
```ts
if (!resume) task.messages.push({ role: "user", content: run.prompt, at: task.updatedAt });
```
So the message is written by the shared run engine, not by the route.

Other user-message append sites that are NOT the chat route:

- `src/server/routes/retryLast.ts:34` `export function lastUserMessage(task)` returns the
  newest `user` message (`:52` uses it) and re-issues it through `runTask` at `:58-65`.
  A retry therefore also appends a user message via `queueTaskRun`.
- `src/server/routes/sessionControl.ts:116-131` (`POST /api/tasks/:id/btw`) creates a
  *separate* side-chat task rather than appending to the main one.

**Consequences for H8 (BUILD_SPEC §6.7 hook point A):**

1. Do **not** hook `appendMessage` in `db.ts` — the spec already says so, and the
   evidence confirms `db.ts` is the wrong place (it has no request context and is called
   from many non-chat paths: swarm, bridge, resume).
2. The correct hook is the chat route `src/server/http.ts:2603`, but the append has not
   happened yet at the point the route runs. Two viable placements:
   - **Before** `runTask` at `:2660`: read the prior assistant text from
     `getTask(taskId)?.messages` (or `previous?.messages`), run
     `detectCorrection(priorAssistant, prompt)`, and if it fires schedule the background
     `recordCorrection → distill → addLesson` with `setImmediate`. This is the minimal,
     route-local hook and matches the spec's "in the chat route" wording.
   - **After** the run: `completeTaskRun` (`src/index.ts:513`) already pushes the
     assistant message (`db.ts:345`), so a correction for the *next* user turn is
     detected when that turn arrives, using `previous.messages` as the prior assistant.
     The route-local pre-run hook is the one that sees both sides in one place.
3. `priorAssistant` is available as the last `assistant` message of the task
   (`getTask(id)?.messages.filter(m => m.role === "assistant").at(-1)?.content`).
   BUILD_SPEC §6.3 `DetectInput.priorAssistant` matches this.
4. `setImmediate` is the right deferral primitive; the only existing production use is
   `src/scripts/check-security-http-body-limit.ts:29`, and the "never throws into the
   task path" precedent is `src/agent/reflect.ts:158-175` (try/catch + `log.warn`).
   Note `src/server/http.ts:2673-2678` already wraps the run in try/catch/finally for
   SSE, so a background hook must be `void ... .catch(...)` and must not await.
5. The route is SSE and returns headers at `:2636-2640` before the run; a background
   hook scheduled before `runTask` is safe because the response is already streaming.

## U5 — where the agent loop builds the system prompt

**Answer: `src/agent/loop.ts:215` `runAgent(opts)` builds it at `:220-235` via
`buildSystemPrompt(...)` from `src/agent/prompt.ts:67`.**

`src/agent/loop.ts`:

- `:215` `export async function runAgent(opts: RunOptions): Promise<RunResult>`
- `:220-231` `const baseSystem = opts.systemOverride ?? buildSystemPrompt(opts.cfg,
  loadProjectSkills(opts.cfg.workspace).skills, opts.tools.names(), opts.memories ?? [],
  undefined, opts.sandboxMode, undefined, opts.prompt);`
- `:232-235` `const system = opts.systemSuffix && opts.systemSuffix.trim().length > 0
  ? `${baseSystem}\n\n${opts.systemSuffix.trim()}` : baseSystem;`
- `:236` `let messages: ChatMessage[] = [{ role: "system", content: system }];`

`src/agent/prompt.ts`:

- `:67` `export function buildSystemPrompt(cfg, skills, toolNames, memories = [],
  extraContext?, sandboxMode?, projectMemory?, userPrompt?): string`
- `:16` `masterPromptEnabled()`, `:23` `codingPromptEnabled()`
- `:127-130` recalled memories are appended as `"Context explicitly supplied by this task:"`
- `:131` `if (extraContext?.trim()) lines.push(extraContext.trim());` ← **the natural
  injection slot**; it is the 5th positional argument.
- `:133-135` project memory block; `:137-138` personalization block; `:139-142` skills
- `:143` `return lines.join("\n");`

**Consequences for H5 (BUILD_SPEC §6.7 hook point B):**

1. The cleanest injection point is the `extraContext` argument (`buildSystemPrompt`'s 5th
   parameter, consumed at `prompt.ts:131`). `runAgent` does not currently pass it, so H5
   can either:
   - add an optional `extraContext?: string` to `RunOptions` (`loop.ts:30-93`) and pass
     it at `:227`, or
   - append to `opts.systemSuffix` (which is already merged at `:232-235` and is how
     subagents inject text: `src/tools/subagents.ts:217-233`,
     `src/tools/mapReduce.ts:144`, `src/tools/workflow.ts:518`,
     `src/agent/orchestrator.ts:80`).
   `systemSuffix` is the lower-risk choice because it needs no signature change and is
   already the established "append to the system prompt" channel. Either way the block
   must be wrapped in try/catch (spec requirement) and capped (§6.5 `LESSON_BLOCK_MAX_CHARS`).
2. `RunOptions` is at `src/agent/loop.ts:30-93`; `systemOverride` (`:42`) replaces the
   whole prompt and `systemSuffix` (`:44`) appends. The orchestrator path
   (`src/agent/orchestrator.ts:59-80`) threads `systemSuffix` through to `runAgent`, so
   a suffix-based injection also covers orchestrated runs.
3. `src/agent/planner.ts` is a real module but not the system-prompt site: it builds
   a **plan** via `planTask` (`:150`) using `chatWithFallback` (`:5`) with a fallback plan
   logged at `:182`/`:188`. The agent system prompt is built only in
   `src/agent/loop.ts:220-235`. BUILD_SPEC §13 lists `src/agent/planner.ts` as decision
   **B** for U5; the evidence says the real site is `loop.ts` (decision **A**).

## U6 — where learning REST routes are mounted

**Answer: there is no `src/server/routes/learning.ts`. The one learning endpoint is
`GET /api/learning`, written inline in `src/server/http.ts:1058-1062`, backed by
`src/server/learning.ts`.**

`src/server/learning.ts` (36 lines, the whole module):

- `:5-7` `learningFile()` = `path.join(DATA_DIR, "learning.log")`
- `:9` `export function readLearning(limit: number): unknown[]` — reads the last `limit`
  lines, newest first, JSON-parses each (`{ raw: l }` on failure)
- `:29` `export function appendLearning(entry: unknown): void` — `fs.appendFileSync` with
  `JSON.stringify(entry) + "\n"`, `utf8`, inside try/catch that swallows errors

`src/server/http.ts`:

- `:1058-1062`:
  ```ts
  if (req.method === "GET" && p === "/api/learning") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 500);
    sendJson(res, 200, { entries: readLearning(limit) });
    return;
  }
  ```
- `:73` `import { appendLearning } from "./learning.js";`
- `appendLearning` call sites (the audit line BUILD_SPEC §8 wants to extend):
  `src/server/http.ts:1043` and `:1052` (pending-item approve/reject),
  `src/index.ts:546` (non-pass verifier verdicts), `src/eval/runner.ts:213`,
  `src/learning/selfplay.ts:224`, `src/agent/reflect.ts:179,215,242`.

Route mounting pattern in `http.ts` (for H8's new routes):

- Every route module exports `handleXxxRoutes(req, res, p, ctx?)` and returns
  `Promise<boolean>` (`true` = handled). Examples:
  `src/server/routes/instructions.ts:45` `handleInstructionsRoutes`,
  `src/server/routes/retryLast.ts:38` `handleRetryLastRoutes`,
  `src/server/routes/sessionControl.ts:111` `handleSessionControlRoutes`.
- They are imported at the top (`src/server/http.ts:79-109`, e.g. `:88`
  `import { handleInstructionsRoutes } from "./routes/instructions.js";`,
  `:102` `handleSessionControlRoutes`) and dispatched in order inside the request
  handler at `:1760-1807` (e.g. `:1768`, `:1771`, `:1773`, `:1805`).
- Inline endpoints (like `/api/learning` at `:1058`) live earlier in the same handler,
  before the dispatched modules.

**Consequences for H8 (BUILD_SPEC §8 REST contract):**

1. BUILD_SPEC §3 lists `src/server/routes/learning.ts` as a **new** file; §13 decision
   **B** for U6. That is the right call: there is no existing router to extend. Create
   `src/server/routes/learning.ts` exporting `handleLearningRoutes(req, res, p)`, import
   it beside `:102`, and dispatch it at `:1808` (the first free line after
   `handleWikiRoutes` at `:1807`, before the generic `/api/agents/:id` avatar block at
   `:1811`). Keep `/api/learning` (the existing
   audit-log endpoint) and add `/api/learning/lessons` and `/api/learning/corrections`
   as distinct paths — note `GET /api/learning` is an exact match, so a
   `p.startsWith("/api/learning/")` branch will not shadow it. (The existing
   `/api/learning` block sits at `:1058-1062`, before the dispatched modules.)
2. The §8 contract uses `{ data: Lesson[] }` for list responses and `{ data: Lesson }`
   for PATCH. The existing server convention is a bare body (`{ entries: ... }` at
   `:1060`, `{ proposals: ... }` at `routes/instructions.ts:87`, `{ deleted: ... }` at
   `:2599`). H8 should follow the spec's `{ data }` shape for the new routes but must
   strip `vector`/`dim` (spec says so) — the existing code does exactly this for memory
   entries at `src/server/http.ts:1579`
   (`const { embedding, ...rest } = e as ...; return rest;`).
3. `appendLearning` (`src/server/learning.ts:29`) is the audit sink for `lesson_added`.
   Its existing call sites use the `{ at, task, applied }` shape (`http.ts:1043,1052`,
   `index.ts:546`, `eval/runner.ts:213`, `selfplay.ts:224`, `agent/reflect.ts:179,215,242`),
   while §8 specifies `{ at, kind: "lesson_added", lessonId, source, domain }`. Both are
   accepted because `appendLearning` takes `unknown`; H2/H8 should append the §8 shape.

## U7 — whether a secret-redaction helper exists

**Answer: yes, two independent helpers exist. Use `src/memory/redact.ts` (detection,
throwing) for the pre-store guard; `src/log.ts` `redact()` is for log/output scrubbing.**

`src/memory/redact.ts` (41 lines, the guard BUILD_SPEC §10 wants):

- `:10-23` `const SECRET_PATTERNS: RegExp[]` — AWS (`AKIA`/`ASIA`), GitHub
  (`ghp_`/`gho_`/`github_pat_`), Slack (`xox[baprs]-`), Anthropic (`sk-ant-`), OpenAI /
  generic (`sk-`), Google (`AIza`), JWT, `-----BEGIN ... PRIVATE KEY-----`, and a
  `password|passwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret`
  assignment pattern.
- `:26` `export function findSecret(text: string): string | null` — returns the matching
  pattern source
- `:33` `export function containsSecret(text: string): boolean`
- `:38` `export function assertNoSecret(text: string): void` — throws
  `memory text rejected: possible secret (<pattern>)`

`src/log.ts` (output scrubbing, not a store guard):

- `:1-2` `SECRET_RE` = keyword-prefixed values
- `:7` `export function registerSecretValue(value: string): void` — vault values always
  redacted
- `:14` `export function redact(input: string): string` — replaces matches with `***`
- `:39-45` `log.info/warn/error/debug` route every argument through `redact`

**Consequences for H2/H4 (BUILD_SPEC §10 secret hygiene):**

1. Use `assertNoSecret` (or `containsSecret`) from `src/memory/redact.ts` on `cue`,
   `lesson` and `evidence` before `addLesson`. The spec's fallback regex
   (`/(sk-|ghp_|xox[bp]-|AKIA|-----BEGIN)/`) is a subset of the existing patterns, so
   decision **A** (reuse) is correct and strictly stronger.
2. `assertNoSecret` throws; `addLesson` should catch and return `null` (the same
   "reject, don't store" contract as `isCompleteLesson` returning false) rather than
   letting the throw escape into the background hook. `addLesson` already returns
   `Promise<Lesson | null>`, so a `null` return is the natural rejection signal.
3. Do not use `log.redact` for storage: it is lossy output scrubbing (it replaces values
   with `***` and would corrupt a lesson), and it is not a detector.
4. `registerSecretValue` is called by `src/server/secretsVault.ts:13` and
   `src/tools/vaultTools.ts:12`, so vault values are already registered for log redaction;
   that does not affect stored lessons, which is why `assertNoSecret` is the right guard.

## U8 — the exact web build npm script

**Answer: there is no root `build:web` script. The web build is `npm run build` inside
`packages/web` (i.e. `next build`), so the command is
`npm --prefix packages/web run build` or `(cd packages/web && npx next build)`.**

Root `package.json` (`package.json:12-82` scripts) — no `build:web`, no `web` script at
all. The web-related root scripts are only:
- `:74` `"gen:web-app-template": "tsx src/scripts/gen-web-app-template.ts"`
- `:75` `"check:web-scaffold": "tsx src/scripts/check-web-scaffold.ts"`

`packages/web/package.json:6-14`:
```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "npx serve out",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "e2e": "playwright test",
  "verify:tokens": "node scripts/verify-tokens.mjs"
}
```
(`next` `^16.3.3`, `react` `^19.2.0`, `typescript` `^5.7.0`, `vitest` `^3.0.9`.)

**Consequences:**

1. BUILD_SPEC §11's global gate `npx tsc --noEmit && npm run build:server && npm run build:web`
   must be run as `(cd packages/web && npx next build)`. BUILD_SPEC §13 decision **B**
   (`npm --prefix packages/web run build`) is the correct form.
2. `npm run typecheck` at the root only covers `src` (`tsc --noEmit`, `package.json:15`).
   The web package has its own `typecheck` (`packages/web/package.json:10`), so H9 must
   run `(cd packages/web && npx tsc --noEmit)` too.
3. Web tests are vitest (`packages/web/package.json:11`), matching BUILD_SPEC §12.
4. `npm run build:server` (`package.json:43`) is the esbuild bundle to `dist/server.cjs`
   and copies `pdf.worker.mjs`; it is unaffected by this recon.

---

## Additional recon facts needed by later H tasks

These were not in the U1–U8 list but are required to implement §6–§8 without guessing.

### Existing storage primitive (BUILD_SPEC §7)

`src/server/sqliteStore.ts` already has the `entities` table the spec reuses:

- `:17-18` `CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY(kind,id));` plus a `metadata` table
- `:54` `putEntity(kind, value)`, `:58` `getEntity<T>(kind, id)`,
  `:62` `allEntities<T>(kind)` (ordered `rowid DESC`), `:66` `removeEntity(kind, id)`
- `:48` `transaction(fn)`, `:11` `database()` (opens `dataDir()/manus.db`)
- `:78` `resetDb()` and `:69` `closeDb()` — the test-isolation helpers
- `:8` `onDatabaseReset(reset)` — forget in-process caches

`dataDir()` is `src/config.ts:33-35` = `fromEnv("MANUS_LOCAL_DATA_DIR", path.join(ROOT, "data"))`,
and `fromEnv` (`:28-31`) reads `LOAM_<NAME>` first, then the `MANUS_LOCAL_<NAME>` name passed in
(the name is transformed inside `fromEnv`, so both prefixes work for every key). **Tests must set
`process.env.MANUS_LOCAL_DATA_DIR` (or `LOAM_DATA_DIR`) to a temp dir before importing
`sqliteStore`** — the existing pattern is
`src/server/__tests__/retryLast.test.ts:42-44`
(`fs.mkdtempSync` then `await import("../sqliteStore.js")`), and
`src/server/__tests__/retryLast.test.ts:59-64` for teardown. Note the DB connection is
cached in a module-level variable (`sqliteStore.ts:10`), so a late import after another
test already opened the real DB will reuse it — hence the env var must be set first.

### Existing instruction-proposal flow (BUILD_SPEC §0.5, §6.6)

`src/server/instructionHistory.ts`:

- `:8` `interface InstructionVersion`, `:20` `interface InstructionProposal`
  (fields `id, agentId, version, instructions, diff, createdAt, reason`)
- `:241` `export function proposeInstructions(agentId: string, newText: string, reason = ""): InstructionProposal`
  — **the spec's §6.6 [I] note is confirmed: it returns an `InstructionProposal` with an
  `id` field.** It calls `requireAgent` (`:237`), computes `nextVersion` (`:115`), builds
  a unified diff via `makeUnifiedDiff` (`:218`), and inserts a row with
  `status: "proposed"`.
- `:263` `approveProposal(id)`, `:283` `rejectProposal(id)`,
  `:297`/`:298` `listProposals(agentId, status?)`, `:309` `listVersions(agentId)`,
  `:316` `recordUserEdit(agentId, oldText, newText)`
- The approval flow is exposed at `src/server/routes/instructions.ts:45`
  (`handleInstructionsRoutes`), dispatched at `src/server/http.ts:1768`.
- **U3 (where proposals render in the UI) is resolved:** `packages/web/src/components/agents/InstructionHistory.tsx`
  (`:43` fetches `/api/agents/<id>/instructions/proposals`, `:67` posts
  `.../proposals/<id>/<action>`, `:148-179` `useInstructionProposals` hook) and
  `packages/web/src/components/agents/AgentThreadView.tsx:203,505-510` renders them.
  So H9's "Pending proposals" list already exists and does not need rebuilding.

### Existing "lesson" surfaces (do not duplicate — BUILD_SPEC rule 10)

- `src/swarm/service.ts:1127-1150` already has a **swarm-scoped** lesson library:
  `lessonsFile()` = `taskPath(this.dir, "lessons.md")`, `recordLesson(s)` appends on
  failure, `relevantLessons(brief)` returns word-overlap matches, and `:566-567` injects
  `Relevant lessons from past failed runs:` into the stage prompt. This is company-run
  scoped and markdown-on-disk; the new `src/learning/harness/*` store is task/domain
  scoped and sqlite-backed. They are different scopes, so both can coexist, but H5 must
  not replace the swarm one.
- `src/tools/mirofish.ts:796-810` writes `swarm_lessons.json` (cross-project swarm memory).
- `src/learning/critic.ts:45` returns `lessons: string[]` (unstructured) — this is the
  field BUILD_SPEC §6.7 hook point C converts into structured lessons.
- `src/agent/reflect.ts:160` `reflectOnTask` writes skills/memories and appends
  `appendLearning` lines; it is the precedent for "background learning that never throws".

### Config keys (BUILD_SPEC §10)

`src/config.ts`:

- `:221` `const DEFAULTS: Config = {`; the `memory` block is `:254-263` (`:256` default
  embedder model `nomic-embed-text:latest`) and `selfImprove` is `:266`
  (`enabled`, `reviewEvery`, `model`, `maxSteps`, `writeApproval`)
- `:64` `export interface Config`; the `memory` block is `:82-93` and `selfImprove` is
  `:101-112`
- `:342` `export function loadConfig(): Config` — merges `DEFAULTS` with `config.json`,
  then applies env overrides (`:351-369`: `LOAM_CODER_CHAIN`, `LOAM_CODER_ROUTING`,
  `LOAM_PORT`, `LOAM_HOST`, `LOAM_ROOT`)
- `:28-31` `fromEnv(name, fallback)` reads `LOAM_<NAME>` first, then the passed-in
  `MANUS_LOCAL_<NAME>` name

So H5's `LOAM_LESSONS_ENABLED` / `LOAM_LESSONS_MAX_CHARS` / `LOAM_LESSON_MIN_SCORE`
should be added to the `Config` interface, to `DEFAULTS`, and parsed in `loadConfig`
following the `LOAM_CODER_ROUTING` boolean pattern at `:359`
(`process.env.LOAM_X === "0" || process.env.LOAM_X === "false"`); `DEFAULTS` starts at `:221`.

### Chat route request/response details (for H8's route test)

- `POST /api/chat` at `src/server/http.ts:2603`; body fields at `:2604-2615`;
  `prompt` required (`:2617`); SSE headers at `:2636-2640`; `runTask` at `:2660-2671`;
  final `data: {"type":"task","taskId":...}` frame at `:2672`; error frame at `:2674`;
  `finally` ends the response at `:2675-2678`.
- The route test pattern to copy is `src/server/__tests__/retryLast.test.ts` (spin up
  `http.createServer`, call the handler directly, `fetch` it) and
  `src/server/__tests__/instructionHistory.test.ts` for the proposal assertions.
- `ServerDeps` (`src/server/http.ts:161-170`) is what `startServer` (`:410`) receives;
  `runTask` is a required dep (`:169`), and `src/index.ts:711-716` passes
  `memory: memory ?? undefined`. H8's hook needs the task's prior assistant text, which
  is available from `getTask` (`src/server/db.ts:144`).

### The `.jdone` / marker situation in this worktree

- `.jdone` is **tracked** (`git ls-files` lists it) and its committed content is a long
  rollup of prior manus-parity agent reports (D2/D10/D19/D17/D4/N20/C17/J10/V13/...).
- The working tree shows `deleted: .jdone` — an uncommitted deletion left by the worktree
  setup. H0 must not restore or commit it; the task's own `.jdone` is created at the end
  per the runner rules, and the pre-existing deletion is preserved as-is (it is not this
  task's file to resolve).
- `docs/handoff/watchdog.ps1`, `qa/*.png`, `packages/tests/visual/baselines` and any
  ZCode/Codex files were not read or touched.

---

## Spec assumptions that are wrong (BUILD_SPEC §13 / H0 acceptance item 5)

| # | Spec claim | Reality (evidence) | Impact |
|---|---|---|---|
| W1 | §6.2 note [U1]: `embedder.embed(text): Promise<number[]>` | `embed(texts: string[]): Promise<number[][]>` (`src/memory/embeddings.ts:12`); single-text is `embedOne(text)` (`:48`) | H2 must call `embedOne` (or `embed([text])`); the spec code does not compile as written |
| W2 | §6.4: `ollama.chatText({ cfg, system, user, json: true })` | `ollama.chat({ model, messages, temperature, timeoutMs })` → `ChatResult.content` (`src/ollama.ts:42,54,168`; `src/learning/critic.ts:76-84`) | H4 must use the `chat` shape; the `as any` is removable |
| W3 | §6.7 A: hook `appendMessage()` in the chat route | `appendMessage` is not called by the chat route; the user message is pushed by `queueTaskRun` (`src/server/db.ts:320`), and `appendMessage` is only used by sessionControl/grokbot/swarm | H8 hooks `POST /api/chat` (`src/server/http.ts:2603`) before `runTask`, reading the prior assistant text from `getTask(taskId).messages` |
| W4 | §13 U5 decision B: planner prompt in `src/agent/planner.ts` | the system prompt is built in `src/agent/loop.ts:220-235` from `buildSystemPrompt` (`src/agent/prompt.ts:67`); `planner.ts` only logs | H5 injects via `extraContext` (`prompt.ts:131`) or `systemSuffix` (`loop.ts:232-235`) |
| W5 | §13 U6 decision A: existing `src/server/routes/*` | no learning router exists; `GET /api/learning` is inline at `src/server/http.ts:1058-1062` backed by `src/server/learning.ts` | H8 creates `src/server/routes/learning.ts` (decision B) and dispatches it near `http.ts:1805` |
| W6 | §10: "run the repo's existing redaction helper if one exists [U7]. Otherwise reject any text matching `/(sk-|ghp_|xox[bp]-|AKIA|-----BEGIN)/`" | `src/memory/redact.ts:26,33,38` provides `findSecret`/`containsSecret`/`assertNoSecret` with a superset of those patterns | H2/H4 use `assertNoSecret` (decision A) |
| W7 | §11: global gate `npm run build:web` | no such root script (`package.json:12-82`); it is `packages/web/package.json:8` `"build": "next build"` | the gate is `(cd packages/web && npx next build)` (decision B) |
| W8 | §6.6 [I]: `proposeInstructions` returns an `InstructionProposal` with `id` (inferred) | confirmed: `:241` returns `InstructionProposal`, `id` field at `:20-28` | H6 needs no signature change |
| W9 | §13 U3: instruction-proposal UI location unverified | `packages/web/src/components/agents/InstructionHistory.tsx:43,67,148-179` + `AgentThreadView.tsx:203,505-510` | H9 does not need a new proposals list |
| W10 | §12: "Regression: `npm run check:selfimprove` and `npm run check:eval` must still pass [O scripts exist in `package.json`]" | confirmed: `package.json:28` `check:selfimprove`, `:29` `check:eval` | no action; noted for H5–H8 |
| W11 | §6.7 C: "in `critic.ts`, the critic already returns `lessons: string[]`" | confirmed: `src/eval/types.ts:51` `lessons: string[]`, populated at `src/learning/critic.ts:45` | H8's hook point C is valid |
| W12 | §3: `src/learning/harness/*` files are new | confirmed: the directory does not exist on this baseline | no duplication risk for H1–H6 |
| W13 | §13 E12: "Box snapshot = manus-parity HEAD [U]" | resolved: this worktree is at `manus-parity` with 0 commits ahead; all paths above are the real ones | H0 closes E12 |
| W14 | §2: storage reuses `node:sqlite` `entities` via `putEntity/allEntities` (`sqliteStore.ts:49-61`) | confirmed, and the line numbers are `:54`/`:58`/`:62` (the spec's `:49-61` range is off by a few lines) | cosmetic; H2 uses the real line numbers |
| W15 | §10: new config keys `LOAM_LESSONS_*` in `src/config.ts` | `Config` (`:64`), `DEFAULTS` (`:221`, `memory` `:254-263`), and env parsing in `loadConfig` (`:342-377`, boolean pattern at `:359`) | H5 adds them following the `LOAM_CODER_ROUTING` pattern |

---

## Verify

H0's own acceptance is "the report answers every listed unknown with file:line". The
unknowns and their answers:

- **U1** → `src/memory/embeddings.ts:12` (`embed`) and `:48` (`embedOne`); codec at
  `:55,60,68,79`; embedder constructed at `src/setup/runtime.ts:89`.
- **U2** → `src/learning/critic.ts:76-84` (`ollama.chat`), contract at
  `src/ollama.ts:42,54,168`, model choice at `critic.ts:53`.
- **U4** → `POST /api/chat` at `src/server/http.ts:2603`; append primitive at
  `src/server/db.ts:150`; chat-path append at `src/server/db.ts:320`; other appenders at
  `src/server/routes/sessionControl.ts:157`, `src/server/bridge/grokbot.ts:146`,
  `src/swarm/service.ts:232,468`; retry helper at
  `src/server/routes/retryLast.ts:34,52`.
- **U5** → `src/agent/loop.ts:220-235`, builder at `src/agent/prompt.ts:67`, injection
  slot at `src/agent/prompt.ts:131`.
- **U6** → `src/server/http.ts:1058-1062` (inline) + `src/server/learning.ts:5-36`;
  router pattern at `src/server/http.ts:79-109` and `:1760-1807`.
- **U7** → `src/memory/redact.ts:26,33,38` (guard) and `src/log.ts:14` (output redaction).
- **U8** → `packages/web/package.json:8` `"build": "next build"`; no root `build:web`.

Gates run from the worktree root (H0 changes no source, so these establish the baseline
the later H tasks must keep green):

1. `npx tsc --noEmit`
2. `npm run build:server`
3. `(cd packages/web && npx next build)`
4. `npm run check:encoding`
