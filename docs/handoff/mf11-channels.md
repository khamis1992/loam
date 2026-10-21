# MF11 — Messaging Channels (Telegram first, plus Email) — Handoff

Branch `mf/mf11`. Build + mock-test only: no real accounts, no real sends, no network calls in tests.

## Commits
- `332f06d` feat(channels): Telegram+Email channel core, bindings router and routes handler (MF11)
- `758bbae` fix(channels): dedupe telegram updates, awaitable email handler chain (MF11)
- `84ea616` test(channels): mock-fetch telegram poll/send, router bindings, email mock provider, route handler (MF11)
- `170b661` feat(web): Channels tab in agent info pane with Telegram/Email cards and binding UI (MF11)

## Files
New (server):
- `src/server/channels/types.ts` — `Channel` interface (`onInbound(handler)`, `start`, `stop`, `send(chatId, text)`), `InboundMessage`, `ChannelName` (`'telegram' | 'email'`), `ChannelStatusSummary`.
- `src/server/channels/telegram.ts` — `TelegramChannel`: Bot API long polling (`getUpdates`/`sendMessage`) via injectable `fetch`; token read ONLY from `LOAM_TELEGRAM_BOT_TOKEN`, never logged; unconfigured = no network, no-op start. Exports `pollOnce()` for deterministic tests and `updateToInbound()` mapping. Dedupes updates by offset.
- `src/server/channels/email.ts` — `EmailProvider` abstraction; `MockEmailProvider` (in-memory outbox, `deliver()` fixture hook, zero network) and `ImapSmtpEmailProvider` (config-only stub: reports configured from `LOAM_EMAIL_*`, throws on send — no real send). `EmailChannel` maps chat id = email address. `createEmailProvider(env)` picks provider from `LOAM_EMAIL_PROVIDER` (default `mock`).
- `src/server/channels/router.ts` — sqlite `channel_bindings` table (idempotent `CREATE TABLE IF NOT EXISTS`, `UNIQUE(channel, chat_id)`); `listBindings/getBinding/findBinding/createBinding/deleteBinding`; `ChannelRouter` routes inbound: binding lookup (the binding table IS the chat-id allowlist — unbound chats ignored) → `createTask(prompt, title, null, agentId)` (existing task path, lands on the agent's permanent thread) → `deps.runAgentTurn` → reply back via `channel.send(chatId, text)`. `startChannelRouter(deps)` + `channelStatus()`.
- `src/server/routes/channels.ts` — exports `async function handleChannelRoutes(req, res, p, ctx?): Promise<boolean>`.

New (tests): `src/server/__tests__/channels.test.ts` — 17 tests, all offline (mock `fetch`, in-memory outbox, fake req/res). Runs with `npx tsx --test src/server/__tests__/channels.test.ts`.

Edited (minimal, localized):
- `src/index.ts` — 1 import + `startChannelRouter({ runAgentTurn })` after `startScheduler` (uses the real `runTask`; reply text returned to the channel) + `stopChannelRouter()` in shutdown.
- `packages/web/src/components/agents/AgentInfoPane.tsx` — new `Channels` tab (`ChannelsTab` component): Telegram/Email cards with configured status, "Not configured — set LOAM_TELEGRAM_BOT_TOKEN" hint (server-provided), bound chat list with remove, chat-id bind input.
- `packages/web/src/i18n/en.json`, `ar.json` — 11 new keys (Channels, Telegram, Configured, Not configured, Bind, Chat id, Email address, Remove binding, No chats bound yet., Failed to load channels, Not configured - set {var}).

NOT touched: `src/server/http.ts` (clean; see below), package.json/lockfiles, all do-not-touch files.

## REQUIRED: mount the routes (2 lines for the supervisor to add to src/server/http.ts)
1. Import (next to the other routes imports, ~line 78):
```ts
import { handleChannelRoutes } from "./routes/channels.js";
```
2. Dispatch (next to the other route dispatches, ~line 1633):
```ts
if (await handleChannelRoutes(req, res, p)) return;
```

## New routes (exact shapes)
- `GET /api/channels` → `{ channels: [{ name: 'telegram'|'email', configured: boolean, envVarNames: string[], hint?: string }] }`
- `GET /api/agents/:id/channels` → `{ bindings: [{ id, channel, chatId, agentId, createdAt }] }` (404 if agent missing)
- `POST /api/agents/:id/channels` body `{ channel: 'telegram'|'email', chatId: string }` (or `{ address }` for email) → `{ binding }` (400 invalid, 404 agent missing; rebinding the same chat re-points it)
- `DELETE /api/agents/:id/channels/:bindingId` → `{ deleted: true }` (404 if binding missing or belongs to another agent)

No new agent tools → no runTools.ts change needed.

## Verification (this worktree)
- `npx tsc --noEmit` — 0 errors
- `npx tsc --noEmit -p packages/web/tsconfig.json` — 0 errors
- `npm run build` in packages/web — fails with the KNOWN Turbopack "Could not find next/package.json" node_modules-junction worktree issue; web tsc is the source of truth (per task instructions)
- Tests: 45/45 pass across all 6 server test files (17 new)

## Test live (after supervisor mounts the routes + sets env)
1. `set LOAM_TELEGRAM_BOT_TOKEN=<token from @BotFather>` and start the server.
2. Create a Telegram bot with @BotFather; message the bot from your chat.
3. UI → agent → Channels tab → Telegram card shows "Configured"; enter your chat id and Bind (get the chat id by messaging the bot once — the server logs `channels: telegram inbound chat=<id> ... task=... ignored/unbound` for unbound chats).
4. Send a message from the bound chat → a task is created on that agent's permanent thread; the agent's final reply text is delivered back to the chat via `sendMessage`.

## What Khamis must supply
1. **Telegram (works today):** a BotFather token → env var `LOAM_TELEGRAM_BOT_TOKEN`. Nothing else. The chat ids to bind come from whoever messages the bot.
2. **Email (mock only for now):** `LOAM_EMAIL_PROVIDER=mock` (default) needs nothing. A real mailbox later needs: `LOAM_EMAIL_PROVIDER=imap-smtp`, `LOAM_EMAIL_IMAP_HOST`, `LOAM_EMAIL_IMAP_PORT`, `LOAM_EMAIL_SMTP_HOST`, `LOAM_EMAIL_SMTP_PORT`, `LOAM_EMAIL_USER`, `LOAM_EMAIL_PASSWORD` — plus implementing the throwing bodies in `ImapSmtpEmailProvider` (`src/server/channels/email.ts`); no IMAP/SMTP client exists yet by design (no real send in this task).

## What's left
- Supervisor: add the 2 http.ts lines above (I was not allowed to edit http.ts; it was clean).
- Real IMAP/SMTP provider implementation (stub throws by design).
- Optionally surface per-agent bindings on the agent GET payload; currently fetched via the dedicated endpoint.
- Outbound reply is the run's final text only; streaming/interim updates are not sent to channels.
