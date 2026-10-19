import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
});
