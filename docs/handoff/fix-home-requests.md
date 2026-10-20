# Fix requests from `home` agent

Owned files: `packages/web/src/app/app/page.tsx`, `packages/web/src/components/chat/Composer.tsx`, `packages/web/src/components/home/**`.

## 1. Task page should consume `attachments=` URL parameter

`packages/web/src/app/app/[sessionUid]/TaskPageClient.tsx`

The home page now uploads files via `services/upload.ts` and appends them as a JSON-encoded `attachments` query parameter when navigating to `/app/<uid>?draft=...&mode=...&cwd=...&attachments=<json>`.

Please read `attachments` from `useSearchParams()` in the task page and pass the resulting `Attachment[]` array into the user message event and any follow-up `handleSend` calls so that attached files appear in the chat.

## 2. Module alias mismatch breaks `npm run build` in `packages/web`

`packages/web/src/app/app/[sessionUid]/TaskPageClient.tsx`, `packages/web/src/services/chatSocket.ts`, `packages/web/src/services/rpc.ts`

These files import from `@agent-studio/shared`, but the package in `packages/shared/package.json` is named `@shared` and `packages/web/tsconfig.json` maps `@shared/*` to `../shared/src/*`. `npx tsc -p packages/web --noEmit` passes, but `npm run build` in `packages/web` fails with:

```
Error: Module not found: Can't resolve '@agent-studio/shared'
```

Please either rename the shared package to `@agent-studio/shared` (and update the tsconfig path mapping) or revert the imports to `@shared/*` so the web build can resolve the workspace package.

## 3. Optional: expose branch / Downloads path via desktop APIs if available

The home page already reads `desktopSync.env.GIT_BRANCH` / `__AGENT_STUDIO_ENV__.gitBranch` and calls `__apis.system.getDownloadsPath()` if present. If the desktop layer can provide these values, the branch chip and Downloads `cwd=` query parameter will work automatically.
