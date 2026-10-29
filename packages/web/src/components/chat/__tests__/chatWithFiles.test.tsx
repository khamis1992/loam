import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// The Composer reads connectors/skills from the backend on mount; keep it quiet.
vi.mock('@/services/rpc', () => ({
  getApiBase: () => 'http://localhost:8787',
  getApiHeaders: async () => ({}),
}));
vi.mock('@/services/projectContextApi', () => ({
  fetchProjectBranch: async () => ({ branch: 'main' }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { Composer } from '../Composer';

/** The exact preset the button sends through the composer's onSend path. */
const CHAT_WITH_FILES_PROMPT =
  'تحدث مع ملفاتي: فلتر ملفات هذه المهمة في حديقة المعرفة ثم أجب من ملفاتي فقط';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Composer «تحدث مع ملفاتك» button (Phase-2 W2)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/connectors')) return json({ connectors: [] });
      if (url.includes('/api/skills')) return json({ skills: [] });
      if (url.includes('/api/mcp/status')) return json({ servers: [] });
      return json({});
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
    const onSend = props.onSend ?? vi.fn();
    render(<Composer onSend={onSend} {...props} />);
    return { onSend: onSend as ReturnType<typeof vi.fn> };
  }

  it('renders the button when no Loam mode is known (fresh composer)', () => {
    renderComposer();
    expect(screen.getByTestId('chat-with-files')).toBeTruthy();
    // The label rides the i18n key 'Chat with your files' (Arabic: تحدث مع ملفاتك).
    expect(screen.getByTestId('chat-with-files').textContent).toContain('Chat with your files');
  });

  it('sends the Arabic garden preset through the existing onSend path', () => {
    const { onSend } = renderComposer();
    fireEvent.click(screen.getByTestId('chat-with-files'));
    expect(onSend).toHaveBeenCalledTimes(1);
    const [text, , files, extData] = onSend.mock.calls[0] as [string, string, File[], Record<string, unknown> | undefined];
    expect(text).toBe(CHAT_WITH_FILES_PROMPT);
    expect(files).toEqual([]);
    // The preset rides the same transport: extData (when present) is a plain
    // object exactly like a typed message produces, not a new transport.
    if (extData) expect(typeof extData).toBe('object');
  });

  it('is shown for the ask and build modes', () => {
    for (const mode of ['ask', 'build']) {
      const onSend = vi.fn();
      const view = render(<Composer onSend={onSend} resolvedLoamMode={{ mode, label: 'Loam', labelAr: 'لوم' }} />);
      expect(screen.getByTestId('chat-with-files')).toBeTruthy();
      view.unmount();
    }
  });

  it('is hidden for modes that do not carry the kb_* tools', () => {
    renderComposer({ resolvedLoamMode: { mode: 'research', label: 'Loam Research', labelAr: 'ابحث' } });
    expect(screen.queryByTestId('chat-with-files')).toBeNull();
  });
});
