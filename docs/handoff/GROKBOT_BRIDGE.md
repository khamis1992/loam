# Grok Bot mirror + one-way bridge

Grok Bot (source of agents) can import its agents and skills into Loam and,
afterwards, mirror read-only notes or explicitly trigger runs for its agents.
Everything here is one-way: **Grok Bot → Loam**.

Artifacts:

- Importer: `src/server/grokbotImport.ts` (agent provenance `source` lives on
  `AgentRecord` in `src/server/agents.ts`, persisted in `data/agents.json`).
- Bridge store: `src/server/bridge/grokbot.ts` (in-memory recent-cache + sqlite
  `grokbot_mirror` table in `data/manus.db`).
- Routes: `src/server/routes/grokbotBridge.ts`, dispatched from
  `src/server/http.ts`.
- UI: agents list badge (`packages/web/src/components/agents/GrokBotBadge.tsx`)
  and read-only mirrored chat notes (`packages/web/src/components/chat/GrokBotNote.tsx`,
  merged in `AgentThreadView`).
- Tests: `src/server/__tests__/grokbotImport.test.ts`,
  `src/server/__tests__/grokbotBridge.test.ts`.

## Phase 2 — import a Grok Bot bundle

`POST /api/agents/import-grokbot` with body `{ bundle }`:

```json
{
  "bundle": {
    "agents": [
      {
        "id": "gb_1",
        "name": "Scout",
        "title": "Scout",
        "description": "Watches inbox trends",
        "routines": [{ "name": "hourly", "prompt": "Check the inbox", "schedule": "0 * * * *", "enabled": true }],
        "referencedSkills": ["digests"]
      }
    ],
    "skills": [{ "name": "digests", "description": "Digest helper", "body": "..." }]
  }
}
```

Behaviour:

- Every agent is created with `source: "grokbot"`; `instructions` are derived
  as the description plus a `Referenced skills: …` note.
- Skills are created once each as global skills (`skill_create`).
- Every routine with a 5-field cron `schedule` becomes a Loam cron schedule
  bound to the agent (`addSchedule(..., "cron", ..., { cron })`); the interval
  hint is approximated from the expression (fallback 3600s).
- Idempotent: agents whose `name` (+ `source:"grokbot"`) already exist are
  skipped. Response summary: `{ agents, skills, schedules, skipped }`.
- Bad bundle shapes return 400 via `sanitizeGrokbotBundle`.
- `POST /api/agents` and `POST /api/agents/import` also accept an optional
  `source` string (sanitized to ≤32 chars) in case you need other origins.

The web agents list renders a subtle "Grok Bot" badge next to the name of any
agent with `source === "grokbot"`.

## Phase 3 — bridge endpoints

### `POST /api/bridge/grokbot/mirror` (read-only mirror)

```json
{ "agentRef": "Scout", "from": "Grok Bot", "text": "FYI: deploy finished", "ts": "2026-10-21T10:00:00Z" }
```

- `agentRef` resolves to an agent with `source: "grokbot"` by Loam agent **id**
  or **name**; unknown refs → 404.
- The message is stored (`grokbot_mirror` table + in-memory recent cache) and,
  when the agent already has a mapped chat thread, appended into that thread as
  a labelled note (`from Grok Bot:` + text).
- **Never** starts a run or any tool/action. Sending `execute: true` here is
  rejected with 400 — execution must use `/task` with a token.
- `GET /api/bridge/grokbot/mirror?agentRef=<ref>[&limit=N]` lists stored
  messages for introspection/tests.
- In the agent chat the mirrored note renders muted with a "Grok Bot" chip and
  no action buttons.

### `POST /api/bridge/grokbot/task` (execute, token required)

```json
{ "agentRef": "Scout", "text": "Run the weekly recap", "execute": true, "token": "..." }
```

- Runs only when `execute === true` **and** the token matches the local bridge
  token. Otherwise: 400 (execute flag missing/false), 403 (bad token), 429
  (rate-limited: max 20 executions per agentRef per 60s window).
- The token is fixed-length timing-safe compared (sha256 digests), and is never
  logged; logs contain the agent name only.
- When valid, the instruction becomes a normal agent run: a task is created for
  the agent and executed through the shared `__loamRunTask` engine (202 response
  with `{ taskId, agentId }`).

## Bridge token setup

1. Preferred: set the environment variable `LOAM_BRIDGE_TOKEN=<secret>` on the
   machine where Loam runs.
2. Alternatively: write the token into `data/bridge-token` (one line,
   trimmed). The file is read at request time, so rotating it requires no
   restart.
3. Keep the token out of any model context or log; share it only with Grok Bot.

## Safety properties

- Mirror ingest is storage-only: no task, run, approval or tool call can be
  triggered by a mirrored message.
- Execute path requires both the explicit `execute:true` flag and a matching
  token; both are validated before any agent resolution happens.
- Rate limiting guards the execute endpoint ahead of token checks.
