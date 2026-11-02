'use client';

import { useEffect, useRef } from 'react';
import { CraftRelayClient } from '@/lib/craftRelayClient';
import { VideoStudioClient } from '@/lib/videoStudioClient';
import type { WorkspaceOpenTarget } from './autoOpen';

const CRAFT_TARGETS = new Set(['docs', 'sheets', 'slides', 'photo', 'design']);

/** Maps a relay open request onto the workspace panel the shell should mount. */
export function workspaceTargetForRelay(target: string, path: string | null): WorkspaceOpenTarget | null {
  if (CRAFT_TARGETS.has(target)) return { path, kind: 'craft', craftApp: target };
  if (target === 'film' || target === 'effects') return { path, kind: 'loam-video' };
  return null;
}

type RelayOpen = (target: WorkspaceOpenTarget) => void;

let relayOpen: RelayOpen | null = null;
const pendingOpens: WorkspaceOpenTarget[] = [];
const startedRelays = new Set<string>();

/** The task page registers the panel opener. Late requests flush immediately. */
export function bindTaskRelayOpen(handler: RelayOpen): () => void {
  relayOpen = handler;
  const queued = pendingOpens.splice(0);
  for (const target of queued) handler(target);
  return () => {
    if (relayOpen === handler) relayOpen = null;
  };
}

function emitRelayOpen(target: WorkspaceOpenTarget): void {
  if (relayOpen) relayOpen(target);
  else pendingOpens.push(target);
}

/**
 * Opens the observe-only streams for a task. Safe to call more than once.
 * The socket handler calls this as soon as the task clock arrives, so the
 * slides panel can attach before the editor component's effect runs.
 */
export function ensureTaskRelay(taskId: string): void {
  if (!taskId || startedRelays.has(taskId)) return;
  startedRelays.add(taskId);
  const open = (request: { target: string; path?: string | null }) => {
    const next = workspaceTargetForRelay(request.target, request.path ?? null);
    if (next) emitRelayOpen(next);
  };
  const craft = new CraftRelayClient({
    taskId,
    observeOnly: true,
    autoReconnect: true,
    onOpenRequest: open,
  });
  const video = new VideoStudioClient({
    taskId,
    executor: async () => ({ ok: true }),
    observeOnly: true,
    autoReconnect: true,
    onOpenRequest: open,
  });
  void craft.start();
  void video.start();
}

/**
 * One observe-only Craft client and one observe-only Video client per task.
 * They listen for workspace_open_request before any editor panel is open.
 * The panel that then mounts owns the executing client for that target.
 */
export function TaskRelayHost({ taskId, onOpen }: { taskId: string; onOpen: (target: WorkspaceOpenTarget) => void }) {
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => bindTaskRelayOpen((target) => onOpenRef.current(target)), []);
  useEffect(() => {
    ensureTaskRelay(taskId);
  }, [taskId]);
  return null;
}
