# Loam (manus-parity @ 4509693): options with no working backend yet

The UI for these exists but there is no feature behind them. Khamis decides for each one: **keep (build)** or **delete**.

Size: S = under 1 day, M = 1–3 days, L = more than 3 days.

| # | Option | Where it appears | What building it would need | Size |
|---|---|---|---|---|
| 1 | Settings › Shortcuts | Settings nav ("Coming soon") | A static list of shortcuts plus a keybinding registry (Ctrl+K works today) | S |
| 2 | Settings › Personalization | Settings nav ("Coming soon") | Custom instructions stored in the backend and injected into the agent prompt | M |
| 3 | Settings › Connectors, plus the composer connector icons (GitHub/Gmail/Calendar +4) | Settings, composer | OAuth flows, token storage, and agent tools for each connector | L |
| 4 | Settings › Skills | Settings ("Coming soon") | Skill CRUD UI. A memory-skills MCP already exists in the backend and could be surfaced | M |
| 5 | Settings › In-App Browser | Settings ("Coming soon") | Electron WebContentsView driven by the agent's browser tool | L |
| 6 | Settings › Data controls | Settings ("Coming soon") | Export/delete-all endpoints and a training opt-out flag | S–M |
| 7 | Settings › Integrations / Developers | Settings ("Coming soon") | Fixed (OpenCode): API keys page (ApiKeysPane) over /api/api-keys CRUD; keys generated server-side, listed masked, revocable. Public API on the adapter still open | ✅ |
| 8 | Settings › Email / Phone / Wallet | Settings › Assets ("Coming soon") | Inbound email, telephony and billing. No backend at all | L each |
| 9 | Credits "1K", Free plan / Upgrade, referral card ("Share Loam with a friend / Get 500 credits each") | Home header, account menu, sidebar | A credit ledger and billing. The value is static today | M |
| 10 | Update button / updater | Settings › General | Fixed (OpenCode): electron-updater generic feed (LOAM_UPDATE_FEED_URL + local channel, scripts/updater-test-feed.mjs); Settings check/download/restart via the `updater` IPC namespace | ✅ |
| 11 | Share (public link) | Task header | Client-side "Copy link" works. A real public read-only share needs a share-token endpoint and a replay page | M |
| 12 | Message Copy / Retry | Not present on bubbles | Copy is client-only (S). Retry needs a re-run-last-turn backend call | S |
| 13 | Live computer screen (VNC) and browser view in "Loam's computer" | Task right panel | The panel already shows the command and its output. A live screen or browser view needs screen streaming | L |
| 14 | Approval cards / "Approve for me" | Composer chip, chat | Fixed (OpenCode): ApprovalCard renders a pending Loam approval from the adapter mapping (tool, human summary, args preview via GET /api/approvals/:id); Deny / Approve once / Always allow ("Approve for me") resolve through resolve_local_execution_approval, with "always" saving an agent allow-rule; the composer chip toggles per-task auto-approve (PUT /api/approval-tasks/:taskId + extData.approveForMe) | ✅ |
| 15 | Promo banner carousel ("Build an App / Create your Video") | Home top-right | Static marketing slides. Needs a content source, or delete it | S |
| 16 | Template gallery beyond 3 cards | Home | Clicking a card pre-fills the prompt. A real gallery needs data and images | S |
| 17 | Choose project / Downloads chips, Worktree checkbox, git branch chip ("main") | Composer context row | The branch shows a fallback. Needs a project picker bound to /api/projects plus worktree creation through the existing backend `parseWorktrees` | S–M |
| 18 | Model tiers Max / Lite / Flex (BYO key) | Model dropdown | The choice is stored but not mapped to different models. Flex needs a key input | S–M |
| 19 | Voice mode and mic buttons | Composer | Wiring to the existing STT server (scripts/stt_server.py) and TTS | M |
| 20 | Bell (notifications) and devices icon | Sidebar bottom | Fixed (OpenCode): client notifications store with stub feed (notificationsStore.ts); bell dropdown with unread dot + mark-read; devices icon → /app/computers | ✅ |
| 21 | Creations and Library pages | Sidebar | Fixed (OpenCode): single-call /api/files?list=1, /api/creative?list=1 scenes and /api/media list default; strict per-task contracts kept | ✅ |
| 22 | Projects / Automations create-edit | Sidebar pages | List only. Create, edit and delete UI over the existing /api/projects and /api/schedules | M |
| 23 | Computers / Agent Loam actions | Sidebar pages | List only (empty now). Needs pair-device and create-companion flows over the existing APIs | M |
