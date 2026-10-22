import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SessionInsightsPanel } from '../SessionInsightsPanel';
import type { SessionInsights } from '@/services/insightsApi';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const mock = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal('fetch', mock);
  return mock;
}

const insights: SessionInsights = {
  taskId: 'task_1',
  generatedAt: '2026-01-01T00:00:00.000Z',
  metrics: {
    steps: 4,
    toolCalls: 2,
    toolFailures: 1,
    promptTokens: 1000,
    completionTokens: 500,
    totalTokens: 1500,
    costUsd: 0.0075,
    userMessages: 1,
    assistantMessages: 1,
    durationMs: 122000,
    category: 'build',
    model: 'gpt-4o',
  },
  issueTimeline: [
    { kind: 'failure', index: 2, at: '2026-01-01T00:00:02.000Z', detail: 'shell_run: command not found: npm', tool: 'shell_run' },
    { kind: 'error', index: 3, at: '2026-01-01T00:00:03.000Z', detail: 'build failed' },
  ],
  knowledgeUsage: { memories: 3, skills: 2, memoryToolCalls: 1, skillToolCalls: 1 },
  actionableFeedback: ['1 of 2 tool call(s) failed — check the failing commands.'],
  improvedPrompt: 'Build a counter app\n\nNext time:\n- Do not repeat the failed tool call(s): shell_run.',
};

describe('SessionInsightsPanel (D18)', () => {
  beforeEach(() => {
    stubFetch((url) => (url.includes('/api/tasks/task_1/insights') ? jsonResponse({ insights }) : jsonResponse({})));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches the route and renders metrics, timeline, feedback and the improved prompt', async () => {
    render(<SessionInsightsPanel taskId="task_1" />);
    expect(await screen.findByTestId('session-insights-panel')).toBeInTheDocument();
    expect(screen.getByText('Session insights')).toBeInTheDocument();
    expect(screen.getByText('1500 ($0.0075)')).toBeInTheDocument();
    expect(screen.getByText('2m 2s')).toBeInTheDocument();
    expect(screen.getByText('shell_run: command not found: npm')).toBeInTheDocument();
    expect(screen.getByText('build failed')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 tool call(s) failed — check the failing commands.')).toBeInTheDocument();
    expect(screen.getByTestId('insights-improved-prompt')).toHaveTextContent('Build a counter app');
  });

  it('shows the empty state when no issue was recorded', async () => {
    stubFetch(() => jsonResponse({ insights: { ...insights, issueTimeline: [] } }));
    render(<SessionInsightsPanel taskId="task_1" />);
    expect(await screen.findByTestId('insights-no-issues')).toBeInTheDocument();
  });

  it('surfaces a load failure', async () => {
    stubFetch(() => jsonResponse({ error: 'task not found' }, 404));
    render(<SessionInsightsPanel taskId="task_1" />);
    await waitFor(() => expect(screen.getByTestId('insights-error')).toBeInTheDocument());
    expect(screen.getByText(/task not found/)).toBeInTheDocument();
  });
});
