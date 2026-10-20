# Unimplemented backend for home UI

Owned file: `packages/web/src/app/app/page.tsx`, `packages/web/src/components/chat/Composer.tsx`, `packages/web/src/components/home/**`.

| UI option | Where | What backend is missing | Current state |
|---|---|---|---|
| Promo banner carousel | Home hero top-right | No backend; carousel rotates 3 local prompts every 6s | UI-only; clicking prefills composer |
| Build/Create card line-art illustrations | Home cards | Decorative | UI-only SVG |
| Template thumbnail images | Home template row (`/templates/*.svg`) | No dynamic thumbnail service | Static SVG assets |
| Connector cluster (GitHub/Gmail/Calendar +4) | Composer footer | `/api/integrations` exists but is task-scoped (`taskId` required); no home-level connector config endpoint | UI-only decorative cluster |
| "Approve for me" chip | Composer footer | No home-level permission mode store; task-level approval cards exist | UI-only toggle (placeholder) |
| Voice-mode / Microphone buttons | Composer footer | `/api/agents/{agentId}/voice` exists but is agent-scoped; no home/global voice input endpoint | UI-only buttons |
| Git branch chip | Composer context row | `/api/worktree` returns 410; Loam git branches are task-scoped via Swarm | Reads `desktopSync.env.GIT_BRANCH` / `__AGENT_STUDIO_ENV__.gitBranch` / `__apis.system.getGitBranch()` if injected |
| Worktree checkbox | Composer context row | `/api/worktree` returns 410; Loam uses isolated task workspaces, not shared worktrees | UI-only checkbox |

| Sidebar nav rows (list pages) | `Sidebar.tsx` / `/app/*` pages | Create/edit/delete/actions not implemented; list pages are read-only | Navigate to list pages that proxy `GET /api/*` from the adapter to the Loam server |
| Notifications bell | `Sidebar.tsx` user row | No notification feed API | Opens Settings › General |

Wired to real backend:
- Model dropdown selection persists to `localStorage`.
- Credits pill fetches `POST http://localhost:8787/user.v1.UserService/GetAvailableCredits` with Bearer token from `window.__apis.auth.getToken()`.
- "Choose project" uses `window.__apis.system.showFolderDialog()`.
- "Downloads" chip reads `__apis.system.getDownloadsPath()` or `desktopSync.env.DOWNLOADS_PATH`.
- "Start from a local file" uses hidden file input + drag/drop; files are uploaded via `services/upload.ts` before task navigation.
- After creating a task, `dispatch(loadSessions())` refreshes the sidebar.
- The protocol adapter (`src/protocol/adapter.ts`) proxies `GET /api/*` to `http://127.0.0.1:3939/api/*` with CORS headers so the renderer can read Loam data.
- `/app/agents` fetches `GET http://localhost:8787/api/agents` (proxied to Loam companion list).
- `/app/computers` fetches `GET http://localhost:8787/api/companion-devices`.
- `/app/devices` fetches `POST http://localhost:8787/desktop.v1.DesktopService/GetDesktopDevices`.
- `/app/projects` fetches `GET http://localhost:8787/api/projects`.
- `/app/automations` fetches `GET http://localhost:8787/api/schedules`.
- `/app/plugins` fetches `GET http://localhost:8787/api/mcp/status` and `GET http://localhost:8787/api/tools`.
- `/app/library` fetches `GET http://localhost:8787/api/files`.
- `/app/creations` fetches `GET http://localhost:8787/api/creative` and `GET http://localhost:8787/api/media`.
