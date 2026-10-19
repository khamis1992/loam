# AGENTS_PLAN: Manus parity for manus-local (Loam)

Inputs (read these first, in every worktree): `docs/BUILD_SPEC.md` (the source of truth for design and protocol) and `docs/GAP_REVIEW.md` (the gaps and task list). **The design must match BUILD_SPEC exactly**: §4 tokens (exact hex values), §4.3 typography, §4.5 density, the §5.9 screen descriptions, the §5.8 strings, and §6 component behaviour.

## Git layout
- Base branch: `manus-parity`, which holds a local snapshot of the working tree. `main` is untouched. **Never push. Never merge into main.**
- Each agent works in its own worktree `C:\Users\khamis\Desktop\manus-parity-wt\aNN` on branch `mp/aNN-<slug>`. Commit often, with messages prefixed `[aNN]`.
- Integration: A10 merges the `mp/*` branches into `manus-parity` in phase 3 only.

## Global rules (apply to every agent)
1. Edit **only your owned paths**. If you need a change elsewhere, write the request into `docs/handoff/aNN-requests.md` (your own file) and code against the interface described in BUILD_SPEC.
2. Never read, print or commit secrets (`config.json`, `.env*`, `output/`, `data/`, vault files). Never push. Never touch `main`.
3. New frontend code lives in `packages/web` (Next.js 16 static export, React, Redux Toolkit, Tailwind, lucide-react) per BUILD_SPEC §2–§3. Shared protocol types live in `packages/shared`.
4. If a dependency is needed, install it with `npm install --ignore-scripts` inside the package you own. Do not commit node_modules.
5. Finish with: your verification commands passing, a `docs/handoff/aNN-report.md` (what you did, what's left, how to verify), and a final commit.
6. Work autonomously until every acceptance criterion passes. Do not stop to ask questions; make a documented design decision instead.

## Phases
- **P1 (parallel, start now):** A1, A2, A3, A6, A9 (contracts, foundation, security).
- **P2 (parallel, start now; code against the spec contracts, rebase onto P1 branches when they land):** A4, A5, A7, A8.
- **P3:** A10 (runs throughout: Wide Research and the e2e harness), then integration of all branches into `manus-parity` once the others report done.

## Agents

### A1 protocol-server: Connect RPC + socket.io adapter on top of Loam
Owns: `src/protocol/**` (new), the hook line in `src/index.ts`, and the root `package.json` `dependencies` (socket.io).
Task: implement the Connect RPC JSON routes `/{pkg}.{Service}/{Method}` (§8.1, §7.1) and a socket.io 4 `message` channel (§8.2). Wrap Loam AgentEvents in `{id,type:"event",sessionId,timestamp,event}` (§6.10, §7.2). Event mapping: assistant_token→chatDelta, tool_call/tool_result→toolUsed (status argumentsFinished/streaming/success/error with detail.terminal/textEditor/search/webpageExtract/mcp per §7.2.4), plan/plan_step→planUpdate/newPlanStep, status→liveStatus. Client messages: join_session (version 2, with replay of stored events), leave_session, user_message (contents[], extData), stop_session (cancels through runControl). Notifiers: session_new_message, session_info_update (§7.2.1).
Accept: §9.2 and §9.3 flows work end to end with a real Loam task; unit tests in `src/protocol/__tests__`.
Verify: `npx tsc --noEmit` and `npx tsx src/protocol/__tests__/run.ts`.

### A2 shared contracts + client lib
Owns: `packages/shared/**` and `packages/web/src/services/{rpc.ts,chatSocket.ts}`.
Task: TypeScript types for every §7.1 message, all 72 §7.2.3 client→server types, and the §7.2.1 event catalogue. Write the Connect JSON client (`rpc.ts`) and the `chatSocket.ts` service per §6.10, with reconnect and join_session replay.
Accept: types compile; the chatSocket unit tests (Vitest) cover the envelope, join/replay and stop. §12.1.
Verify: `cd packages/shared && npx tsc --noEmit` and `cd packages/web && npx vitest run src/services`.

### A3 web shell + design system
Owns: `packages/web/{package.json,next.config.*,tailwind.config.ts,postcss.config.*,tsconfig.json}`, `packages/web/src/styles/**`, `packages/web/src/components/ui/**`, `packages/web/src/components/shell/**`, `packages/web/src/app/layout.tsx`, `packages/web/src/store/**`.
Task: scaffold Next.js 16 static export + Redux + Tailwind. Copy `tokens.css` **verbatim** from §4.1, plus §4.2 shadows/radii, the §4.3 fonts, the §4.4 tailwind map and §4.5 density. Build Button/IconButton (§6.2), the Dialog registry (§6.3), Sidebar + SidebarTaskItem (§6.4), TitleBar (§6.8) and the §5.0 window chrome. Light theme by default, dark variant per tokens.
Accept: `next build` produces a static export; every §4.1 hex value appears unchanged; S-chrome matches §5.9 at 1280×840.
Verify: `cd packages/web && npm run build`.

### A4 screens: Home + Task view
Owns: `packages/web/src/app/app/**`, `packages/web/src/components/chat/**` (except ApprovalCard).
Task: Home/New task (§5.2, §5.9) with the Composer (§6.5: Enter sends, Shift+Enter adds a newline, IME-safe, placeholders). Task view (§5.3) with EventList and the row components (§6.6) for chatDelta, toolUsed (terminal, editor, search, webpage, mcp), plan, liveStatus and cascadeTaskClock.
Accept: the S2/S3 descriptions in §5.9 are met in light/dark × en/ar (§12.3); events stream live from the A1 server.
Verify: `npm run build` plus the Playwright screenshots in `packages/web/e2e/screens-home-task.spec.ts`.

### A5 Settings, My Computer, dialogs, update, activity indicator
Owns: `packages/web/src/components/settings/**`, `packages/web/src/components/dialogs/**`, `packages/web/src/app/desktop-activity-indicator/**`, `packages/web/src/components/update/**`, `packages/web/src/app/login/**`.
Task: the Settings dialog with all its tabs (§5.5), My Computer (§5.4), the update popover with its states plus the store-managed message (§5.6, §9.5), the activity indicator (§5.7) and the Login screen (§5.1). Cover every remaining S-screen in §5.9 not owned by A4.
Accept: each screen matches its §5.9 description and the §5.8 strings.
Verify: build + `packages/web/e2e/screens-settings.spec.ts`.

### A6 i18n EN/AR + RTL
Owns: `packages/web/src/i18n/**`, `packages/web/src/hooks/useLocale.ts`.
Task: `t()` per §6.1 with the complete en/ar tables from §5.8 (the `{product}` placeholder), English by default, and `dir` driven by the locale with full mirroring (§12.3). Add a lint script that fails on hard-coded UI strings in `packages/web/src/components`.
Accept: every §5.8 key exists in both languages; switching locale flips dir with no reload.
Verify: `npx vitest run src/i18n`.

### A7 approvals, permission modes, model/effort menus
Owns: `packages/web/src/components/approval/**`, `packages/web/src/components/model-menu/**`, `src/policy/permissionModes.ts` (new), `src/protocol/approvals.ts` (new; coordinate the import with A1 through its handoff).
Task: the permission modes ask_for_approval / approve_for_me / full_access; ApprovalCard (§6.7) in chat; localExecutionApprovalRequested/Resolved, change_local_permission_mode, resolve_local_execution_approval and submit_workspace_directory_access (§7.2.2, §9.4), bridged to Loam's `src/server/approvals.ts`. Model menu Max/2.0/Lite/Flex mapped to Loam models, and the effort panel Medium/High/Extra/Ultra mapped to step, verify and reflection budgets (§5.2), sent in user_message extData.
Accept: deny produces no side effect; the strings match §5.8.
Verify: unit tests + `e2e/approval.spec.ts`.

### A8 uploads + offline/reconnect
Owns: `src/upload/**` (new), `packages/web/src/services/upload.ts`, `packages/web/src/hooks/useOnline.ts`, `packages/web/src/components/offline/**`.
Task: the 3-step upload getPresignedUploadUrl → PUT → uploadComplete (§8.1) with local storage on the server, plus deviceAttachmentUploadNotify. A 10 s offline grace banner, auto-reconnect and replay (§5.9 offline state, §9.3).
Accept: an attachment round-trip test passes; simulated offline shows the banner after 10 s and recovers.
Verify: `npx tsx src/upload/__tests__/run.ts` + vitest.

### A9 security + backend bug fixes
Owns: `electron/**`, `electron-builder.yml`, `src/server/http.ts`, `src/agent/model.ts`, `src/ollama.ts`, `src/security/localAuth.ts` (new).
Task: fix the model-call failure "Cannot convert argument to a ByteString" (sanitise header values; send no auth header when the key is empty; give a clear error). `/api/models` returns 200 with an empty list when Ollama is down. Add `/api/health`. Honour `LOAM_ROOT`. Add a per-install local auth token on the 127.0.0.1 server (401 without it; the Electron preload injects it) (§10.1). Set `asar: true` with integrity and flip the Electron fuses per §10.4 (afterPack hook). Rework the preload/IPC to the `desktop-ipc-meta/api/event` channels with the §8.3 namespaces (stubs allowed) and sender validation (§10.3).
Accept: §10.1–10.4; `npx @electron/fuses read` matches §10.4; the GAP_REVIEW P0 #5 bug is gone.
Verify: `npx tsc --noEmit`, `npm run build:server`, and a curl test script `scripts/check-a9.ps1`.

### A10 Wide Research + QA/e2e + integration
Owns: `src/tools/mapReduce.ts` (new), `src/tools/registry.ts`, `src/tools/specAliases.ts` (new), `packages/web/e2e/{playwright.config.ts,harness/**}`, `docs/QA.md`.
Task: a `map_reduce` tool (≤20 concurrent subagents, §8.5), and §8.5.1 tool-schema aliases (terminal, text_editor, search, webpage_extract, browser, plan, message, suggestion, idle) mapped onto Loam tools. A Playwright `_electron` harness (§12.2) and the §12.3 visual checklist runner. Phase 3: merge every `mp/*` branch into `manus-parity` locally, resolve conflicts, then run the full build and e2e. Never touch main; never push.
Accept: §8.5.1 schemas validate; a 20-item research fan-out works; §12.2 passes on the merged branch.
Verify: `npx tsc --noEmit`, `npx playwright test`.
