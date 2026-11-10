import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setLocale } from '@/i18n/t';
import type { AppProjectDto } from '@/services/appBuilderApi';

function project(id: string, title: string): AppProjectDto {
  return {
    id,
    taskId: `task_${id}`,
    title,
    description: `Build ${title}`,
    templateId: 'website',
    features: [],
    workspaceDir: '/tmp/workspace',
    appDir: '/tmp/workspace/app',
    defaultFlavor: 'quick',
    status: 'idle',
    activeVersion: null,
    settings: {},
    remixOfProjectId: null,
    remixOfVersion: null,
    depsMode: 'auto',
    ai: { baseUrl: null, model: null, dailyTokenCap: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

const existing = project('app_existing', 'Ceramics shop');
const created = project('app_created', 'A new website');
const api = vi.hoisted(() => ({
  listAppProjects: vi.fn(),
  createAppProject: vi.fn(),
  startRun: vi.fn(),
}));

vi.mock('@/services/appBuilderApi', () => api);
vi.mock('@/components/appbuilder/AppBuilderWorkspace', () => ({
  AppBuilderWorkspace: ({ projectId, onClose }: { projectId: string; onClose: () => void }) => (
    <aside aria-label={`Workspace ${projectId}`}><button onClick={onClose}>Close workspace</button></aside>
  ),
}));

import WebsitesPage from '../page';

beforeEach(() => {
  api.listAppProjects.mockResolvedValue({ projects: [existing] });
  api.createAppProject.mockResolvedValue({ project: created });
  api.startRun.mockResolvedValue({ runId: 'run_1' });
});

afterEach(() => {
  setLocale('en');
  vi.clearAllMocks();
});

describe('WebsitesPage Manus Studio experience', () => {
  it('renders the hero, real projects, capabilities and categorized templates', async () => {
    setLocale('en');
    render(<WebsitesPage />);

    expect(await screen.findByText('Ceramics shop')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Websites' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /You built a website\./ })).toBeTruthy();
    expect(screen.getByText('Power up your website')).toBeTruthy();
    expect(screen.getByTestId('website-template-christmas-sale')).toBeTruthy();
    expect(screen.getByTestId('website-template-online-booking')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'SaaS' }));
    expect(screen.getByTestId('website-template-sales-crm')).toBeTruthy();
    expect(screen.queryByTestId('website-template-christmas-sale')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByRole('button', { name: /Custom domain/ })).toBeTruthy();
  });

  it('opens an existing website in its AppBuilder workspace', async () => {
    render(<WebsitesPage />);
    fireEvent.click(await screen.findByText('Ceramics shop'));
    expect(screen.getByRole('complementary', { name: 'Workspace app_existing' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace' }));
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('creates a website and starts its real build run', async () => {
    render(<WebsitesPage />);
    await screen.findByText('Ceramics shop');
    fireEvent.click(screen.getByRole('button', { name: 'New website' }));
    fireEvent.change(screen.getByPlaceholderText('Describe the website you want to build'), {
      target: { value: 'A portfolio website with selected projects and a contact form.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create website' }));

    await waitFor(() => expect(api.createAppProject).toHaveBeenCalledWith(
      'A portfolio website with selected projects and a contact form.',
      'A portfolio website with selected projects and a contact form.',
      'quick',
    ));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledWith(
      'app_created',
      'A portfolio website with selected projects and a contact form.',
      'quick',
    ));
    expect(await screen.findByRole('complementary', { name: 'Workspace app_created' })).toBeTruthy();
  });

  it('uses capabilities and templates as editable build briefs', async () => {
    render(<WebsitesPage />);
    await screen.findByText('Ceramics shop');

    fireEvent.click(screen.getByRole('button', { name: /Add AI-powered chat/ }));
    expect((screen.getByPlaceholderText('Describe the website you want to build') as HTMLTextAreaElement).value).toContain('AI integration');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('tab', { name: 'SaaS' }));
    fireEvent.click(screen.getByTestId('website-template-sales-crm'));
    expect((screen.getByPlaceholderText('Describe the website you want to build') as HTMLTextAreaElement).value).toContain('sales CRM');
  });

  it('keeps a created project when starting its run fails and retries without duplicating it', async () => {
    api.startRun.mockRejectedValueOnce(new Error('engine unavailable')).mockResolvedValueOnce({ runId: 'run_retry' });
    render(<WebsitesPage />);
    await screen.findByText('Ceramics shop');
    fireEvent.click(screen.getByRole('button', { name: 'New website' }));
    fireEvent.change(screen.getByPlaceholderText('Describe the website you want to build'), {
      target: { value: 'A booking website with a calendar and appointment confirmation.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create website' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('engine unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry run' }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(2));
    expect(api.createAppProject).toHaveBeenCalledTimes(1);
  });

  it('offers a retry when projects fail to load', async () => {
    api.listAppProjects.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ projects: [existing] });
    render(<WebsitesPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Ceramics shop')).toBeTruthy();
    expect(api.listAppProjects).toHaveBeenCalledTimes(2);
  });
});
