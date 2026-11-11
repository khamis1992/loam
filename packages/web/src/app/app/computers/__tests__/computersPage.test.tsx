import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setLocale } from '@/i18n/t';

const api = vi.hoisted(() => ({
  actOnCompanionDevice: vi.fn(async () => ({})),
  createCompanionDevice: vi.fn(async () => ({})),
  deleteCompanionDevice: vi.fn(async () => ({})),
  listCompanionDevices: vi.fn(async () => ({
    devices: [{
      id: 'device-1',
      agentId: 'agent-1',
      name: 'cloud-pc-1',
      environment: 'linux',
      provider: 'wsl',
      template: 'coding',
      state: 'running',
    }],
    templates: [{ id: 'coding', environment: 'linux' }],
    goldenReady: true,
    providers: { wsl: true, hyperv: false, fake: false },
  })),
  listCompanions: vi.fn(async () => [{ id: 'agent-1', name: 'Builder' }]),
  prepareGoldenImage: vi.fn(async () => ({})),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/services/companionsApi', () => api);
vi.mock('@/components/computer/CompanionCreateDialog', () => ({
  CompanionCreateDialog: ({ open }: { open: boolean }) => open ? <div role="dialog" aria-label="New companion" /> : null,
}));
vi.mock('@/components/computer/ComputerDetailsDialog', () => ({
  ComputerDetailsDialog: ({ open, onAction, onDelete }: {
    open: boolean;
    onAction: (id: string, action: string) => void;
    onDelete: (id: string) => void;
  }) => open ? (
    <div role="dialog" aria-label="Settings">
      <button onClick={() => onAction('device-1', 'suspend')}>Suspend</button>
      <button onClick={() => onAction('device-1', 'stop')}>Stop</button>
      <button onClick={() => onDelete('device-1')}>Confirm delete</button>
    </div>
  ) : null,
}));
vi.mock('@/components/computer/ComputerTasksDialog', () => ({
  ComputerTasksDialog: ({ open }: { open: boolean }) => open ? <div role="dialog" aria-label="Tasks" /> : null,
}));
vi.mock('@/components/computer/CompanionDeviceViewer', () => ({
  CompanionDeviceViewer: ({ open }: { open: boolean }) => open ? <div role="dialog" aria-label="Live screen" /> : null,
}));
vi.mock('@/components/computer/CompanionCardPreview', () => ({
  CompanionCardPreview: () => null,
}));
vi.mock('@/components/computer/ComputerMetrics', () => ({
  ComputerMetrics: () => null,
}));
vi.mock('@/components/computer/ConnectComputerDialog', () => ({
  ConnectComputerDialog: ({ open, onNewCompanion }: { open: boolean; onNewCompanion: () => void }) => open ? (
    <div role="dialog" aria-label="Connect new computer"><button onClick={onNewCompanion}>New companion</button></div>
  ) : null,
}));
vi.mock('@/components/computer/PhoneControlDialog', () => ({
  PhoneControlDialog: ({ open }: { open: boolean }) => open ? <div role="dialog" aria-label="Control from your phone" /> : null,
}));

import ComputersPage from '../page';

afterEach(() => {
  setLocale('en');
  vi.clearAllMocks();
});

describe('ComputersPage Manus Studio layout', () => {
  it('shows the cloud computer cards and connect devices area', async () => {
    setLocale('en');
    render(<ComputersPage />);

    expect(await screen.findByText('cloud-pc-1')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Create cloud computer' })).toHaveLength(2);
    expect(screen.getByText('Connect your devices')).toBeTruthy();
    expect(screen.getByText('Builder')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect new computer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Control from your phone' })).toBeTruthy();
  });

  it('keeps device actions and companion creation wired after the redesign', async () => {
    setLocale('en');
    render(<ComputersPage />);
    await screen.findByText('cloud-pc-1');

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(api.actOnCompanionDevice).toHaveBeenCalledWith('device-1', 'suspend'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(api.actOnCompanionDevice).toHaveBeenCalledWith('device-1', 'stop'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(api.deleteCompanionDevice).toHaveBeenCalledWith('device-1'));

    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(screen.getByRole('dialog', { name: 'Tasks' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByRole('dialog', { name: 'Live screen' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Control from your phone' }));
    expect(screen.getByRole('dialog', { name: 'Control from your phone' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect new computer' }));
    fireEvent.click(screen.getByRole('button', { name: 'New companion' }));
    expect(screen.getByRole('dialog', { name: 'New companion' })).toBeTruthy();
  });
});
