import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store, openSettings } from '@/store';
import { SettingsDialog } from '../SettingsDialog';
import { ShortcutsPane } from '../ShortcutsPane';
import { setLocale } from '@/i18n/t';
import { KEYBINDINGS } from '@/lib/keybindings';

function renderWithStore(ui: React.ReactElement) {
  return render(<Provider store={store}>{ui}</Provider>);
}

describe('ShortcutsPane', () => {
  it('renders every registry binding grouped under its section', () => {
    setLocale('en');
    renderWithStore(<ShortcutsPane />);
    for (const group of ['General', 'Search', 'Chat', 'Spreadsheet']) {
      expect(screen.getByRole('heading', { name: group })).toBeInTheDocument();
    }
    for (const binding of KEYBINDINGS) {
      expect(screen.getByText(binding.description)).toBeInTheDocument();
    }
  });

  it('shows the Ctrl+K search shortcut that works today', () => {
    setLocale('en');
    renderWithStore(<ShortcutsPane />);
    expect(screen.getByText('Open search')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+K')).toBeInTheDocument();
  });

  it('renders one kbd chip per registry binding', () => {
    setLocale('en');
    const { container } = renderWithStore(<ShortcutsPane />);
    expect(container.querySelectorAll('kbd')).toHaveLength(KEYBINDINGS.length);
  });

  it('replaces the Shortcuts "Coming soon" entry in the settings dialog', () => {
    setLocale('en');
    store.dispatch(openSettings('General'));
    renderWithStore(<SettingsDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Shortcuts' }));
    expect(screen.getByText('Open search')).toBeInTheDocument();
    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument();
  });

  it('localizes shortcut descriptions to Arabic', () => {
    setLocale('ar');
    renderWithStore(<ShortcutsPane />);
    expect(screen.getByText('فتح البحث')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+K')).toBeInTheDocument();
    setLocale('en');
  });
});
