# GAP_REVIEW: manus-local ("Loam" v0.5.25) vs BUILD_SPEC.md (Manus Studio 2.0.8 clean-room spec)

Reviewed 2026-10-19 (Asia/Riyadh). Source: `C:\Users\khamis\Desktop\manus-local`, copied (no node_modules, build outputs, config.json or .env*) to `/workspace/re/manus-local/src`. No PC files were changed; the temp zip was deleted. No real keys were used.

## 1. Verdict
Loam is a **capable, working local agent workspace**, but it is a **different product**, not a Manus clone. It shares about 15–20% of the Manus spec's *contract*: the stack, protocol, tokens, screens and auth all differ. Agent *capability* is much closer and in some areas goes beyond the spec. To reach Manus parity you would need a new web shell plus a protocol and adapter layer on top of Loam's backend. Patching the current UI piecemeal would not get there.

## 2. Run results (box, Linux, Node 22.23)
| Step | Result |
|---|---|
| `npm ci` | Fails: node-pty native build (node-gyp). Passes with `--ignore-scripts`. |
| `tsc --noEmit` | **0 errors** |
| `npm run build:server` (esbuild) | OK (dist/server.cjs) |
| `tsx src/index.ts` with the example config | Starts: "Loam ready → 127.0.0.1:7788", 144 tools, MCP filesystem/memory/sequential-thinking OK; memory-skills and loam-bridge MCP failed; pty unavailable (no native build). |
| HTTP probes | `/` 200, `/api/modes` 200 (7 modes), `/api/settings` 200, `/api/approvals` 200, `/api/models` **500** (no Ollama), `/api/health` 404 |
| `POST /api/chat {"prompt":"hi"}` | SSE stream: task → task-status → mode → workmode → plan → plan_step → step → **error** `model glm-5.3-flash:cloud failed (Cannot convert argument to a ByteString …)`. No model on the box was expected. The ByteString error suggests a non-Latin-1 character in an HTTP header (probably an auth header built from a placeholder or empty key). Treat it as a likely bug. |
| Note | `LOAM_ROOT` was set, but the log showed workspace=`<repo>/workspace` (config.workspace wins?). Verify. |
| Screenshot | `/workspace/re/manus-local/loam-home.png` (1024 headless): Arabic RTL dark "مركز القيادة الذاتية — Loam" home, mode chips, composer, studio cards, right sidebar "مهمة جديدة / المهام / المشاريع / المواعيد". |

## 3. Parity by area
| Area (spec §) | Parity | Evidence / gap |
|---|---|---|
| Stack & versions (§2) | 15% | Electron ^44.7.2 (spec 43.6.0); **no Next.js/React/Redux/Tailwind**: the UI is vanilla JS/HTML (`ui/*.html`, `ui/app.js`). Node server via tsx/esbuild, node:sqlite (spec: Postgres/pg-mem mock). |
| File structure (§3) | 5% | Flat `src/ ui/ electron/`; no `packages/{web,desktop,shared,mock-server}` monorepo. |
| Design tokens (§4) | 0–5% | **0 of the 112 spec hex values** appear in the 362 UI hex values. Tokens are oklch with a per-mode hue (`ui/styles.css:5-37`). Default theme is dark (spec: light). No Inter/density tokens. |
| Screens S1–S21 (§5, §5.9) | 10% | No Login (S1). The Home layout differs (hero, mode chips, studio cards). The sidebar is on the right because of RTL, which is only correct in Arabic mode. Absent: the Settings dialog with its tabs, My Computer, the update popover, the desktop activity indicator, and the model/effort menus. Present in another form: the task view (`ui/task-view.js`) and an approvals center (companions UI). |
| Strings EN/AR (§5.8, §6.1) | 15% | Arabic is hard-coded (`<html lang="ar" dir="rtl">` in every page, Arabic literals in JS). There is **no i18n layer and no English UI**, and the spec's en→ar string table is not used. |
| RTL (§5, §12.3) | 40% | RTL works well, but it is fixed rather than switched per locale. There is no LTR mode. |
| Components (§6) | 10% | No Button/Dialog registry, Composer (Enter/Shift+Enter is present), EventList rows or ApprovalCard component. Icons come from a custom `icons.js`, not lucide. |
| Data models (§7.1, §7.4) | 5% | No protobuf types and no session/event schema per spec. The local SQLite store uses its own schema (`src/server/sqliteStore.ts`). |
| RPC (§8.1) | 0% | No Connect RPC: 119 ad-hoc REST routes under `/api/*` (`src/server/http.ts`). |
| Realtime socket (§6.10, §7.2, §8.2) | 5% | No socket.io, `{type:"event"}` envelope, `join_session` v2 replay, `user_message contents[]`, `stop_session` or any of the 72 client types. SSE uses its own events (`src/agent/events.ts`: assistant_token, tool_call, tool_result, plan, plan_step, approval_required…). Rough concept mapping exists: tool_call/result ≈ toolUsed, plan ≈ planUpdate. Cancelling works through its own route (runControl). |
| Upload 3-step (§8.1) | 0% | A single raw POST to `/api/file?path=` (`http.ts:1715`). No presign → PUT → uploadComplete. |
| Desktop IPC (§6.9, §8.3) | 5% | Preload exposes `window.loam`/`window.manusLocal` with 2 handlers (`pick-folder`, `loam-updates`). No `desktop-ipc-meta/api/event` channels and none of the 28 namespaces. |
| Auth (§9.1, §10.1) | 0% | No login, no deep link, no `session_id` cookie. The local server has no auth (127.0.0.1 only). |
| Approval cards & permission modes (§5.4, §6.7, §7.2.2) | 30% | A sensitive-action gate exists (`src/server/approvals.ts`, `approval_required` event, approve/deny API). Missing: the modes ask_for_approval/approve_for_me/full_access, the in-chat card with the spec strings, workspace-directory access requests and localExecutionApproval events. |
| Model / effort menus (§5.2) | 10% | `/api/models` lists Ollama/cloud models. No Max/2.0/Lite/Flex menu and no Medium/High/Extra/Ultra effort panel. |
| Offline (§5.9, 10 s grace) | 20% | The connection badge flips after a 5 s poll fails (`ui/app.js:283-290`). There is no grace banner or reconnect/replay. |
| Updates (§5.6, §9.5) | 40% | electron-updater plus a local feed (`electron/updater.cjs`, `tools/update-feed`). No 4 h check and popover states as specified, and no store-managed message. |
| Agent backend (§8.5) | 60% | Strong: plan→execute→verify/critique/replan loop (`src/agent/orchestrator.ts`, `loop.ts`), 144 tools (shell/pty, files, browser via Playwright, computer use, web_search/web_fetch, MCP, memory, skills, subagents, scheduler). Gaps: no **VM sandbox** (it runs on the host with a policy layer), no `map_reduce`/**Wide Research** (≤20 parallel), and tool names and schemas differ from §8.5.1 (terminal, text_editor, search, webpage_extract, message, idle, suggestion). |
| Security / fuses (§10.2–10.4) | 45% | contextIsolation ✓, nodeIntegration false ✓, sandbox true ✓ (`electron/main.cjs:190-192`). **`asar: false`** (`electron-builder.yml:32`) and no fuse flipping (RunAsNode, cookie encryption, asar integrity) as §10.4 requires. Only 2 IPC handlers, so the IPC surface is small. |

**Weighted overall parity with the spec contract: about 15–20%.**

## 4. What works (evidence)
- It builds clean: tsc reports 0 errors and esbuild succeeds. The server boots with 144 tools and 3 MCP servers.
- SSE task streaming with plan and step events; task queue/status; 7 modes (`/api/modes`).
- Arabic RTL UI rendered (screenshot). Theme light/dark/system (`ui/theme.js`).
- Approvals API and event; Electron renderer isolation; local update feed; an extensive `check:*` test-script suite.

## 5. Gaps and development tasks (priority order)

### P0: required for "works like Manus"
1. **Protocol adapter (Connect RPC + socket.io).** Add a `/{pkg}.{Service}/{Method}` JSON RPC layer and a socket.io `message` channel that wraps Loam AgentEvents in `{id,type:"event",sessionId,timestamp,event}`. Map the events: assistant_token→chatDelta; tool_call/tool_result→toolUsed (status, detail.terminal/textEditor/…); plan/plan_step→planUpdate/newPlanStep; status→liveStatus. Support join_session v2 (with replay), leave_session, user_message (contents[], extData), stop_session.
   *Accept:* §6.10 / §7.2 / §8.1 / §8.2 / §9.2–9.3 flows pass against the §12.2 E2E using real Loam tasks.
2. **New web shell to spec.** Next.js static export + React + Redux + Tailwind, with tokens copied from §4.1 (hex values exact), Inter, density §4.5, light default. Implement S1–S21 per §5.9 (Home §5.2, Task view §5.3, Settings §5.5, My Computer §5.4, etc.).
   *Accept:* the §12.3 visual checklist (light/dark × en/ar) is ticked for every screen.
3. **i18n with EN default plus AR, and locale-driven RTL.** Use `t()` per §6.1 with the §5.8 string table, and set `dir` from the locale.
   *Accept:* every §5.8 string renders in both languages, and the layout mirrors only in ar.
4. **Approval cards and permission modes.** Add ask_for_approval/approve_for_me/full_access, the in-chat ApprovalCard (§6.7), localExecutionApprovalRequested/Resolved, change_local_permission_mode, resolve_local_execution_approval, and submit_workspace_directory_access.
   *Accept:* the §7.2.2 / §9.4 flow; deny leaves no side effects.
5. **Fix model call failure** ("Cannot convert argument to a ByteString" when the key is absent or non-ASCII): sanitise headers and fail with a clear "configure key" error. Also make `/api/models` degrade gracefully (empty list, not 500) when Ollama is down.
   *Accept:* a chat with no model returns a friendly error event, and `/api/models` returns 200.

### P1
6. Model menu (Max/2.0/Lite/Flex mapped to Loam models) and effort panel (Medium/High/Extra/Ultra mapped to step, verify and reflection budgets). *Accept:* §5.2 menus and strings; the choice is sent in user_message extData.
7. Upload in 3 steps: getPresignedUploadUrl → PUT → uploadComplete, plus a deviceAttachmentUploadNotify event. *Accept:* §8.1 upload; attachments show in the task view.
8. Desktop IPC to spec: `desktop-ipc-meta/api/event` channels and the 28 namespaces (stub the unused ones) with sender validation. *Accept:* §6.9 / §8.3 / §10.3.
9. Auth: login screen and deep-link flow with an httpOnly `session_id` (365 d). Locally, at least a per-install token on the 127.0.0.1 server. *Accept:* §9.1 / §10.1; unauthenticated requests get 401.
10. Wide Research (`map_reduce` tool, ≤20 concurrent subagents) and §8.5.1 tool-schema aliases (terminal, text_editor, search, webpage_extract, message, suggestion, idle). *Accept:* §8.5 / §8.5.1 schemas validate, and a 20-item research task fans out.
11. Offline: 10 s grace banner, auto-reconnect, replay via join_session. *Accept:* the S-offline state in §5.9.
12. Electron hardening: `asar: true` with integrity, and flip the fuses per §10.4. *Accept:* `npx @electron/fuses read` matches §10.4.

### P2
13. Execution sandbox (container/VM per task) instead of the host plus policy. *Accept:* §8.5 sandbox section.
14. Updates: 4 h check, popover states, store-managed message. *Accept:* §5.6 / §9.5.
15. Desktop activity indicator window (§5.7); notifier events session_new_message, credits_costed, etc. (§7.2.1).
16. Build hygiene: provide a node-pty prebuild or make pty optional in `npm ci` (it fails on Linux without build tools); make `LOAM_ROOT` take effect; add a `/api/health` route; pin Electron to the spec version or document the deviation.
17. Data model: align sessions/events with §7.1 / §7.4 (or an adapter).

## 6. Recommendation
Keep Loam's backend (orchestrator, tools, MCP, approvals) as the "real backend" (§11 agent A7). Build the spec frontend (A0–A4) against a protocol adapter (task 1). This reaches parity much faster than reworking the vanilla UI.
