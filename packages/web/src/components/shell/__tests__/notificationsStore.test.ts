import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getNotificationsServerSnapshot,
  getNotificationsSnapshot,
  markAllNotificationsRead,
  markNotificationRead,
  pushNotification,
  resetNotifications,
  subscribeNotifications,
  unreadCount,
} from '../notificationsStore';

const byId = (id: string) => getNotificationsSnapshot().find((n) => n.id === id);
const firstUnread = () => getNotificationsSnapshot().find((n) => !n.read_at)!;

describe('notificationsStore', () => {
  beforeEach(() => {
    resetNotifications();
  });

  it('seeds a stub feed with unread items', () => {
    const items = getNotificationsSnapshot();
    expect(items.length).toBeGreaterThan(0);
    expect(unreadCount(items)).toBeGreaterThan(0);
    expect(items.filter((n) => !n.read_at).length).toBe(unreadCount(items));
  });

  it('server snapshot is the initial seed (hydration-safe)', () => {
    expect(getNotificationsServerSnapshot()).toBe(getNotificationsSnapshot());
  });

  it('marks a single notification read', () => {
    const before = unreadCount(getNotificationsSnapshot());
    const target = firstUnread();
    markNotificationRead(target.id);
    expect(byId(target.id)!.read_at).toBeTypeOf('string');
    expect(unreadCount(getNotificationsSnapshot())).toBe(before - 1);
  });

  it('ignores unknown ids and already-read items', () => {
    const seed = getNotificationsSnapshot();
    markNotificationRead('does-not-exist');
    expect(getNotificationsSnapshot()).toBe(seed);
    const target = firstUnread();
    markNotificationRead(target.id);
    const after = getNotificationsSnapshot();
    markNotificationRead(target.id);
    markNotificationRead('still-unknown');
    expect(getNotificationsSnapshot()).toBe(after);
  });

  it('marks all read once and then no-ops', () => {
    markAllNotificationsRead();
    expect(unreadCount(getNotificationsSnapshot())).toBe(0);
    const after = getNotificationsSnapshot();
    markAllNotificationsRead();
    expect(getNotificationsSnapshot()).toBe(after);
  });

  it('pushes a new unread notification at the head', () => {
    pushNotification({ title: 'New task done', body: 'Finished.', kind: 'task-done' });
    const items = getNotificationsSnapshot();
    expect(items[0].title).toBe('New task done');
    expect(items[0].body).toBe('Finished.');
    expect(items[0].kind).toBe('task-done');
    expect(items[0].read_at).toBeNull();
    expect(items[0].task_id).toBeNull();
    expect(items[0].id).toBeTruthy();
  });

  it('push honors custom id and trims input', () => {
    const pushed = pushNotification({ id: 'x1', title: '  Spaced  ', body: ' b ', task_id: 'abc' });
    expect(pushed.id).toBe('x1');
    expect(pushed.title).toBe('Spaced');
    expect(pushed.body).toBe('b');
    expect(pushed.task_id).toBe('abc');
    expect(byId('x1')).toBe(pushed);
  });

  it('push falls back to a generic title when empty', () => {
    const pushed = pushNotification({ title: '   ' });
    expect(pushed.title).toBe('Notification');
    expect(pushed.kind).toBe('task-done');
  });

  it('notifies subscribers only on real changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNotifications(listener);
    markNotificationRead('nope');
    expect(listener).not.toHaveBeenCalled();
    markAllNotificationsRead();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    markAllNotificationsRead();
    pushNotification({ title: 'After unsubscribe' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reset restores the seed', () => {
    markAllNotificationsRead();
    pushNotification({ title: 'Extra' });
    resetNotifications();
    expect(getNotificationsSnapshot()).toBe(getNotificationsServerSnapshot());
    expect(unreadCount(getNotificationsSnapshot())).toBeGreaterThan(0);
  });
});
