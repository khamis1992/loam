# uo20 — Bell (notifications) and devices icon

## Problem (option #20)

The base already renders the sidebar-bottom bell and devices icon (opi merge,
`f362ab1`), but the bell polls `GET /api/notifications` — and those routes are
**not mounted** in `src/server/http.ts` (opi deliberately left the mounts to
the supervisor per the parallel-worktree rule). Every poll fails silently, so
the dropdown is always empty and the unread dot never appears. The bell also
routed every item click to `/app/computers`, and it used theme-undefined
classes (`text-icon-blue`, `text-function-error`, `text-function-warning`),
which produce no CSS under this Tailwind config.

## What was done

Per the task brief: a **client notifications store** with a **stub feed**, no
server dependency, edits isolated to the sidebar-bottom components.

- **New `packages/web/src/components/shell/notificationsStore.ts`** —
  framework-free module store: `NotificationItem` keeps the opi server API
  shape (`id, kind, title, body, task_id, read_at, created_at`; kinds
  `task-done | task-failed | approval-pending | schedule-failed`). Seeded with
  a 5-item stub feed (3 unread, 2 read). `subscribeNotifications` +
  `getNotificationsSnapshot` + `getNotificationsServerSnapshot` are
  `useSyncExternalStore`-ready and hydration-safe (the server snapshot is the
  immutable seed). Actions: `markNotificationRead` /
  `markAllNotificationsRead` (no-op on unknown/already-read, emit only on real
  change), `pushNotification` (head insert, generated id, trimmed input — the
  attach point for a real producer later), `resetNotifications` (tests).
  `unreadCount` pure helper.
- **`packages/web/src/components/shell/NotificationBell.tsx`** — rewritten to
  consume the client store via `useSyncExternalStore` (no polling, no fetch).
  Unread badge on the bell; dropdown with kind chips + per-item unread dot,
  per-item mark-read, "Mark all read", Escape and outside-click close,
  `aria-haspopup`/`aria-expanded`. Item click now marks read and deep-links
  `/app/<task_id>` when present (instead of everything → `/app/computers`).
  Colors fixed to classes that actually generate under this Tailwind config
  (probed with the project config): `text-[color:var(--icon-blue)]` for the
  action, standard-palette chips with dark variants. All i18n keys it uses
  already exist in both en and ar catalogs.
- **Devices icon**: already links to `/app/computers` in the base
  (`Sidebar.tsx` untouched in this pass).
- **New test `packages/web/src/components/shell/__tests__/notificationsStore.test.ts`**
  — 10 cases: stub seed has unread, server snapshot identity (hydration),
  mark-read, unknown/already-read no-ops (reference identity), mark-all +
  no-op, push (head, custom id, trimming, fallback title), subscriber emit
  semantics incl. unsubscribe, reset.

## Verification

- `npx tsc --noEmit -p packages/web/tsconfig.json` — 0 errors.
- `npx vitest run` (packages/web) — 20 files / 109 tests pass (incl. the new 10).
- `npx tsc --noEmit` (root) — exit 0.
- `npm run build:server` — exit 0 (`dist/server.cjs` + pdf worker copied).

## Files touched

- New: `packages/web/src/components/shell/notificationsStore.ts`,
  `packages/web/src/components/shell/__tests__/notificationsStore.test.ts`.
- Rewritten: `packages/web/src/components/shell/NotificationBell.tsx`.
- Docs: this report + `docs/handoff/UNIMPLEMENTED_OPTIONS.md` row #20.
- No protected files touched. `Sidebar.tsx` untouched (bell + devices icon
  were already mounted from the base).

## Left / limitations

- The stub feed is static and in-memory (read state resets on reload) — per
  the brief, "stub feed is fine". When the opi `handleNotificationsRoutes`
  mounts land in `src/server/http.ts`, a real producer can feed
  `pushNotification` (or hydrate the store once) without touching the bell UI.
- Notification titles/bodies in the stub are English strings (kind chips are
  localized); a real feed supplies content anyway.
