import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentInfoPane } from '../AgentInfoPane';
import type { GroupChat } from '../groupTypes';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response> = () => jsonResponse({})) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', mock);
  return mock;
}

const agent = {
  id: 'a1',
  name: 'Ada',
  emoji: '🤖',
  description: 'Builds things',
  instructions: 'Always be helpful.',
  mode: 'build',
  workMode: 'loam',
  avatarShape: 'squircle',
  avatarColor: 'blue',
};

function sectionHeadings(): string[] {
  return screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent ?? '');
}

describe('AgentInfoPane section set (Grok Bot parity)', () => {
  beforeEach(() => {
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders Overview, Routines, Channels and Members in a single scroll', () => {
    render(<AgentInfoPane agent={agent} threadUid={null} onClose={() => {}} />);
    expect(sectionHeadings()).toEqual(['Overview', 'Routines', 'Channels', 'Members']);
    expect(screen.queryByText('Media')).not.toBeInTheDocument();
    expect(screen.queryByText('Computer')).not.toBeInTheDocument();
  });

  it('shows the avatar, name and title in the header', () => {
    render(<AgentInfoPane agent={{ ...agent, title: 'Builder' }} threadUid={null} onClose={() => {}} />);
    expect(screen.getByRole('img', { name: 'Ada' })).toBeInTheDocument();
    expect(screen.getAllByText('Ada').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Builder').length).toBeGreaterThan(0);
  });

  it('collapses Model, Effort, Allowed services, Memory, To-do and Approval rules behind Advanced', () => {
    render(<AgentInfoPane agent={agent} threadUid={null} onClose={() => {}} />);
    expect(screen.queryByText('Model')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.getByText('Effort')).toBeInTheDocument();
    expect(screen.getByText('Allowed services')).toBeInTheDocument();
    expect(screen.getByText('Memory')).toBeInTheDocument();
    expect(screen.getByText('To-do')).toBeInTheDocument();
    expect(screen.getByText('Approval rules')).toBeInTheDocument();
  });

  it('group pane shows only the Members section', () => {
    const group = { id: 'g1', name: 'Team', createdAt: '2026-01-01T00:00:00.000Z', memberIds: [] } as GroupChat;
    render(<AgentInfoPane agent={agent} threadUid={null} onClose={() => {}} group={group} />);
    expect(sectionHeadings()).toEqual(['Members']);
  });
});

describe('AgentInfoPane per-agent settings subpage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens from the gear and saves avatar/name/title/description/notifications', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url.includes('/api/agents/a1') && init?.method === 'POST') return jsonResponse({ agent });
      return jsonResponse({});
    });
    render(<AgentInfoPane agent={{ ...agent, title: 'Builder', notifications: false }} threadUid={null} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }));
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();

    const notifications = screen.getByRole('checkbox');
    expect(notifications).not.toBeChecked();
    fireEvent.click(notifications);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (call) => String(call[0]).includes('/api/agents/a1') && (call[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(String((post![1] as RequestInit).body)) as Record<string, unknown>;
      expect(body).toMatchObject({ name: 'Ada', title: 'Builder', notifications: true, avatarShape: 'squircle' });
    });
  });
});
