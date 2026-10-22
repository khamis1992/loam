/**
 * Client service for the per-agent info panel (Grok Bot parity).
 *
 * Centralises every request the AgentInfoPane makes: the agent's memory,
 * approval rules, scratchpad, routines (schedules + URL watches), messaging
 * channels, child agents (Members) and the live computer preview stream. The
 * component only renders; this module owns transport, auth headers and the
 * typed response shapes.
 */
import { getApiBase, getApiHeaders } from './rpc';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  id: string;
  text: string;
  kind?: string;
  source?: string;
  at?: string;
}

export interface ApprovalRuleRow {
  id: string;
  agentId?: string | null;
  tool: string;
  pattern?: string | null;
  decision: 'allow' | 'deny';
  createdAt: string;
}

export interface ScratchpadItem {
  id: string;
  text: string;
  status: 'open' | 'done';
  createdAt: string;
  doneAt?: string;
}

export interface UrlWatch {
  id: string;
  url: string;
  intervalMinutes: number;
  selector?: string | null;
  prompt: string;
  enabled: boolean;
  agentId?: string | null;
  lastCheckedAt?: string | null;
  lastChangedAt?: string | null;
  lastHash?: string | null;
}

export interface Schedule {
  id: string;
  prompt: string;
  intervalSeconds: number;
  kind?: string | null;
  enabled: boolean;
  cron?: string | null;
  runAt?: string | null;
  timezone?: string | null;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastTaskId?: string | null;
  lastStatus?: 'ok' | 'retrying' | 'failed' | null;
  attempts?: number | null;
  lastError?: string | null;
  agentId?: string | null;
}

export interface ChannelStatus {
  name: 'telegram' | 'email';
  configured: boolean;
  envVarNames: string[];
  hint?: string;
}

export interface ChannelBinding {
  id: string;
  channel: 'telegram' | 'email';
  chatId: string;
  agentId: string;
  createdAt: string;
}

export interface ChildAgent {
  childId: string;
  spawnKey: string;
  name: string;
  emoji: string;
  description: string;
  mode?: string;
  archived: boolean;
  createdAt: string;
}

export type LiveSource = 'screen' | 'browser';

export interface LiveFrame {
  source: LiveSource;
  data: string | null;
  mediaType: string;
  at: number;
  width: number | null;
  height: number | null;
  url: string | null;
  title: string | null;
}

export interface LiveStatus {
  screen?: { available: boolean; running: boolean };
  browser?: { available: boolean; url: string | null };
  available?: boolean;
}

export interface WatchDraft {
  url: string;
  intervalMinutes: number;
  selector?: string;
  prompt: string;
}

interface ErrorBody {
  error?: string;
}

async function request<T>(path: string, init: RequestInit = {}, json = false): Promise<T> {
  const auth = await getApiHeaders();
  const headers: Record<string, string> = { ...(json ? { 'content-type': 'application/json' } : {}), ...auth };
  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as ErrorBody).error ?? `${res.status}`);
  return body as T;
}

// ---------------------------------------------------------------------------
// Overview: memory, approval rules, scratchpad
// ---------------------------------------------------------------------------

export function getAgentMemory(agentId: string): Promise<MemoryEntry[]> {
  return request<{ entries?: MemoryEntry[] }>(`/api/agents/${encodeURIComponent(agentId)}/memory`)
    .then((data) => data.entries ?? []);
}

export function listApprovalRules(agentId: string): Promise<ApprovalRuleRow[]> {
  return request<{ rules?: ApprovalRuleRow[] }>(`/api/approval-rules?agentId=${encodeURIComponent(agentId)}`)
    .then((data) => data.rules ?? []);
}

export function removeApprovalRule(id: string): Promise<void> {
  return request<unknown>(`/api/approval-rules/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => undefined);
}

export function listScratchpad(agentId: string): Promise<ScratchpadItem[]> {
  return request<{ items?: ScratchpadItem[] }>(`/api/agents/${encodeURIComponent(agentId)}/scratchpad`)
    .then((data) => data.items ?? []);
}

export function addScratchpadItem(agentId: string, text: string): Promise<void> {
  return request<unknown>(
    `/api/agents/${encodeURIComponent(agentId)}/scratchpad`,
    { method: 'POST', body: JSON.stringify({ text }) },
    true,
  ).then(() => undefined);
}

export function completeScratchpadItem(agentId: string, id: string): Promise<void> {
  return request<unknown>(
    `/api/agents/${encodeURIComponent(agentId)}/scratchpad/${encodeURIComponent(id)}/complete`,
    { method: 'POST' },
  ).then(() => undefined);
}

// ---------------------------------------------------------------------------
// Routines: URL watches + scheduled routines
// ---------------------------------------------------------------------------

export function listWatches(agentId: string): Promise<UrlWatch[]> {
  return request<{ watches?: UrlWatch[] }>(`/api/agents/${encodeURIComponent(agentId)}/watches`)
    .then((data) => data.watches ?? []);
}

export function addWatch(agentId: string, draft: WatchDraft): Promise<void> {
  return request<unknown>(
    `/api/agents/${encodeURIComponent(agentId)}/watches`,
    { method: 'POST', body: JSON.stringify(draft) },
    true,
  ).then(() => undefined);
}

export function deleteWatch(id: string): Promise<void> {
  return request<unknown>(`/api/watches/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => undefined);
}

export function listSchedules(agentId: string): Promise<Schedule[]> {
  return request<{ schedules?: Schedule[] }>(`/api/agents/${encodeURIComponent(agentId)}/schedules`)
    .then((data) => data.schedules ?? []);
}

export function runScheduleNow(id: string): Promise<void> {
  return request<unknown>(`/api/schedules/${encodeURIComponent(id)}/run-now`, { method: 'POST' }).then(() => undefined);
}

// ---------------------------------------------------------------------------
// Channels (Telegram / Email bindings)
// ---------------------------------------------------------------------------

export function listChannelStatus(): Promise<ChannelStatus[]> {
  return request<{ channels?: ChannelStatus[] }>('/api/channels').then((data) => data.channels ?? []);
}

export function listChannelBindings(agentId: string): Promise<ChannelBinding[]> {
  return request<{ bindings?: ChannelBinding[] }>(`/api/agents/${encodeURIComponent(agentId)}/channels`)
    .then((data) => data.bindings ?? []);
}

export function bindChannel(agentId: string, channel: ChannelStatus['name'], chatId: string): Promise<ChannelBinding> {
  return request<{ binding?: ChannelBinding }>(
    `/api/agents/${encodeURIComponent(agentId)}/channels`,
    { method: 'POST', body: JSON.stringify({ channel, chatId }) },
    true,
  ).then((data) => data.binding as ChannelBinding);
}

export function unbindChannel(agentId: string, bindingId: string): Promise<void> {
  return request<unknown>(
    `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(bindingId)}`,
    { method: 'DELETE' },
  ).then(() => undefined);
}

// ---------------------------------------------------------------------------
// Members: child agents spawned by this companion
// ---------------------------------------------------------------------------

export function listChildren(agentId: string): Promise<ChildAgent[]> {
  return request<{ children?: ChildAgent[] }>(`/api/agents/${encodeURIComponent(agentId)}/children`)
    .then((data) => data.children ?? []);
}

// ---------------------------------------------------------------------------
// Live computer preview (screen + browser frames)
// ---------------------------------------------------------------------------

export function getLiveViewStatus(taskId: string): Promise<LiveStatus> {
  return request<LiveStatus>(`/api/live-view/status?taskId=${encodeURIComponent(taskId)}`);
}

export function getLiveViewFrame(taskId: string, source: LiveSource = 'screen'): Promise<LiveFrame | null> {
  return request<{ frame?: LiveFrame | null }>(
    `/api/live-view/frame?taskId=${encodeURIComponent(taskId)}&source=${source}`,
  ).then((data) => data.frame ?? null);
}
