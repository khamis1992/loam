import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FlowPlaybook } from '../FlowPlaybook';
import { flowTemplateHref, type FlowTemplate } from '@/services/flowTemplatesApi';

function flow(over: Partial<FlowTemplate> = {}): FlowTemplate {
  return {
    id: 'nutrio-dashboard',
    title: 'Nutrio Dashboard',
    description: 'A dashboard for Nutrio.',
    prompt: 'Create a Nutrio analytics dashboard.',
    mode: 'build',
    effort: 'max',
    outputType: 'website',
    icon: '📊',
    category: 'Dashboard',
    ...over,
  };
}

const FLOWS = [
  flow(),
  flow({ id: 'arabic-report', title: 'Arabic Report', mode: 'write', effort: 'max', outputType: 'text', category: 'Writing' }),
];

function stubFetch(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));
}

describe('FlowPlaybook (N15)', () => {
  beforeEach(() => {
    stubFetch({ flows: FLOWS });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders nothing while closed and lists the flows once opened', async () => {
    const { rerender } = render(<FlowPlaybook open={false} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(<FlowPlaybook open onClose={() => {}} />);
    expect(await screen.findByRole('dialog', { name: 'Case Playbook' })).toBeTruthy();
    expect(screen.getByText('Nutrio Dashboard')).toBeTruthy();
    expect(screen.getByText('Arabic Report')).toBeTruthy();
  });

  it('shows the mode and effort on each card', async () => {
    render(<FlowPlaybook open onClose={() => {}} />);
    await screen.findByText('Nutrio Dashboard');
    expect(screen.getByText('Build · Max')).toBeTruthy();
    expect(screen.getByText('Write · Max')).toBeTruthy();
  });

  it('filters by search query', async () => {
    render(<FlowPlaybook open onClose={() => {}} />);
    await screen.findByText('Nutrio Dashboard');

    fireEvent.change(screen.getByPlaceholderText('Search flows...'), { target: { value: 'arabic' } });
    expect(screen.getByText('Arabic Report')).toBeTruthy();
    expect(screen.queryByText('Nutrio Dashboard')).toBeNull();
  });

  it('filters by category', async () => {
    render(<FlowPlaybook open onClose={() => {}} />);
    await screen.findByText('Nutrio Dashboard');

    fireEvent.click(screen.getByRole('button', { name: 'Writing' }));
    expect(screen.getByText('Arabic Report')).toBeTruthy();
    expect(screen.queryByText('Nutrio Dashboard')).toBeNull();
  });

  it('"Try this flow" navigates to the pre-fill deep link and closes the dialog', async () => {
    const close = vi.fn();
    render(<FlowPlaybook open onClose={close} />);
    const card = await screen.findByText('Nutrio Dashboard');
    const button = card.closest('div')!.querySelector('button') as HTMLButtonElement;

    const href = vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location } as Location);
    const setter = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, set href(v: string) { setter(v); } },
    });

    fireEvent.click(button);
    await waitFor(() => expect(setter).toHaveBeenCalled());
    const target = String(setter.mock.calls[0]![0]);
    expect(target).toContain('/app/demo-running?draft=');
    const params = new URLSearchParams(target.split('?')[1]);
    expect(params.get('draft')).toBe('Create a Nutrio analytics dashboard.');
    expect(JSON.parse(params.get('extData')!)).toEqual({ loamMode: 'build', effort: 'max', outputType: 'website' });
    expect(close).toHaveBeenCalled();

    href.mockRestore();
  });

  it('shows the fetch error when the catalog cannot load', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })));
    render(<FlowPlaybook open onClose={() => {}} />);
    expect(await screen.findByText('nope')).toBeTruthy();
  });
});

describe('flowTemplateHref (N15)', () => {
  it('builds a deep link with prompt, mode, effort and output type', () => {
    const href = flowTemplateHref(flow());
    const params = new URLSearchParams(href.split('?')[1]);
    expect(href.startsWith('/app/demo-running?')).toBe(true);
    expect(params.get('draft')).toBe('Create a Nutrio analytics dashboard.');
    expect(JSON.parse(params.get('extData')!)).toEqual({ loamMode: 'build', effort: 'max', outputType: 'website' });
  });

  it('omits outputType when it is auto', () => {
    const href = flowTemplateHref(flow({ outputType: 'auto' }));
    const params = new URLSearchParams(href.split('?')[1]);
    expect(JSON.parse(params.get('extData')!)).toEqual({ loamMode: 'build', effort: 'max' });
  });

  it('keeps the flow prompt intact through the URL', () => {
    const href = flowTemplateHref(flow({ prompt: 'line one\nline two & more' }));
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get('draft')).toBe('line one\nline two & more');
  });
});
