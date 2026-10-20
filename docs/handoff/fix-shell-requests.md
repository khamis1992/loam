# Shell agent handoff requests

## Home / composer agent: dispatch loadSessions after creating a task

**File:** `packages/web/src/app/app/page.tsx` (not owned by shell)
**What:** After `dispatch(addSession({ uid, title: ..., status: 6, ... }))` in `HomePage.handleSend`, please also dispatch `loadSessions()` from `@/store/sessionsSlice` so the sidebar task list refreshes once the task agent fixes the CORS/backend issue.

```ts
import { addSession, loadSessions } from '@/store/sessionsSlice';

const handleSend = (text: string, mode: TaskMode, _files: File[]) => {
  const uid = shortUid();
  dispatch(addSession({
    uid, title: text.slice(0, 60), status: 6, lastMessageTime: Date.now(), lastDisplayMessage: text, icon: '•',
  }));
  dispatch(loadSessions()); // <-- add this line
  router.push(`/app/${uid}/?draft=${encodeURIComponent(text)}&mode=${mode}`);
};
```

The shell layer already calls `loadSessions()` in `Sidebar` on mount and exposes the thunk, so the only missing piece is the post-create refresh.

## Task-stream agent: fix TS error blocking `npm run build`

**File:** `packages/web/src/app/app/[sessionUid]/TaskPageClient.tsx` (not owned by shell)
**Error:** `src/app/app/[sessionUid]/TaskPageClient.tsx(265,7): error TS2367: This comparison appears to be unintentional because the types ... and '"error"' have no overlap.`
**Impact:** `npx tsc -p packages/web --noEmit` and `npm run build` inside `packages/web` both fail because of this single type error.
**What:** Adjust the event-type handling so the `"error"` branch compiles against the current event union.
