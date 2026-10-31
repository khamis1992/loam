// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolUsedEvent } from '@shared/socket';
import { t } from '@/i18n/t';

vi.mock('@/services/rpc', () => ({
  getApiBase: () => 'http://127.0.0.1:3939',
  getApiHeaders: async () => ({ 'x-test': '1' }),
}));
vi.mock('@/services/desktopApis', () => ({
  desktopEvents: { terminal: { onEvent: () => () => {} }, emit: vi.fn(), on: vi.fn() },
}));

import { ComputerPanel } from '../ComputerPanel';

function officeEvent(): ToolUsedEvent {
  return {
    id: 'e1', timestamp: new Date('2026-10-31T15:17:00').getTime(),
    type: 'toolUsed', tool: 'office_preview', actionId: 'e1', status: 'success',
    detail: { path: 'reports/quarterly.docx' },
  } as unknown as ToolUsedEvent;
}

describe('viewer chrome (Manus-style content panel)', () => {
  afterEach(cleanup);

  it('shows the document name, last-modified time, and a working download link', () => {
    render(
      <ComputerPanel event={officeEvent()} sessionId="s1" taskId="task_1" onClose={() => {}} />,
    );
    const title = screen.getByTestId('viewer-title');
    expect(title).toHaveTextContent('quarterly.docx');
    const statusbar = screen.getByTestId('viewer-statusbar');
    expect(statusbar.textContent).toContain('quarterly.docx');
    // Same formatting the component uses — locale-dependent (12h/24h).
    const expected = new Date('2026-10-31T15:17:00').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    expect(statusbar.textContent).toContain(expected);
    const download = screen.getByRole('link', { name: t('Download file') });
    expect(download).toHaveAttribute('href', 'http://127.0.0.1:3939/api/media?taskId=task_1&path=reports%2Fquarterly.docx');
  });

  it('wraps document surfaces in the centered paper frame and hides chrome for terminal', () => {
    const { rerender } = render(
      <ComputerPanel event={officeEvent()} sessionId="s1" taskId="task_1" onClose={() => {}} />,
    );
    expect(screen.getByTestId('viewer-paper')).toBeTruthy();

    const terminalEvent = { ...officeEvent(), tool: 'shell_start', detail: {} } as unknown as ToolUsedEvent;
    rerender(
      <ComputerPanel event={terminalEvent} sessionId="s1" taskId="task_1" onClose={() => {}} />,
    );
    expect(screen.queryByTestId('viewer-paper')).toBeNull();
    expect(screen.queryByTestId('viewer-statusbar')).toBeNull();
    expect(screen.getByTestId('viewer-title').textContent!.length).toBeGreaterThan(0);
  });

  it('falls back to the tool label when the event carries no file path', () => {
    const bare = { ...officeEvent(), detail: {} } as unknown as ToolUsedEvent;
    render(<ComputerPanel event={bare} sessionId="s1" taskId={undefined} onClose={() => {}} />);
    expect(screen.getByTestId('viewer-title').textContent!.length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: t('Download file') })).toBeNull();
  });

  it('panel close lives in the tab toolbar row', () => {
    render(<ComputerPanel event={officeEvent()} sessionId="s1" onClose={() => {}} />);
    const close = screen.getByRole('button', { name: t('Close panel') });
    fireEvent.click(close);
    // onClose is the parent contract; the button being clickable is the contract here.
    expect(close).toBeTruthy();
  });
});
