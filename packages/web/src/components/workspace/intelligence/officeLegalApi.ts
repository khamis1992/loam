import { getApiBase, getLoamAuthHeaders } from '@/services/rpc';
import { describeOfficeArtifact, type ArtifactRef, type SourceAnchor } from './officeIntelligenceApi';
import type { WorkspaceFile } from '../types';

export interface Matter {
  id: string;
  tenantId: string;
  projectId?: string;
  title: string;
  client: string;
  practiceArea: string;
  summary: string;
  status: 'active' | 'on-hold' | 'closed';
  parties: Array<{ name: string; role: string }>;
  revision: number;
}

export interface MatterDashboard {
  openTasks: number;
  overdueDeadlines: Array<{ id: string; title: string; dueAt: string }>;
  upcomingDeadlines: Array<{ id: string; title: string; dueAt: string }>;
  artifacts: number;
  events: number;
}

export interface LegalSource {
  id: string;
  title: string;
  citation: string;
  issuer: string;
  sourceUrl: string;
  effectiveFrom: string;
  effectiveTo?: string;
  text: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBase()}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...getLoamAuthHeaders(), ...(init?.headers ?? {}) },
  });
  const data = await response.json() as { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data as T;
}

export async function listMatters(): Promise<Matter[]> {
  return (await request<{ matters: Matter[] }>('/api/office/legal/matters?tenantId=local')).matters;
}

export async function createMatter(title: string, client: string): Promise<Matter> {
  return (await request<{ matter: Matter }>('/api/office/legal/matters', {
    method: 'POST', body: JSON.stringify({ tenantId: 'local', title, client, practiceArea: 'general', parties: [] }),
  })).matter;
}

export async function getMatterDashboard(id: string): Promise<MatterDashboard> {
  return (await request<{ dashboard: MatterDashboard }>(`/api/office/legal/matters/${encodeURIComponent(id)}/dashboard`)).dashboard;
}

export async function getMatterConflicts(id: string): Promise<Array<{ matterId: string; client: string; matchedParty: string }>> {
  return (await request<{ candidates: Array<{ matterId: string; client: string; matchedParty: string }> }>(`/api/office/legal/matters/${encodeURIComponent(id)}/conflicts`)).candidates;
}

export async function attachCurrentArtifact(matter: Matter, file: WorkspaceFile): Promise<Matter> {
  const artifact: ArtifactRef = await describeOfficeArtifact(file);
  return (await request<{ matter: Matter }>(`/api/office/legal/matters/${encodeURIComponent(matter.id)}/artifacts`, {
    method: 'POST', body: JSON.stringify({ artifact, expectedRevision: matter.revision }),
  })).matter;
}

export async function searchMatterArchive(query: string): Promise<Array<{ matterId: string; source: SourceAnchor; score: number }>> {
  return (await request<{ results: Array<{ matterId: string; source: SourceAnchor; score: number }> }>(`/api/office/legal/matters/search?tenantId=local&query=${encodeURIComponent(query)}`)).results;
}

export async function searchOfficialSources(query: string): Promise<LegalSource[]> {
  return (await request<{ sources: LegalSource[] }>(`/api/office/legal/sources/search?tenantId=local&query=${encodeURIComponent(query)}`)).sources;
}
