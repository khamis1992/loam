# Fix requests from `task` agent

## 1. Handoff from shell agent: dispatch `loadSessions()` after creating a task

**Owned by:** home agent (`packages/web/src/app/app/page.tsx`).

The shell agent requested that after `dispatch(addSession({ ... }))` in `HomePage.handleSend`, the home page also dispatch `loadSessions()` so the sidebar task list refreshes once the task is created. The `loadSessions` thunk is already exported from `sessionsSlice`.

```ts
import { addSession, loadSessions } from '@/store/sessionsSlice';

const handleSend = (text: string, mode: TaskMode, files: File[]) => {
  const uid = shortUid();
  dispatch(addSession({
    uid, title: text.slice(0, 60), status: 6, lastMessageTime: Date.now(), lastDisplayMessage: text, icon: '•',
  }));
  dispatch(loadSessions()); // <-- add this line
  navigateToTask(text, mode, files);
};
```

## 2. (Optional) Desktop environment values for branch / Downloads

The task page now reads `cwd` from the URL query and passes it into the first `user_message.extData.desktopBinding`. The home page is already sending `desktopSync.env.GIT_BRANCH` and calling `__apis.system.getDownloadsPath()` when available. If the Electron main/preload layer exposes these values, the branch chip and the `cwd=` query parameter will work automatically.

No action required from the web side; this is a heads-up for the desktop/auth agent if those values are not yet wired.
