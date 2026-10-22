import { describe, it, expect } from 'vitest';
import { mapUpdaterStatus } from '../UpdaterSettings';

describe('mapUpdaterStatus', () => {
  it('maps an idle "current" status as up to date', () => {
    const mapped = mapUpdaterStatus({ state: 'current' });
    expect(mapped.state).toEqual({ state: 'idle' });
    expect(mapped.upToDate).toBe(true);
    expect(mapped.disabled).toBe(false);
  });

  it('maps checking and available with a version', () => {
    expect(mapUpdaterStatus({ state: 'checking' })).toMatchObject({ state: { state: 'checking' }, upToDate: false });
    expect(mapUpdaterStatus({ state: 'available', version: '1.2.3' })).toMatchObject({
      state: { state: 'available', version: '1.2.3' },
      upToDate: false,
    });
  });

  it('clamps download progress to 0..100 and rounds it', () => {
    expect(mapUpdaterStatus({ state: 'downloading', percent: 42.6 }).state).toEqual({
      state: 'downloading',
      progress: 43,
    });
    expect(mapUpdaterStatus({ state: 'downloading', percent: 500 }).state).toEqual({
      state: 'downloading',
      progress: 100,
    });
    expect(mapUpdaterStatus({ state: 'downloading', percent: -5 }).state).toEqual({
      state: 'downloading',
      progress: 0,
    });
  });

  it('maps installing to restarting and error to an error message', () => {
    expect(mapUpdaterStatus({ state: 'installing' }).state).toEqual({ state: 'restarting' });
    expect(mapUpdaterStatus({ state: 'error', reason: 'boom' }).state).toEqual({
      state: 'error',
      message: 'boom',
    });
  });

  it('marks a disabled updater without claiming it is up to date', () => {
    const mapped = mapUpdaterStatus({ state: 'disabled' });
    expect(mapped.state).toEqual({ state: 'idle' });
    expect(mapped.disabled).toBe(true);
    expect(mapped.upToDate).toBe(false);
  });

  it('passes through the current version and defaults unknown states to idle', () => {
    expect(mapUpdaterStatus({ state: 'available', version: '2.0.0', currentVersion: '1.0.0' })).toMatchObject({
      state: { state: 'available', version: '2.0.0' },
      currentVersion: '1.0.0',
    });
    expect(mapUpdaterStatus(undefined)).toMatchObject({ state: { state: 'idle' }, upToDate: false, disabled: false });
    expect(mapUpdaterStatus({ state: 'mystery' })).toMatchObject({ state: { state: 'idle' } });
  });
});
