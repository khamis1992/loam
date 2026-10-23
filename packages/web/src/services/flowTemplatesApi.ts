import { getApiBase, getApiHeaders } from './rpc';

/**
 * Client for the N15 Case Playbook surface (the flow-template gallery).
 *
 * Talks to the `/api/flow-templates` route in the Loam server. The 12 flows
 * are seeded JSON files; selecting one deep-links into the task page with the
 * composer pre-filled (prompt + mode + effort), so the client only reads.
 */

export interface FlowTemplate {
  id: string;
  title: string;
  description: string;
  prompt: string;
  mode: string;
  effort: 'fast' | 'max';
  outputType?: 'auto' | 'text' | 'image' | 'video' | 'slides' | 'website';
  icon?: string;
  category?: string;
}

async function request<T>(path: string): Promise<T> {
  const headers = await getApiHeaders();
  const res = await fetch(`${getApiBase()}${path}`, { headers });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `status ${res.status}`);
  return data;
}

export function listFlowTemplates(): Promise<{ flows: FlowTemplate[] }> {
  return request<{ flows: FlowTemplate[] }>('/api/flow-templates');
}

export function getFlowTemplate(id: string): Promise<{ flow: FlowTemplate }> {
  return request<{ flow: FlowTemplate }>(`/api/flow-templates/${encodeURIComponent(id)}`);
}

/**
 * The deep link that "Try this flow" opens. The task page already reads
 * `draft` / `extData` search params and pre-fills the composer from them
 * (prompt + loam mode + output type + effort), so the gallery only has to
 * build the URL.
 */
export function flowTemplateHref(flow: FlowTemplate): string {
  const extData: Record<string, string> = { loamMode: flow.mode, effort: flow.effort };
  if (flow.outputType && flow.outputType !== 'auto') extData.outputType = flow.outputType;
  const params = new URLSearchParams({ draft: flow.prompt, extData: JSON.stringify(extData) });
  return `/app/demo-running?${params.toString()}`;
}
