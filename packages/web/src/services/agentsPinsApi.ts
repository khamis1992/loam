import { getApiBase, getApiHeaders } from './rpc';

export interface PinnedAgent {
  id: string;
  name: string;
  emoji?: string;
  description?: string;
  mode?: string;
  source?: string;
  pinnedAt?: number;
  sortOrder?: number;
  archivedAt?: string;
}

interface ErrorBody {
  error?: string;
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
    headers: { ...(await getApiHeaders()), 'Content-Type': 'application/json' },
    ...init,
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body as ErrorBody).error || `${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export function setAgentPinned(id: string, pinned: boolean): Promise<{ agent: PinnedAgent }> {
  return jsonFetch(`/api/agents/${encodeURIComponent(id)}/pin`, {
    method: 'POST',
    body: JSON.stringify({ pinned }),
  });
}

export function reorderPinnedAgents(ids: string[]): Promise<{ pinned: PinnedAgent[]; agents: PinnedAgent[] }> {
  return jsonFetch('/api/agents/reorder', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}
