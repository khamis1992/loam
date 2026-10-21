export type NotificationKind = 'task-done' | 'task-failed' | 'approval-pending' | 'schedule-failed';

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  task_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface NotificationInput {
  id?: string;
  kind?: NotificationKind;
  title: string;
  body?: string;
  task_id?: string | null;
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const nowIso = () => new Date().toISOString();

const SEED: NotificationItem[] = [
  { id: 'n-stub-1', kind: 'task-done', title: 'Competitor pricing report', body: 'Task finished — 14-page PDF saved to the task folder.', task_id: null, read_at: null, created_at: minutesAgo(18) },
  { id: 'n-stub-2', kind: 'approval-pending', title: 'Approval needed: install dependencies', body: 'Agent Loam wants to run npm install in your project.', task_id: null, read_at: null, created_at: minutesAgo(47) },
  { id: 'n-stub-3', kind: 'task-failed', title: 'Website deploy failed', body: 'The build step exited with an error — see the task log for details.', task_id: null, read_at: null, created_at: minutesAgo(125) },
  { id: 'n-stub-4', kind: 'schedule-failed', title: 'Weekly digest failed', body: 'The scheduled routine could not run — check its configuration.', task_id: null, read_at: minutesAgo(430), created_at: minutesAgo(430) },
  { id: 'n-stub-5', kind: 'task-done', title: 'Onboarding tour completed', body: 'You finished the intro tour — enjoy Loam!', task_id: null, read_at: minutesAgo(1500), created_at: minutesAgo(1500) },
];

let items: NotificationItem[] = SEED;
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getNotificationsSnapshot(): NotificationItem[] {
  return items;
}

export function getNotificationsServerSnapshot(): NotificationItem[] {
  return SEED;
}

export function unreadCount(list: NotificationItem[]): number {
  return list.reduce((n, item) => n + (item.read_at ? 0 : 1), 0);
}

export function markNotificationRead(id: string): void {
  let changed = false;
  const next = items.map((n) => {
    if (n.id === id && !n.read_at) {
      changed = true;
      return { ...n, read_at: nowIso() };
    }
    return n;
  });
  if (!changed) return;
  items = next;
  emit();
}

export function markAllNotificationsRead(): void {
  if (unreadCount(items) === 0) return;
  const at = nowIso();
  items = items.map((n) => (n.read_at ? n : { ...n, read_at: at }));
  emit();
}

export function pushNotification(input: NotificationInput): NotificationItem {
  seq += 1;
  const item: NotificationItem = {
    id: input.id ?? `n-${Date.now().toString(36)}-${seq}`,
    kind: input.kind ?? 'task-done',
    title: input.title.trim() || 'Notification',
    body: (input.body ?? '').trim(),
    task_id: input.task_id ?? null,
    read_at: null,
    created_at: nowIso(),
  };
  items = [item, ...items];
  emit();
  return item;
}

export function resetNotifications(): void {
  items = SEED;
  emit();
}
