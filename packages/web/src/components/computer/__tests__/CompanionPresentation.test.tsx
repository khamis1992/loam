import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setLocale } from '@/i18n/t';

const api = vi.hoisted(() => ({
  captureCompanionScreen: vi.fn(async () => new Blob(['frame'], { type: 'image/jpeg' })),
  getCompanionDeviceStats: vi.fn(async () => ({
    stats: {
      cpuUtilization: 12.5,
      memoryTotalMB: 8192,
      memoryFreeMB: 4096,
      diskUsedGB: 12,
      diskTotalGB: 100,
      diskUsedPercent: 12,
      raw: '',
    },
    costNote: 'local',
  })),
  getApiBase: vi.fn(() => 'http://127.0.0.1:3939'),
  getSessionToken: vi.fn(async () => 'test-token'),
  openExternal: vi.fn(async () => undefined),
}));

vi.mock('@/services/companionsApi', () => ({
  captureCompanionScreen: api.captureCompanionScreen,
  getCompanionDeviceStats: api.getCompanionDeviceStats,
}));
vi.mock('@/services/rpc', () => ({
  getApiBase: api.getApiBase,
  getSessionToken: api.getSessionToken,
}));
vi.mock('@/services/desktopApis', () => ({
  desktopApis: { system: { openExternal: api.openExternal } },
}));

import { CompanionCardPreview } from '../CompanionCardPreview';
import { ComputerMetrics } from '../ComputerMetrics';
import { PhoneControlDialog } from '../PhoneControlDialog';

beforeEach(() => {
  Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:frame'),
    revokeObjectURL: vi.fn(),
  });
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
});

afterEach(() => {
  cleanup();
  setLocale('en');
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
});

describe('computer presentation and phone access', () => {
  it('shows a live card preview only while the device is running', async () => {
    const { rerender } = render(<CompanionCardPreview deviceId="device-1" state="running" />);
    await waitFor(() => expect(document.querySelector('img')).not.toBeNull());
    expect(api.captureCompanionScreen).toHaveBeenCalledWith('device-1');

    rerender(<CompanionCardPreview deviceId="device-1" state="stopped" />);
    expect(document.querySelector('img')).toBeNull();
  });

  it('renders CPU, memory and storage metrics', async () => {
    render(<ComputerMetrics deviceId="device-1" />);
    expect(await screen.findByText('12.5%')).toBeTruthy();
    expect(screen.getByText(/4.0 GB \/ 8.0 GB · 50%/)).toBeTruthy();
    expect(screen.getByText(/12 \/ 100 GB · 12%/)).toBeTruthy();
  });

  it('creates a usable phone remote link without exposing the token in the dialog', async () => {
    render(<PhoneControlDialog open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Loam address'), { target: { value: '192.168.1.20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy remote link' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const url = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0] as string;
    expect(url).toContain('192.168.1.20:3939/remote?t=test-token');
    expect(screen.queryByText('test-token')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open remote page' }));
    await waitFor(() => expect(api.openExternal).toHaveBeenCalledWith(url));
  });
});
