# OPB — Connectors (OAuth framework + GitHub / Gmail / Google Calendar)

Branch `mf/opb`. No real sign-in or provider network call happens outside an explicit user connect flow; all tests mock `fetch`.

## Commits
- `01e2381` OPB: OAuth connector framework (PKCE + encrypted tokens), providers, routes, agent tools
- `8db2acf` OPB: register connector tools; expose connector tools in runs only while connected (src/index.ts)
- `2a9fa2d` OPB: connector tests; per-agent tool denials win over the connector grant
- `2197e89` OPB: Settings>Connectors OAuth cards + composer connector icons reflect connected state

## Files
New:
- `src/server/connectors/oauth.ts` — generic OAuth2 authorization-code + PKCE (S256): `buildAuthUrl`, `completeCallback`, `exchangeCode`, `refreshTokens`, `getAccessToken` (auto-refresh + re-seal), `disconnect`, `isConfigured/isConnected/getAccount`. Tokens + account string are sealed **encrypted via the existing `secretsVault.ts`** (agent ids `connector-github`, `connector-gmail`, `connector-calendar`). Connection state (id → connected/connectedAt) in `DATA_DIR/connectors.json` — no plaintext secrets there. Env vars are read at call time; values are never logged (vault `registerSecretValue` redacts them).
- `src/server/connectors/providers/github.ts` — GitHub OAuth app, scope `repo`, `LOAM_GITHUB_CLIENT_ID` / `LOAM_GITHUB_CLIENT_SECRET`.
- `src/server/connectors/providers/google.ts` — Gmail (readonly + compose scopes) and Calendar (calendar.events), shared `LOAM_GOOGLE_CLIENT_ID` / `LOAM_GOOGLE_CLIENT_SECRET`, `access_type=offline&prompt=consent` for refresh tokens.
- `src/server/connectors/index.ts` — registry, `CONNECTOR_TOOLS` map, `connectedConnectorToolNames(disabledTools?)`.
- `src/server/routes/connectors.ts` — `handleConnectorsRoutes(req,res,p,ctx)`.
- `src/tools/connectorTools.ts` — 8 agent tools; write tools (`github_create_issue`, `gmail_create_draft`, `calendar_create_event`) route through `src/server/approvals.ts` (`createApproval` + `waitForDecision`, emitting `approval_required`); `gmail_create_draft` creates a draft and never sends.
- `src/server/__tests__/connectors.test.ts` — 10 tests (see Verification).

Minimal shared-file edits (localized):
- `src/index.ts` — 2 import lines; `rt.registry.registerAll(createConnectorTools());`; run-allowlist line now merges `connectedConnectorToolNames(agent?.disabledTools)` so connector tools reach a run **only while connected**, and agent tool denials still win.
- `packages/web/src/components/settings/ConnectorsPane.tsx` — OAuth cards section (status Not configured / Disconnected / Connected-as-account, Connect opens authUrl in a new tab, Disconnect). MCP-server section relabeled "MCP Servers".
- `packages/web/src/components/chat/Composer.tsx` — GitHub/Gmail/Calendar icon cluster fetches `/api/connectors`; unconnected icons render `opacity-30 grayscale` with Connected/Disconnected tooltips.
- `packages/web/src/i18n/en.json` + `ar.json` — 7 new keys (Connect, Disconnect, Not configured, hint strings, `Connected as {account}`).

## Routes (exact shapes)
- `GET /api/connectors` → `{ connectors: [{ id, name, configured, connected, account|null, envVars: [clientIdVar, clientSecretVar] }] }`
- `POST /api/connectors/:id/connect` → 200 `{ authUrl }` | 400 `{ error: "Not configured", envVars: [...] }` (redirect_uri = `<host>/api/connectors/:id/callback` from forwarded/host headers)
- `GET /api/connectors/:id/callback?code&state` → HTML success/failure page (state validated, one-shot, 10-min TTL)
- `POST /api/connectors/:id/disconnect` → `{ ok: true }` (deletes sealed tokens + state)

## Agent tools
Read (approval-free, exposed only while connected): `github_list_repos {limit?}`, `github_list_issues {repo, limit?}`, `gmail_search {query, limit?}`, `gmail_read {id}`, `calendar_list_events {days?, limit?}`.
Write (approval-gated first, then bearer call): `github_create_issue {repo,title,body?}`, `gmail_create_draft {to,subject,body}` (draft only), `calendar_create_event {summary,start,end,location?,description?,attendees?}`.
All call the public REST APIs (`api.github.com`, `gmail.googleapis.com`, `www.googleapis.com/calendar`) with `Authorization: Bearer <token>` fetched from the vault.

## http.ts mounting (supervisor: I did not touch it — `git status --short src/server/http.ts` is clean)
Add these 2 lines:
1. After line 77 (`import { handleSchedulesRoutes } ...`):
   `import { handleConnectorsRoutes } from "./routes/connectors.js";`
2. After line 1631 (`if (await handleSchedulesRoutes(req, res, p)) return;`):
   `if (await handleConnectorsRoutes(req, res, p)) return;`

Ordering note: the callback GET path `/api/connectors/:id/callback` must not be shadowed — nothing under `/api/connectors` is handled elsewhere in http.ts today.

## Live test recipe
1. `git` (supervisor) adds the 2 http.ts lines; start the server (`npm run dev`).
2. Settings → Connectors: the three cards show **Not configured** with the env var names.
3. Set `LOAM_GITHUB_CLIENT_ID/SECRET` (OAuth app callback URL = `http://127.0.0.1:<port>/api/connectors/github/callback`) and restart → card shows Disconnected → **Connect** opens GitHub → approve → callback page "connected as <login>"; card shows Connected-as-<login>; composer GitHub icon lights up.
4. Agent run: model now sees `github_list_repos` etc.; `github_create_issue` pauses the run until approved in the approvals center (`/api/approvals`).
5. `data/secrets-vault/connector-github.json` contains only AES-256-GCM ciphertext.

## Verification
- `npx tsc --noEmit` → 0 errors; `npx tsc --noEmit -p packages/web/tsconfig.json` → 0 errors.
- `npx tsx --test src/server/__tests__/*.test.ts` → 38/38 pass (10 new: PKCE+state in auth URL, callback exchange seals encrypted tokens, state rejection, refresh+re-seal, bearer on tool calls, approve/deny paths, exposure only-while-connected + denial precedence, disconnect cleanup, unconfigured env-var listing).
- `npm run check:modes` pass; `npm run check:encoding` pass.
- Web `npm run build` fails with the known worktree junction error (`Could not find next/package.json`) — per task rules, web tsc is the gate.
- Pre-existing (unrelated): vitest picks up Playwright e2e specs and `settings.test.tsx` fails `@/store` alias resolution — unchanged behavior on this branch.

## What's left
- Supervisor to mount the 2 http.ts lines.
- Real provider credentials + exact registered redirect URIs (per connector) are an operator step; Google refresh tokens require the consent prompt we already send.
- Optional later: per-run UI for connector approval cards (ApprovalCard stub already tracks approvals center).
