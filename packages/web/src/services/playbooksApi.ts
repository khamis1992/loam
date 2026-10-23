import { getApiBase, getApiHeaders } from './rpc';

/**
 * Client for the D9 Playbooks surface (Settings › Playbooks).
 *
 * Talks to the `/api/playbooks` route in the Loam server. A playbook is a named
 * macro (`!name`) plus six authored sections; every content edit appends an
 * immutable version row, which the history view lists and can restore.
 */

export const PLAYBOOK_SECTION_KEYS = [
  'overview',
  'procedure',
  'specifications',
  'advice',
  'forbiddenActions',
  'neededFromUser',
] as const;

export type PlaybookSectionKey = (typeof PLAYBOOK_SECTION_KEYS)[number];

export interface PlaybookSections {
  overview: string;
  procedure: string;
  specifications: string;
  advice: string;
  forbiddenActions: string;
  neededFromUser: string;
}

export interface Playbook extends PlaybookSections {
  id: string;
  name: string;
  /** Stored without the leading `!`; the composer writes `!macro`. */
  macro: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlaybookVersion extends PlaybookSections {
  id: string;
  playbookId: string;
  version: number;
  createdAt: string;
  createdBy?: string;
}

export interface PlaybookInput extends Partial<PlaybookSections> {
  name: string;
  macro: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = { ...(await getApiHeaders()), ...(init?.headers as Record<string, string> | undefined) };
  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `status ${res.status}`);
  return data;
}

function ref(playbook: Playbook): string {
  return encodeURIComponent(playbook.id);
}

export function listPlaybooks(): Promise<{ playbooks: Playbook[] }> {
  return request<{ playbooks: Playbook[] }>('/api/playbooks');
}

export function getPlaybook(idOrMacro: string): Promise<{ playbook: Playbook }> {
  return request<{ playbook: Playbook }>(`/api/playbooks/${encodeURIComponent(idOrMacro)}`);
}

export function createPlaybook(input: PlaybookInput): Promise<{ playbook: Playbook }> {
  return request<{ playbook: Playbook }>('/api/playbooks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function updatePlaybook(idOrMacro: string, input: Partial<PlaybookInput> & Partial<PlaybookSections>): Promise<{ playbook: Playbook }> {
  return request<{ playbook: Playbook }>(`/api/playbooks/${encodeURIComponent(idOrMacro)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function deletePlaybook(idOrMacro: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/playbooks/${encodeURIComponent(idOrMacro)}`, {
    method: 'DELETE',
  });
}

export function listPlaybookVersions(playbook: Playbook): Promise<{ versions: PlaybookVersion[] }> {
  return request<{ versions: PlaybookVersion[] }>(`/api/playbooks/${ref(playbook)}/versions`);
}

export function restorePlaybookVersion(playbook: Playbook, version: number): Promise<{ playbook: Playbook }> {
  return request<{ playbook: Playbook }>(`/api/playbooks/${ref(playbook)}/versions/${version}/restore`, {
    method: 'POST',
  });
}
