// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LegalOperations } from '../LegalOperations';
import { t } from '@/i18n/t';

vi.mock('@/services/rpc', () => ({ getApiBase: () => 'http://127.0.0.1:3939', getApiHeaders: async () => ({ 'x-test': '1' }), getLoamBase: () => 'http://127.0.0.1:3939' }));

describe('LegalOperations', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it('creates an encrypted backup and refreshes the recovery inventory', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
      calls.push({ url, method, body });
      const result = method === 'POST' ? { fileName: 'legal-test.loam-legal', files: 2 } : { files: ['legal-test.loam-legal'] };
      return new Response(JSON.stringify(result), { status: method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } });
    }));
    render(<LegalOperations status={null} />);
    await waitFor(() => expect(screen.getByLabelText(t('Backup to restore'))).toBeTruthy());
    fireEvent.change(screen.getByLabelText(t('Backup recovery passphrase')), { target: { value: 'correct horse battery' } });
    fireEvent.click(screen.getByRole('button', { name: t('Create encrypted backup') }));
    await waitFor(() => expect(screen.getByText(t('Encrypted backup created: {name}', { name: 'legal-test.loam-legal' }))).toBeTruthy());
    expect(calls.some((call) => call.url.endsWith('/operations/backup') && call.method === 'POST' && (call.body as { passphrase: string }).passphrase === 'correct horse battery')).toBe(true);
  });
});
