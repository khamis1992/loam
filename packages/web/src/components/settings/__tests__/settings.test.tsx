import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store, openSettings } from '@/store';
import { SettingsDialog } from '../SettingsDialog';
import { setLocale } from '@/i18n/t';

function renderWithStore(ui: React.ReactElement) {
  return render(<Provider store={store}>{ui}</Provider>);
}

describe('SettingsDialog', () => {
  it('renders the settings dialog with MVP tabs', () => {
    store.dispatch(openSettings('General'));
    renderWithStore(<SettingsDialog />);
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    for (const tab of ['General', 'Account', 'Appearance', 'Data controls', 'My Computer', 'Usage']) {
      expect(screen.getByRole('button', { name: tab })).toBeInTheDocument();
    }
  });

  it('switches to My Computer pane', () => {
    store.dispatch(openSettings('General'));
    renderWithStore(<SettingsDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'My Computer' }));
    expect(screen.getByText('Add folders for quick access when starting tasks on this computer.')).toBeInTheDocument();
    expect(screen.getByText('~/Documents/reports')).toBeInTheDocument();
  });

  it('switches locale to Arabic', () => {
    setLocale('en');
    store.dispatch(openSettings('General'));
    renderWithStore(<SettingsDialog />);
    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument();
    setLocale('ar');
    renderWithStore(<SettingsDialog />);
    expect(document.documentElement.dir).toBe('rtl');
    setLocale('en');
  });

  // W-U4: the 20+ panes are visually regrouped; pane ids and behavior are
  // unchanged. Groups whose settings live inside other panes (models, voice,
  // updates) have no member pane yet and must not render an empty header.
  it('renders the regrouped nav with group headers between related panes', () => {
    store.dispatch(openSettings('General'));
    renderWithStore(<SettingsDialog />);
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    for (const group of ['General', 'Memory & knowledge', 'Security & isolation', 'Connections', 'Advanced']) {
      expect(within(nav).getByRole('heading', { name: group })).toBeInTheDocument();
    }
    for (const empty of ['Models', 'Voice & input', 'Updates & sync']) {
      expect(within(nav).queryByRole('heading', { name: empty })).not.toBeInTheDocument();
    }
    // Pane ids, routes and behavior are untouched by the regroup.
    for (const tab of ['Memory', 'Data controls', 'Connectors', 'My Computer', 'About']) {
      expect(screen.getByRole('button', { name: tab })).toBeInTheDocument();
    }
  });

  it('renders Arabic group headers in the Arabic locale', () => {
    setLocale('ar');
    store.dispatch(openSettings('General'));
    renderWithStore(<SettingsDialog />);
    const nav = screen.getByRole('navigation');
    for (const header of ['عام', 'الذاكرة والمعرفة', 'الأمان والعزل', 'التكاملات', 'متقدم']) {
      expect(within(nav).getByRole('heading', { name: header })).toBeInTheDocument();
    }
    setLocale('en');
  });
});
