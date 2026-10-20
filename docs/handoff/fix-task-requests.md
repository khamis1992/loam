# Fix requests from `task` agent

## 1. `packages/web/src/components/chat/Composer.tsx` fails TypeScript build

**Owned by:** home agent (`packages/web/src/components/chat/Composer.tsx`, `packages/web/src/app/app/page.tsx`, `packages/web/src/components/home/**`).

`npx tsc -p packages/web --noEmit` currently reports:

```
packages/web/src/components/chat/Composer.tsx(290,12): error TS2552: Cannot find name 'GitBranch'. Did you mean 'branch'?
```

The `GitBranch` identifier is referenced on line 290 but is not imported (or the import is missing/renamed). This blocks a clean web build for any consumer of `Composer.tsx`.

**Request:** add the missing `GitBranch` import from `lucide-react` (or replace the icon with one that is imported).

---

## 2. (Optional) Desktop environment values for branch / Downloads

The task page now reads `cwd` from the URL query and passes it into the first `user_message.extData.desktopBinding`. The home page is already sending `desktopSync.env.GIT_BRANCH` and calling `__apis.system.getDownloadsPath()` when available. If the Electron main/preload layer exposes these values, the branch chip and the `cwd=` query parameter will work automatically.

No action required from the web side; this is a heads-up for the desktop/auth agent if those values are not yet wired.
