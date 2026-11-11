import { getApiBase, getApiHeaders } from './rpc';

export type CompanionEnvironment = 'linux' | 'windows' | string;
export type CompanionProvider = 'wsl' | 'hyperv' | 'fake' | string;
export type DeviceAction = 'start' | 'stop' | 'suspend' | 'resume';

export interface CompanionDevice {
  id: string;
  agentId: string;
  name: string;
  environment: CompanionEnvironment;
  provider: CompanionProvider;
  template: string;
  state: string;
  lastError?: string;
}

export interface DeviceTemplate {
  id: string;
  labelAr?: string;
  description?: string;
  environment: CompanionEnvironment;
}

export interface CompanionOption {
  id: string;
  name: string;
}

export interface CompanionProviders {
  wsl: boolean;
  hyperv: boolean;
  fake: boolean;
  wslDistros?: string[];
}

export interface CompanionDevicesResponse {
  devices: CompanionDevice[];
  templates: DeviceTemplate[];
  goldenReady: boolean;
  providers: CompanionProviders;
}

interface RawCompanionDevicesResponse {
  devices?: CompanionDevice[];
  templates?: DeviceTemplate[];
  goldenReady?: boolean;
  wsl?: boolean;
  hyperv?: boolean;
  fake?: boolean;
  wslDistros?: string[];
}

export interface CompanionDraft {
  name: string;
  emoji?: string;
  description?: string;
  instructions?: string;
  mode?: string;
  effort?: string;
  workMode?: string;
  model?: string;
}

interface ErrorBody {
  error?: string;
}

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as ErrorBody;
  return body.error ?? `${res.status}`;
}

async function request<T>(path: string, init: RequestInit = {}, withJson = true): Promise<T> {
  const headers = withJson
    ? { 'Content-Type': 'application/json', ...(await getApiHeaders()) }
    : await getApiHeaders();
  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json().catch(() => ({}))) as T;
}

export function listCompanionDevices(): Promise<CompanionDevicesResponse> {
  return request<RawCompanionDevicesResponse>('/api/companion-devices', {}, false).then((data) => ({
    devices: data.devices ?? [],
    templates: data.templates ?? [],
    goldenReady: Boolean(data.goldenReady),
    providers: {
      wsl: Boolean(data.wsl),
      hyperv: Boolean(data.hyperv),
      fake: Boolean(data.fake),
      wslDistros: data.wslDistros,
    },
  }));
}

export function createCompanionDevice(input: {
  agentId: string;
  template: string;
  name?: string;
}): Promise<{ device: CompanionDevice }> {
  return request('/api/companion-devices', { method: 'POST', body: JSON.stringify(input) });
}

export function prepareGoldenImage(fromDistro?: string): Promise<{ ok: boolean }> {
  return request('/api/companion-devices/golden', {
    method: 'POST',
    body: JSON.stringify({ fromDistro: fromDistro ?? '' }),
  });
}

export function actOnCompanionDevice(id: string, action: DeviceAction): Promise<unknown> {
  return request(`/api/companion-devices/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
}

export function deleteCompanionDevice(id: string): Promise<unknown> {
  return request(`/api/companion-devices/${encodeURIComponent(id)}?confirm=true`, { method: 'DELETE' });
}

export function listCompanions(): Promise<CompanionOption[]> {
  return request<{ agents?: Array<{ id: string; name?: string }> }>('/api/agents', {}, false).then(
    (data) => (data.agents ?? []).map((a) => ({ id: a.id, name: a.name || a.id })),
  );
}

export function createCompanion(draft: CompanionDraft): Promise<{ agent: { id: string; name: string } }> {
  return request('/api/agents', { method: 'POST', body: JSON.stringify(draft) });
}

export interface CompanionJournalEntry {
  at: string;
  kind: 'agent' | 'user' | 'system';
  event: string;
  ok: boolean;
  detail?: string;
}

export interface CompanionDeviceDetails {
  device: CompanionDevice;
  journal: CompanionJournalEntry[];
  readiness: { ready: boolean; detail: string };
}

export interface CompanionDeviceStats {
  memoryTotalMB?: number;
  memoryFreeMB?: number;
  cpuUtilization?: number;
  disk?: string;
  diskUsedGB?: number;
  diskTotalGB?: number;
  diskUsedPercent?: number;
  raw: string;
}

export interface CompanionTask {
  id: string;
  title: string;
  status: string;
  updatedAt?: string;
  createdAt?: string;
}

export function getCompanionDevice(id: string): Promise<CompanionDeviceDetails> {
  return request(`/api/companion-devices/${encodeURIComponent(id)}`, {}, false);
}

export function getCompanionDeviceStats(id: string): Promise<{ stats: CompanionDeviceStats; costNote: string }> {
  return request(`/api/companion-devices/${encodeURIComponent(id)}/stats`, {}, false);
}

export function ensureCompanionGui(id: string): Promise<{ ok: boolean; started: boolean; detail: string }> {
  return request(`/api/companion-devices/${encodeURIComponent(id)}/gui-ensure`, { method: 'POST' });
}

export async function captureCompanionScreen(id: string): Promise<Blob> {
  return fetch(`${getApiBase()}/api/companion-devices/${encodeURIComponent(id)}/screen`, {
    headers: await getApiHeaders(),
  }).then(async (res) => {
    if (!res.ok) throw new Error(await errorMessage(res));
    return res.blob();
  });
}

export function sendCompanionInput(id: string, input: { type: string; x?: number; y?: number; text?: string; key?: string }): Promise<{ ok: boolean }> {
  return request(`/api/companion-devices/${encodeURIComponent(id)}/input`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function snapshotCompanionDevice(id: string, label = ''): Promise<unknown> {
  return request(`/api/companion-devices/${encodeURIComponent(id)}/snapshot`, {
    method: 'POST',
    body: JSON.stringify({ label }),
  });
}

export function setCompanionControl(id: string, take: boolean): Promise<unknown> {
  return request(`/api/companion-devices/${encodeURIComponent(id)}/control`, {
    method: 'POST',
    body: JSON.stringify({ take }),
  });
}

export function listCompanionTasks(agentId: string): Promise<CompanionTask[]> {
  return request<{ tasks?: CompanionTask[] }>(`/api/tasks?agentId=${encodeURIComponent(agentId)}`, {}, false)
    .then((data) => data.tasks ?? []);
}

export async function startCompanionTask(agentId: string, prompt: string): Promise<CompanionTask> {
  const title = prompt.trim().slice(0, 80) || 'New task';
  const draft = await request<{ task: CompanionTask }>('/api/tasks/draft', {
    method: 'POST',
    body: JSON.stringify({ title, mode: 'code', agentId }),
  });
  void request<unknown>('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ taskId: draft.task.id, prompt, agentId, workMode: 'own_device', mode: 'code' }),
  }).catch(() => undefined);
  return draft.task;
}
