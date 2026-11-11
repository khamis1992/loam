import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setLocale } from '@/i18n/t';
import type { CompanionDevice } from '@/services/companionsApi';

const api = vi.hoisted(() => ({
  actOnCompanionDevice: vi.fn(async () => ({})),
  getCompanionDevice: vi.fn(async () => ({
    device: {},
    readiness: { ready: true, detail: 'loam-ready' },
    journal: [{ at: '2026-11-10T00:00:00.000Z', kind: 'user', event: 'device started', ok: true }],
  })),
  getCompanionDeviceStats: vi.fn(async () => ({
    stats: { cpuUtilization: 25, memoryTotalMB: 8192, memoryFreeMB: 4096, disk: '/dev/sdc 100G 12G 88G 12% /', raw: '' },
    costNote: 'local',
  })),
  snapshotCompanionDevice: vi.fn(async () => ({})),
  setCompanionControl: vi.fn(async () => ({})),
  listCompanionTasks: vi.fn(async () => [{ id: 'task-1', title: 'Existing task', status: 'done' }]),
  startCompanionTask: vi.fn(async () => ({ id: 'task-new', title: 'Build report', status: 'running' })),
  ensureCompanionGui: vi.fn(async () => ({ ok: true, started: true, detail: 'ready' })),
  captureCompanionScreen: vi.fn(async () => new Blob(['frame'], { type: 'image/jpeg' })),
  sendCompanionInput: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/services/companionsApi', () => api);

import { ComputerDetailsDialog } from '../ComputerDetailsDialog';
import { ComputerTasksDialog } from '../ComputerTasksDialog';
import { CompanionDeviceViewer } from '../CompanionDeviceViewer';

const device: CompanionDevice = {
  id: 'device-1',
  agentId: 'agent-1',
  name: 'cloud-pc-1',
  environment: 'linux',
  provider: 'wsl',
  template: 'coding',
  state: 'running',
};

beforeEach(() => {
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:frame'),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  setLocale('en');
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('companion computer workflows', () => {
  it('loads device settings and runs lifecycle, snapshot and control actions', async () => {
    setLocale('en');
    const onAction = vi.fn();
    const onDelete = vi.fn();
    render(<ComputerDetailsDialog device={device} open onClose={vi.fn()} onAction={onAction} onDelete={onDelete} busy={false} />);

    expect(await screen.findByText('device started')).toBeTruthy();
    expect(screen.getByText('CPU: 25.0%')).toBeTruthy();
    expect(screen.getByText(/4096 MB Free/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Snapshot' }));
    await waitFor(() => expect(api.snapshotCompanionDevice).toHaveBeenCalledWith('device-1', expect.stringContaining('Manual')));
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
    await waitFor(() => expect(api.setCompanionControl).toHaveBeenCalledWith('device-1', true));
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    expect(onAction).toHaveBeenCalledWith('device-1', 'suspend');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    expect(onDelete).toHaveBeenCalledWith('device-1');
  });

  it('keeps device details available when stats fail', async () => {
    setLocale('en');
    api.getCompanionDeviceStats.mockRejectedValueOnce(new Error('stats exec failed'));
    render(<ComputerDetailsDialog device={device} open onClose={vi.fn()} onAction={vi.fn()} onDelete={vi.fn()} busy={false} />);

    expect(await screen.findByText('device started')).toBeTruthy();
    expect(screen.getByText('stats exec failed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Suspend' })).toBeTruthy();
  });

  it('lists and starts tasks on the companion agent', async () => {
    setLocale('en');
    const onOpenTask = vi.fn();
    render(<ComputerTasksDialog device={device} open onClose={vi.fn()} onOpenTask={onOpenTask} />);

    expect(await screen.findByText('Existing task')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Assign a task or ask anything'), { target: { value: 'Build report' } });
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    await waitFor(() => expect(api.startCompanionTask).toHaveBeenCalledWith('agent-1', 'Build report'));
    expect(onOpenTask).toHaveBeenCalledWith('task-new');
  });

  it('starts the live viewer and forwards click and text input', async () => {
    setLocale('en');
    render(<CompanionDeviceViewer device={device} open onClose={vi.fn()} />);

    const image = await screen.findByRole('img', { name: 'cloud-pc-1 Live screen' });
    expect(api.ensureCompanionGui).toHaveBeenCalledWith('device-1');
    Object.defineProperty(image, 'naturalWidth', { value: 1600 });
    Object.defineProperty(image, 'naturalHeight', { value: 900 });
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450, x: 0, y: 0,
      toJSON: () => ({}),
    });
    fireEvent.click(image, { clientX: 400, clientY: 225 });
    await waitFor(() => expect(api.sendCompanionInput).toHaveBeenCalledWith('device-1', { type: 'click', x: 800, y: 450 }));

    fireEvent.change(screen.getByPlaceholderText('Type on the remote computer'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendCompanionInput).toHaveBeenCalledWith('device-1', { type: 'type', text: 'hello' }));
  });
});
