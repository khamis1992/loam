import { getApiBase, getApiHeaders } from './rpc';

/** Session insights (D18) payload returned by GET /api/tasks/:id/insights. */
export interface InsightsMetrics {
  steps: number;
  toolCalls: number;
  toolFailures: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  userMessages: number;
  assistantMessages: number;
  durationMs: number;
  category: string;
  model: string;
}

export interface IssueEvent {
  kind: 'error' | 'failure' | 'retry' | 'stall';
  index: number;
  at: string;
  detail: string;
  tool?: string;
}

export interface KnowledgeUsage {
  memories: number;
  skills: number;
  memoryToolCalls: number;
  skillToolCalls: number;
}

export interface SessionInsights {
  taskId: string;
  generatedAt: string;
  metrics: InsightsMetrics;
  issueTimeline: IssueEvent[];
  knowledgeUsage: KnowledgeUsage;
  actionableFeedback: string[];
  improvedPrompt: string | null;
}

interface ErrorBody {
  error?: string;
}

async function request<T>(path: string): Promise<T> {
  const auth = await getApiHeaders();
  const res = await fetch(`${getApiBase()}${path}`, { headers: auth });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as ErrorBody).error ?? `${res.status}`);
  return body as T;
}

export function fetchSessionInsights(taskId: string): Promise<{ insights: SessionInsights }> {
  return request<{ insights: SessionInsights }>(`/api/tasks/${encodeURIComponent(taskId)}/insights`);
}
