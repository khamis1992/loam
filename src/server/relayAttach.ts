/**
 * Per-target attach registry for the workspace relay.
 *
 * A panel client announces the editor targets it can drive when it opens the
 * task stream. An unannounced subscriber (the existing tests and older
 * clients) is still treated as attached by the relay via subscriberCount.
 */
const announced = new Map<string, Map<string, number>>();

/** Record that this connection drives `targets`. Call the returned function on close. */
export function announceRelayTargets(taskId: string, targets: readonly string[]): () => void {
  const names = targets.map((target) => target.trim()).filter(Boolean);
  if (!taskId) return () => {};
  let counts = announced.get(taskId);
  if (!counts) {
    counts = new Map();
    announced.set(taskId, counts);
  }
  for (const target of names) counts.set(target, (counts.get(target) ?? 0) + 1);
  return () => {
    const current = announced.get(taskId);
    if (!current) return;
    for (const target of names) {
      const next = (current.get(target) ?? 1) - 1;
      if (next <= 0) current.delete(target);
      else current.set(target, next);
    }
    if (current.size === 0) announced.delete(taskId);
  };
}

/** The targets a panel has announced, or null when nobody announced any. */
export function announcedTargets(taskId: string): ReadonlySet<string> | null {
  const counts = announced.get(taskId);
  if (!counts) return null;
  return new Set(counts.keys());
}
