import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

// ---------------------------------------------------------------------------
// W-U4: the recommended-setup (first-run) section. All three status checks hit
// real endpoints through a stubbed fetch, and the STT row must stay honest —
// the STT server is a user-run Python process, so there is a copy command and
// no in-app "start" button.
// ---------------------------------------------------------------------------

interface SetupFixture {
  codegraphOk?: boolean;
  codegraphState?: string;
  installRunning?: boolean;
  codemode?: boolean;
  sttUp?: boolean;
}

interface RecordedCall {
  url: string;
  method: string;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

const CODEGRAPH_STATUS_URL = /\/api\/codegraph\/status$/;
const CODEGRAPH_INSTALL_URL = /\/api\/codegraph\/runtime\/install$/;

function setupFixtureHandler(fixture: SetupFixture): { handler: (url: string, method: string) => Response; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const handler = (url: string, method: string): Response => {
    calls.push({ url, method });
    if (CODEGRAPH_INSTALL_URL.test(url)) return jsonResponse({ started: true }, 202);
    if (CODEGRAPH_STATUS_URL.test(url)) {
      return jsonResponse({
        ok: fixture.codegraphOk === true,
        enabled: true,
        runtime: { state: fixture.codegraphState ?? (fixture.codegraphOk ? 'ready' : 'not-installed') },
        install: { running: fixture.installRunning === true, step: null },
      });
    }
    if (url.includes('/api/settings')) return jsonResponse({ codemode: fixture.codemode === true, trainingOptOut: false, officeIdentity: null });
    if (url.includes('127.0.0.1:3947/health')) return jsonResponse({ ok: true, model: 'base' });
    return jsonResponse({}, 404);
  };
  return { handler, calls };
}

function stubFetch(handler: (url: string, method: string) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      return handler(url, method);
    }) as unknown as typeof fetch,
  );
}

describe('GeneralPane recommended setup (W-U4)', () => {
  let fixture: { handler: (url: string, method: string) => Response; calls: RecordedCall[] };

  beforeEach(() => {
    setDocumentLocale('en');
    store.dispatch(setLocale('en'));
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setDocumentLocale('en');
    store.dispatch(setLocale('en'));
    window.localStorage.clear();
  });

  it('shows the three setup items with live status dots from real endpoints', async () => {
    fixture = setupFixtureHandler({ codegraphOk: false, codemode: true, sttUp: true });
    stubFetch(fixture.handler);
    renderPane();

    expect(screen.getByText('Recommended setup')).toBeInTheDocument();
    expect(screen.getByText('Code graph')).toBeInTheDocument();
    expect(screen.getByText('Execution sandbox')).toBeInTheDocument();
    expect(screen.getByText('Speech recognition')).toBeInTheDocument();

    // Sandbox on + STT reachable → two green dots; codegraph not installed → red.
    await waitFor(() => expect(screen.getAllByLabelText('Ready')).toHaveLength(2));
    expect(screen.getByLabelText('Not installed')).toBeInTheDocument();
  });

  it('codegraph status off shows the honest install action backed by the real endpoint', async () => {
    fixture = setupFixtureHandler({ codegraphOk: false, codemode: false, sttUp: false });
    stubFetch(fixture.handler);
    renderPane();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() =>
      expect(fixture.calls.some((c) => CODEGRAPH_INSTALL_URL.test(c.url) && c.method === 'POST')).toBe(true),
    );
  });

  it('STT row shows the real command and the copy button copies it — no fake start', async () => {
    fixture = setupFixtureHandler({ codegraphOk: true, codemode: false, sttUp: true });
    stubFetch(fixture.handler);
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPane();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy setup command' })).toBeTruthy());
    // The command is shown inline (visible, honest) and matches the real script.
    expect(screen.getByText('npm run stt')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy setup command' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('npm run stt'));
    expect(screen.getByText('Copied')).toBeInTheDocument();
  });

  it('sandbox action switches to the sandbox pane (Data controls)', async () => {
    fixture = setupFixtureHandler({ codegraphOk: true, codemode: false, sttUp: false });
    stubFetch(fixture.handler);
    renderPane();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Open sandbox settings' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Open sandbox settings' }));
    expect(store.getState().ui.settingsTab).toBe('Data controls');
  });

  it('unreachable endpoints keep the red dots instead of faking readiness', async () => {
    // The STT probe is a no-cors reachability check: reject = not running.
    stubFetch((url) => {
      if (url.includes('127.0.0.1:3947')) throw new TypeError('network down');
      return jsonResponse({}, 500);
    });
    renderPane();

    await waitFor(() => {
      expect(screen.getByLabelText('Not installed')).toBeInTheDocument();
      expect(screen.getByLabelText('Off')).toBeInTheDocument();
      expect(screen.getByLabelText('Not running')).toBeInTheDocument();
    });
  });
});
