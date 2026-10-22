# A9 Security + Backend Bug Fixes — Handoff Report

Agent: A9 (security + backend bug fixes)  
Worktree: `C:\Users\khamis\Desktop\manus-parity-wt\a09`  
Branch: `mp/a09-security-backend`

## What was done

### 1. Model-call "ByteString" bug (GAP_REVIEW P0 #5)
- `src/ollama.ts`: `cloudHeaders()` now strips non-printable-ASCII characters from
  `cloudModel.apiKey`, omits the `Authorization` header when the key is empty,
  and throws a clear "No cloud API key configured" error before any cloud call.
- `src/server/http.ts`: `/api/chat` now pre-flights cloud-model requests and
  emits an SSE error with the same clear message when no key is configured,
  instead of letting Node's ByteString conversion error bubble up.

### 2. `/api/models` graceful degradation + `/api/health`
- `/api/models` now catches provider failures and returns HTTP 200 with
  `{ models: [] }` plus a `providerError` field when Ollama/the cloud provider is
  unreachable.
- Added public `/api/health` returning `{ ok, provider, model, tools, sessions,
  version }`.

### 3. Honour `LOAM_ROOT`
- `src/config.ts`: when `LOAM_ROOT` (or legacy `MANUS_LOCAL_ROOT`) is set, the
  workspace and screenshot directory are forced under that root instead of
  trusting a `config.json` value that may point back into the source tree.
- `src/index.ts`: the `bootSettings.workspace` override is skipped when the
  env root is set.

### 4. Per-install local auth token (BUILD_SPEC §10.1)
- New `src/security/localAuth.ts` generates, reads, and validates a 256-bit
  install token stored in the user-data directory.
- `src/server/http.ts`: all API routes (except public `/api/health`,
  `/api/identity`, and static assets) require the `x-loam-local-token` header and
  return 401 when it is missing or wrong.
- `electron/main.cjs`: creates/persists the token in `%APPDATA%/manus-local`,
  passes it to the server child via `LOAM_LOCAL_TOKEN_DIR`, injects it into
  renderer requests via `webRequest.onBeforeSendHeaders`, and includes it in
  main-process internal fetch calls.

### 5. Electron IPC to spec channels (BUILD_SPEC §8.3 / §10.3)
- New `electron/ipc-constants.cjs` exports the `desktop-ipc-api`,
  `desktop-ipc-event`, `desktop-ipc-meta`, and `desktop-sync-info` channel
  names plus the MVP namespace list.
- `electron/preload.cjs` now exposes `desktopSync`, `__apis`, `__events`, and
  `desktopLocalStorage` as specified, while keeping a legacy `window.loam` /
  `window.manusLocal` shim for the existing vanilla UI during the transition.
- `electron/main.cjs` implements the spec dispatcher:
  - validates that the sender URL starts with the local loopback origin
    (`http://127.0.0.1:${PORT}/`), and rejects unknown namespaces/methods.
  - implements MVP handlers for `auth`, `window`, `system`, `updater`, `theme`,
    `appearance`, `desktopOperator`, `terminal`, `keepAwake`, `shortcut`,
    `env`, `diagnosticLogs`, `desktopActivityIndicator`, and `storage`
    (with stubs where the full behavior is out of MVP scope).

### 6. Electron hardening (BUILD_SPEC §10.4)
- `electron-builder.yml`: `asar: true` + `asarUnpack: ["**/*.node"]` +
  `afterPack: ./electron/afterPack.cjs`.
- New `electron/afterPack.cjs` flips the required fuses:
  - `RunAsNode` → disabled
  - `EnableNodeOptionsEnvironmentVariable` → disabled
  - `EnableNodeCliInspectArguments` → disabled
  - `EnableEmbeddedAsarIntegrityValidation` → enabled
  - `OnlyLoadAppFromAsar` → enabled
  - `EnableCookieEncryption` → enabled
  - `GrantFileProtocolExtraPrivileges` → disabled
- Added `@electron/fuses` as a dev dependency.

### 7. Verification script
- New `scripts/check-a9.ps1` builds the server, starts it on a fresh port/user
  root, and verifies:
  - `/api/health` returns 200 without auth.
  - API requests without the install token return 401.
  - `LOAM_ROOT` overrides `config.json` workspace.
  - `/api/models` returns 200 with an empty list when providers are down.
  - `/api/chat` returns a clear "No cloud API key configured" error.

## What is left / known limitations

- The fuses were configured but were **not** exercised by packaging and running
  `npx @electron/fuses read` in this run (packaging needs the native
  `node-pty` prebuild path to succeed). A10 integration can verify by running
  `npm run dist` and then `npx @electron/fuses read --app release/win-unpacked/Loam.exe`.
- `electron` is still at `^44.7.2`; BUILD_SPEC pins `43.6.0`. The downgrade was
  left for A10 integration because it triggers a full native-dependency rebuild.
- The new IPC handlers are stubs for out-of-MVP namespaces (terminal,
  desktopActivityIndicator, etc.); the channel surface and sender validation
  are present and will accept the real implementations later.
- The renderer is still served over `http://127.0.0.1` rather than the spec's
  `app://agent/` custom protocol; moving to `app://agent/` is A1/A10 work and
  was out of A9 scope. Sender validation uses the local loopback origin.

## Verification commands (all passing)

```powershell
npm run typecheck          # 0 errors
npm run build:server       # dist/server.cjs produced
powershell -ExecutionPolicy Bypass -File scripts\check-a9.ps1
```

## Cross-path edits

See `docs/handoff/a09-requests.md` for the few files outside A9's owned paths
that had to be touched (`src/config.ts`, `src/index.ts`, `package.json`).
