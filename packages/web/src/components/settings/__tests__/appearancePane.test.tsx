import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store, setTheme, setDensity, setEffectiveTheme } from '@/store';
import { setLocale } from '@/i18n/t';
import { AppearancePane } from '../AppearancePane';

const THEME_KEY = 'agent-studio:theme';

function renderPane() {
  return render(
    <Provider store={store}>
      <AppearancePane />
    </Provider>,
  );
}

describe('AppearancePane', () => {
  beforeEach(() => {
    setLocale('en');
    store.dispatch(setTheme('light'));
    store.dispatch(setDensity('standard'));
    store.dispatch(setEffectiveTheme('light'));
    window.localStorage.clear();
  });
  afterEach(() => {
    setLocale('en');
    window.localStorage.clear();
  });

  it('renders the theme, density and effective-theme rows', () => {
    renderPane();
    // "Theme" appears as both the section title and the row label.
    expect(screen.getAllByText('Theme').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Interface density')).toBeInTheDocument();
    expect(screen.getAllByText('light').length).toBeGreaterThan(0);
  });

  it('switches to the dark theme and persists it', () => {
    renderPane();
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));

    expect(store.getState().ui.theme).toBe('dark');
    expect(store.getState().ui.effectiveTheme).toBe('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');
  });

  it('falls back to Auto (system) without changing the effective theme', () => {
    store.dispatch(setTheme('system'));
    renderPane();
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));

    expect(store.getState().ui.theme).toBe('system');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('system');
  });

  it('toggles the interface density', () => {
    renderPane();
    fireEvent.click(screen.getByRole('button', { name: 'Compact' }));
    expect(store.getState().ui.density).toBe('compact');
  });
});
