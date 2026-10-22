# A10 handoff requests

A10 owns `src/tools/mapReduce.ts`, `src/tools/registry.ts`, `src/tools/specAliases.ts`, `packages/web/e2e/**`, `docs/QA.md`.
This file lists changes needed in paths owned by other agents so that the A10 verification passes end-to-end.

## 1. Tool registration (`src/setup/runtime.ts`) — A1 / A7

Please wire the §8.5.1 spec alias tools into the runtime registry after the native tools are registered:

```ts
import { createSpecAliasTools } from "../tools/specAliases.js";
// ... after createSubagentTools and other registrations:
registry.registerAll(createSpecAliasTools({ ollama, registry, defaultSubagent: "coder" }));
```

This exposes `terminal`, `text_editor`, `search`, `webpage_extract`, `browser`, `plan`, `message`, `map_reduce`, `suggestion`, `idle` to the agent loop.

## 2. E2E selector hooks in the web app — A3 / A4

The Playwright specs rely on stable `data-testid` attributes. Please add these to the implemented components:

- Home screen container: `data-testid="home-screen"`
- Task screen container: `data-testid="task-screen"`
- Composer: `data-testid="composer"`
- Follow-up suggestion rows: `data-testid="suggestion-row"`
- Stop button: `aria-label="Stop"`
- Sidebar nav: `aria-label="Sidebar"`

## 3. TypeScript coverage for `packages/web/e2e` — A2 / A3

`packages/web/e2e/**/*.ts` is not included by the root `tsconfig.json`. Please either:

- Add `packages/web/e2e/**/*.ts` to the root `tsconfig.json` include, or
- Add a `tsconfig.json` under `packages/web/e2e` and run it in CI.

## 4. Dependencies added by A10

A10 added the following devDependencies to root `package.json` so that the verification commands compile and run:

- `@playwright/test` — required by `npx playwright test`.
- `@xmldom/xmldom` — required by `src/studio/ooxml.ts` (pre-existing missing dependency).

If A1 wants to relocate these to a sub-package `package.json`, coordinate with A10 so `npx playwright test` still works from the repo root.

## 5. Desktop package location for E2E — A1

The Playwright harness currently looks for the packaged app at:

```
packages/desktop/dist/{win-unpacked,mac-arm64,linux-unpacked}/...
```

with a fallback to `electron/main.cjs`. If A1 keeps the desktop build in the current `electron/` folder instead of `packages/desktop/`, please update the harness defaults in `packages/web/e2e/playwright.config.ts` and `packages/web/e2e/harness/electronApp.ts`.

## 6. Mock server startup for E2E — A5

The E2E suite assumes the mock server is running on `http://localhost:8787`. Please ensure `packages/mock-server` can be started with a one-liner (e.g. `pnpm -F mock-server dev`) and that the login redirect chain in §9.1 works before the E2E run.

## 7. IPC `__apis.system.openExternal` — A1

`login.spec.ts` calls `window.__apis.system.openExternal(url)`. Please ensure the preload exposes `__apis.system.openExternal` and that the main process can receive the resulting deep link via `second-instance` / `open-url`.
