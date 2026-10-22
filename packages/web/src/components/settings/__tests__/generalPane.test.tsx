import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store, setLocale } from '@/store';
import { setLocale as setDocumentLocale } from '@/i18n/t';
import { GeneralPane } from '../GeneralPane';

function renderPane() {
  return render(
    <Provider store={store}>
      <GeneralPane />
    </Provider>,
  );
}

describe('GeneralPane', () => {
  beforeEach(() => {
    setDocumentLocale('en');
    store.dispatch(setLocale('en'));
    window.localStorage.clear();
  });
  afterEach(() => {
    setDocumentLocale('en');
    store.dispatch(setLocale('en'));
    window.localStorage.clear();
  });

  it('defaults to English and offers both language options', () => {
    renderPane();
    const language = screen.getAllByRole('combobox')[0];
    expect(language).toHaveValue('en');
    expect(screen.getByRole('option', { name: 'English' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Arabic' })).toBeTruthy();
  });

  it('switches the locale and document direction to Arabic', () => {
    renderPane();
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'ar' } });

    expect(store.getState().ui.locale).toBe('ar');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('persists a toggled preference to localStorage', () => {
    renderPane();
    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBeGreaterThanOrEqual(3);

    // Second switch is "Sound alert" (no notification permission involved).
    fireEvent.click(switches[1]);
    expect(window.localStorage.getItem('agent-studio:sound-alert')).toBe('true');

    // Toggling again turns it back off.
    fireEvent.click(screen.getAllByRole('switch')[1]);
    expect(window.localStorage.getItem('agent-studio:sound-alert')).toBe('false');
  });
});
