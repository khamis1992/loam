// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store } from '@/store';
import { t } from '@/i18n/t';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/app' }));
vi.mock('@/services/creditsApi', () => ({ fetchCredits: async () => ({ referral: null }) }));

import { Sidebar } from '../Sidebar';

describe('Sidebar collapsible rail (H4)', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('expands by default and collapses to an icon rail with tooltips', () => {
    render(
      <Provider store={store}>
        <Sidebar />
      </Provider>,
    );
    const nav = screen.getByLabelText(t('Sidebar'));
    expect(nav.getAttribute('data-collapsed')).toBe('false');
    // collapsed state: labels hidden, native tooltips via title
    fireEvent.click(screen.getByTestId('sidebar-collapse-toggle'));
    expect(nav.getAttribute('data-collapsed')).toBe('true');
    const newTaskTitle = screen.getByTitle(t('New task'));
    expect(newTaskTitle).toBeTruthy();
    expect(screen.queryByText(t('New task'))).toBeNull();
    // persistence
    expect(localStorage.getItem('loam.sidebar.collapsed')).toBe('1');
  });

  it('restores the persisted collapsed state and toggles back', () => {
    localStorage.setItem('loam.sidebar.collapsed', '1');
    render(
      <Provider store={store}>
        <Sidebar />
      </Provider>,
    );
    const nav = screen.getByLabelText(t('Sidebar'));
    expect(nav.getAttribute('data-collapsed')).toBe('true');
    fireEvent.click(screen.getByTestId('sidebar-collapse-toggle'));
    expect(nav.getAttribute('data-collapsed')).toBe('false');
    expect(localStorage.getItem('loam.sidebar.collapsed')).toBe('0');
    expect(screen.getByText(t('New task'))).toBeTruthy();
  });

  it('expands via Ctrl+B', () => {
    localStorage.setItem('loam.sidebar.collapsed', '1');
    render(
      <Provider store={store}>
        <Sidebar />
      </Provider>,
    );
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(screen.getByLabelText(t('Sidebar')).getAttribute('data-collapsed')).toBe('false');
  });
});
