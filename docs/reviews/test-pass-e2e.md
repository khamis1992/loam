# Web e2e test pass — agents page

Branch: `mf/teste2e`
Scope: `packages/web` Playwright suite + a new agents-page spec.

## What the config does

`packages/web/playwright.config.ts`

- `testDir: './e2e'`, `baseURL: 'http://localhost:3000'`, single `chromium` project.
- `webServer.command: 'npm run build && npx serve out -p 3000'` (i.e. a full
  static export into `out/`, then `serve`), `reuseExistingServer: !CI`.

`testDir: './e2e'` collects three groups:

- `e2e/screens-home-task.spec.ts`, `e2e/screens-settings.spec.ts` — plain
  browser specs against `baseURL`.
- `e2e/specs/*.spec.ts` — Electron specs driven by `e2e/harness/fixtures.ts`
  (`_electron.launch` against `packages/desktop/dist/.../AgentStudio.exe`, with a
  fallback to `electron/main.cjs`). They use the `app://agent/...` scheme.
- `e2e/specs/agents-page.spec.ts` — new, plain browser spec (see below).

## Command run

```
cd packages/web && npx playwright test --reporter=line
```

### Result: blocked before any test executed (environment)

The configured `webServer` failed at its `npm run build` step:

```
[WebServer] ⚠ turbopack.root should be absolute, using: ...\packages\web
[WebServer] > Build error occurred
[WebServer] Error: Turbopack build failed with 1 error:
[WebServer] ./src/app
[WebServer] Error: Could not find the Next.js package (next/package.json)
[WebServer] Resolved from: ...\packages\web\src\app
[WebServer] Filesystem root used for resolution: ...\packages\web
Error: Process from config.webServer was not able to start. Exit code: 1
```

Cause: in this worktree `packages/web/node_modules` is a **junction** to
`C:\Users\khamis\Desktop\manus-local\packages\web\node_modules`. Next 16's
Turbopack resolves the workspace root to `packages/web` and refuses to read
packages outside it, so it cannot see the junctioned `next` package. This is a
worktree/packaging artifact, not an application defect — the merge/supervisor
environment installs real `node_modules` and runs `next build` there.

`serve` itself is available (`npx --no-install serve --version` → `14.2.6`), so
the only blocker is the build step. No server was started by hand.

Collection still validates the specs load and compile:

```
npx playwright test --list --reporter=line
Total: 18 tests in 6 files
```

…including the 5 new agents-page tests.

The Electron specs additionally require a built desktop app
(`packages/desktop/dist/.../AgentStudio.exe`), which is not present, so they
cannot run under this config in this worktree either.

## New spec — `packages/web/e2e/specs/agents-page.spec.ts`

Plain browser test. It reproduces the Electron bridge in-page and mocks every
backend call with `page.route`, so no server, database or API key is needed:

- injects `window.__apis` (auth token + no-op system/theme) and
  `window.__AGENT_STUDIO_ENV__` (`apiBase`/`socketBase` = `http://localhost:8787`);
- routes `**/user.v1.UserService/UserInfo` (session validation);
- routes `**/api/**` with a stateful handler so `pin`/`unpin` mutate the list
  returned by the next `GET /api/agents`.

Coverage (5 tests):

1. **agents list renders** — both mocked agents and the "My agents" section.
2. **search filters by Arabic and English names** — typing `مساعد` keeps the
   Arabic agent and drops `Researcher`; typing `research` does the reverse.
3. **pin/unpin moves an agent to the pinned grid** — right-click → Pin moves the
   row into `[data-agents-section="pinned"]`; right-click → Unpin moves it back
   to My agents and removes the Pinned section.
4. **opening an agent shows the thread, Ctrl+Shift+I toggles the info pane** —
   click the row, assert the thread header/info toggle and a mocked thread
   message, assert the pane tab strip appears/disappears with the shortcut.
5. **Arabic locale renders real Arabic, no mojibake** — `html[lang=ar][dir=rtl]`,
   sidebar header `t('Agents')` → `الوكلاء`, and `body.innerText` contains
   Arabic script and no Latin-1 mojibake characters (`\u00C0–\u00FF`).

## Genuine app bug found and fixed

`packages/web/src/i18n/en.json` and `ar.json` had been round-tripped through
Windows-1252 several times, so both **keys and values** were mojibake (e.g. the
Arabic `Agents` entry was `ÃƒÆ’Ã‹Å“...` instead of `الوكلاء`), the two key sets
differed (796 vs 802), and the Arabic UI rendered garbage. Reversed the
`cp1252 ↔ utf8` layers per entry; both catalogs now hold **795 identical keys**
with real Arabic text. This is what the new Arabic assertion guards against.

Also fixed the mojibake emoji fallbacks in
`packages/web/src/components/settings/SettingsDialog.tsx` (`âš™` → `⚙`, etc.),
the same encoding-corruption class.

## Gates

| Gate | Result |
| --- | --- |
| root `npx tsc --noEmit` | 0 errors |
| root `npm run build:server` | exit 0 |
| `packages/web` `npx tsc --noEmit` | 0 errors |
| `packages/web` `npx vitest run` (i18n + settings specs touched) | 25 passed |

The full Next.js web build was not run locally (supervisor runs it at merge).
