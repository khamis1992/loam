import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store, setUser } from '@/store';
import { setLocale } from '@/i18n/t';
import { UsagePane } from '../UsagePane';

function renderPane() {
  return render(
    <Provider store={store}>
      <UsagePane />
    </Provider>,
  );
}

describe('UsagePane', () => {
  afterEach(() => {
    setLocale('en');
    store.dispatch(setUser(null));
  });

  it('falls back to demo identity when no user is signed in', () => {
    setLocale('en');
    store.dispatch(setUser(null));
    renderPane();
    expect(screen.getAllByText('Demo User').length).toBeGreaterThan(0);
    expect(screen.getAllByText('demo@example.com').length).toBeGreaterThan(0);
  });

  it('shows the signed-in user name and email', () => {
    setLocale('en');
    store.dispatch(setUser({ displayname: 'Ada Lovelace', email: 'ada@example.com' }));
    renderPane();
    expect(screen.getAllByText('Ada Lovelace').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ada@example.com').length).toBeGreaterThan(0);
  });

  it('shows the credit balance rows', () => {
    setLocale('en');
    store.dispatch(setUser(null));
    renderPane();
    expect(screen.getByText('Total credits')).toBeInTheDocument();
    expect(screen.getByText(/18[,.]100/)).toBeInTheDocument();
    expect(screen.getByText(/300 \/ 300/)).toBeInTheDocument();
  });

  it('shows the tasks completed row', () => {
    setLocale('en');
    store.dispatch(setUser(null));
    renderPane();
    expect(screen.getByText('Tasks completed')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});
