# Store builds for generated mobile apps (EAS, BYOK)

W4b. Generated mobile apps ship an Expo project layout in the export ZIP's
`expo/` folder (Expo SDK 53, React 19 / RN 0.79 — see `src/mobile/export.ts`).
Store builds (Google Play + iOS cloud) go through Expo Application Services
with **the user's own account and tooling**. Loam runs no build farm, holds no
Apple/Google/Expo credentials, and stores no keys — BYOK end to end.

## The wrapper

`scripts/eas-build.mjs` (npm run `eas:build`) wraps the `eas` CLI:

```
npm run eas:build -- --platform android
npm run eas:build -- --platform android --local      # local build, needs Android SDK
npm run eas:build -- --platform ios --profile production
npm run eas:build -- --platform android --submit     # build, then eas submit --latest
node scripts/eas-build.mjs --platform ios --projectDir path/to/expo
```

- `--platform android|ios` (required), `--profile`, `--projectDir`
  (default: `./expo` when it exists, else the current dir), `--submit`,
  `--local` (android only — EAS local iOS builds need macOS).
- Builds run as `eas build --non-interactive` (EAS cloud, or locally for
  android with `--local`); `--submit` follows with `eas submit --latest`.
- The user installs the CLI (`npm install -g eas-cli`) and logs in
  (`eas login`) themselves. The wrapper checks `eas --version` and
  `eas whoami` first and fails honestly, in Arabic, when the CLI, the login,
  or a valid Expo project dir is missing. It never reads, writes or forwards
  credentials.

## One-time setup (the user's machine, the user's accounts)

1. `npm install -g eas-cli`
2. `eas login` (the user's Expo account)
3. Export the app from Loam Mobile Studio, unzip, `cd expo`
4. `npm install` inside the expo folder (first time), then run the wrapper
   from the repo root with `--projectDir`, or from the unzipped folder.
5. Store submission additionally needs the user's own Apple App Store Connect
   / Google Play credentials configured in their EAS account. `eas submit`
   asks for them interactively in the user's terminal; Loam never sees them.

## Related BYOK surfaces

- Stripe keys for generated web apps (fullstack) ride the same spawn-env
  mechanism as AI provider keys: stored sealed in the Loam vault
  (`appbuilder-app` scope) or read from the user's own environment
  (`STRIPE_KEY`, `STRIPE_WEBHOOK_SECRET`), and injected only into the local
  app API server process. See `src/appbuilder/localCloud.ts`
  (`stripeEnvFor`) and `GET/PUT /api/app-projects/app-secrets`.
- SQLite pull/push sync for a generated app's local database rides the app's
  own API server: `GET /__loam/sync/pull`, `POST /__loam/sync/push`
  (25MB cap, atomic `.tmp`+rename), implemented in
  `src/appbuilder/appSync.ts` and shipped into the app as the Loam-owned
  `server/loam-sync.mjs` overlay.
