/**
 * Thin typed bridge to the desktop in-app browser surface.
 *
 * The real WebContentsView lives in the Electron main process
 * (electron/inAppBrowser.cjs) behind the `inAppBrowser` desktop IPC namespace.
 * This module gives the Settings pane promise-based wrappers and a state
 * subscription without speaking raw IPC. In web/dev builds (no Electron
 * preload) every call is a safe no-op and isInAppBrowserSupported() reports
 * false so the pane can fall back to an explanatory empty state.
 */

export interface InAppBrowserState {
  attached: boolean;
  /** Effective visibility applied by the main process (renderer intent AND
   *  window focus/minimize factor). Optional so older hosts stay compatible. */
  visible?: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface InAppBrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InAppBrowserNavigateResult {
  ok: boolean;
  error?: string;
}

export interface AgentBrowserSettings {
  browserHeadless?: boolean;
  browserHomepage?: string;
}

type ApiRecord = Record<string, (...args: unknown[]) => unknown>;

function apis(): ApiRecord | undefined {
  if (typeof window === 'undefined') return undefined;
  const all = (window as unknown as { __apis?: Record<string, ApiRecord> }).__apis;
  return all?.inAppBrowser;
}

function events(): Record<string, (cb: (payload: InAppBrowserState) => void) => () => void> | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { __events?: Record<string, Record<string, (cb: (p: InAppBrowserState) => void) => () => void>> }).__events
    ?.inAppBrowser;
}

export function isInAppBrowserSupported(): boolean {
  return apis() !== undefined;
}

function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  const methodFn = apis()?.[method];
  if (!methodFn) return Promise.resolve(undefined as T);
  return methodFn(...args) as Promise<T>;
}

export async function iabAttach(): Promise<InAppBrowserState> {
  return invoke<InAppBrowserState>('attach');
}

export async function iabDetach(): Promise<InAppBrowserState> {
  return invoke<InAppBrowserState>('detach');
}

export async function iabSetBounds(rect: InAppBrowserRect): Promise<boolean> {
  return (await invoke<boolean | undefined>('setBounds', rect)) === true;
}

/**
 * Renderer-declared visibility intent: true when the preview surface is
 * mounted AND actually on screen (not scrolled away, not under a modal, not
 * hidden behind another route). The main process combines this with the
 * window focus/minimize factor before painting the native view.
 */
export async function iabSetVisible(visible: boolean): Promise<void> {
  await invoke('setVisible', visible);
}

export async function iabNavigate(url: string): Promise<InAppBrowserNavigateResult> {
  const res = await invoke<InAppBrowserNavigateResult | undefined>('navigate', url);
  return res ?? { ok: false, error: 'bridge unavailable' };
}

export async function iabBack(): Promise<InAppBrowserState> {
  return invoke<InAppBrowserState>('back');
}

export async function iabForward(): Promise<InAppBrowserState> {
  return invoke<InAppBrowserState>('forward');
}

export async function iabReload(): Promise<InAppBrowserState> {
  return invoke<InAppBrowserState>('reload');
}

export async function iabStop(): Promise<InAppBrowserState> {
  return invoke<InAppBrowserState>('stop');
}

export async function iabHome(): Promise<InAppBrowserNavigateResult> {
  const res = await invoke<InAppBrowserNavigateResult | undefined>('home');
  return res ?? { ok: false, error: 'bridge unavailable' };
}

export async function iabGetState(): Promise<InAppBrowserState> {
  return {
    attached: false,
    visible: false,
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    ...(await invoke<Partial<InAppBrowserState>>('getState')),
  };
}

export async function iabClearData(): Promise<{ cleared: boolean }> {
  return invoke<{ cleared: boolean }>('clearData');
}

/** Subscribe to pushed state changes from the main process. Returns the
 *  unsubscribe function (no-op when the bridge is unavailable). */
export function iabOnStateChanged(cb: (state: InAppBrowserState) => void): () => void {
  const sub = events()?.onStateChanged;
  if (!sub) return () => undefined;
  return sub(cb);
}
