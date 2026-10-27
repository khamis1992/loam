/** Track-changes sidecar API: GET/PUT /api/workspace/doc/track (Loam-side JSON
 *  persistence; see src/server/workspace/docTrackIO.ts). */
import { getApiBase, getApiHeaders } from '@/services/rpc';
import type { WorkspaceFile } from '../types';
import type { TrackedDocument } from '@shared/trackChanges';

function base(file: WorkspaceFile): string {
  return `${getApiBase()}/api/workspace/doc/track?taskId=${encodeURIComponent(file.taskId)}&path=${encodeURIComponent(file.path)}`;
}

export async function loadDocTrack(file: WorkspaceFile): Promise<TrackedDocument | null> {
  const response = await fetch(base(file), { headers: await getApiHeaders() });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `HTTP ${response.status}`);
  }
  const body = (await response.json()) as { track?: TrackedDocument | null };
  return body.track ?? null;
}

export async function saveDocTrack(file: WorkspaceFile, track: TrackedDocument): Promise<void> {
  const response = await fetch(base(file), {
    method: 'PUT',
    headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
    body: JSON.stringify({ track }),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `HTTP ${response.status}`);
  }
}
