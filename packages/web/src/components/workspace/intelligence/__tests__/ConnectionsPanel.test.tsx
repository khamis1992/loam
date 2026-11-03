import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConnectionsPanel from '../ConnectionsPanel';
import {
  createOfficeConnector,
  deleteOfficeConnector,
  listOfficeConnectors,
  syncOfficeConnectorToSheet,
  testOfficeConnector,
  type OfficeConnector,
} from '../officeConnectorsApi';
import type { WorkspaceFile } from '../../types';

vi.mock('../officeConnectorsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../officeConnectorsApi')>();
  return {
    ...actual,
    listOfficeConnectors: vi.fn(),
    createOfficeConnector: vi.fn(),
    testOfficeConnector: vi.fn(),
    syncOfficeConnectorToSheet: vi.fn(),
    deleteOfficeConnector: vi.fn(),
  };
});

const file: WorkspaceFile = { taskId: 'task_1', path: 'board.xlsx', name: 'board.xlsx', kind: 'sheet' };

const restConnector: OfficeConnector = {
  id: 'conn_1',
  scope: { tenantId: 'local' },
  name: 'لوحة المؤشرات',
  type: 'rest-json',
  config: { url: 'https://api.example.com/v1/metrics' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: /الاتصالات ومصادر البيانات/ }));
}

describe('ConnectionsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listOfficeConnectors).mockResolvedValue([restConnector]);
    vi.mocked(testOfficeConnector).mockResolvedValue({
      columns: ['اسم', 'قيمة'], rows: [['أ', 1], ['ب', 2]], rowCount: 2, truncated: false, syncedAt: '2026-01-01T00:00:00.000Z',
    });
    vi.mocked(syncOfficeConnectorToSheet).mockResolvedValue({
      taskId: 'task_1', path: 'data/connectors.xlsx', kind: 'spreadsheet', revision: 0, contentHash: 'a'.repeat(64), tenantId: 'local',
    });
    vi.mocked(deleteOfficeConnector).mockResolvedValue(undefined);
    vi.mocked(createOfficeConnector).mockResolvedValue(restConnector);
  });

  afterEach(() => {
    vi.spyOn(window, 'confirm').mockRestore();
  });

  it('lists connectors and reports the tested row count', async () => {
    render(<ConnectionsPanel file={file} />);
    openPanel();
    expect(await screen.findByText('لوحة المؤشرات')).toBeInTheDocument();
    // The type also appears as a create-form option, so both spots must show it.
    expect(screen.getAllByText('REST / JSON')).toHaveLength(2);
    expect(screen.getByText('https://api.example.com/v1/metrics')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'اختبار' }));
    expect(await screen.findByText('نجح الاختبار: 2 صفًا × 2 عمودًا', { exact: false })).toBeInTheDocument();
    expect(testOfficeConnector).toHaveBeenCalledWith('conn_1', 'task_1');
  });

  it('surfaces a visible Arabic error when the connector test fails', async () => {
    vi.mocked(testOfficeConnector).mockRejectedValue(new Error('connector returned HTTP 502'));
    render(<ConnectionsPanel file={file} />);
    openPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'اختبار' }));
    expect(await screen.findByText('فشل الاختبار: connector returned HTTP 502')).toBeInTheDocument();
  });

  it('syncs rows into the target xlsx sheet and reloads the editor', async () => {
    const onSynced = vi.fn();
    render(<ConnectionsPanel file={file} onSynced={onSynced} />);
    openPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'مزامنة الآن' }));
    expect(await screen.findByText('تمت المزامنة إلى:', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('data/connectors.xlsx')).toBeInTheDocument();
    expect(syncOfficeConnectorToSheet).toHaveBeenCalledWith('conn_1', 'task_1', 'data/connectors.xlsx');
    await waitFor(() => expect(onSynced).toHaveBeenCalled());
  });

  it('rejects a sync target that is not an .xlsx path', async () => {
    render(<ConnectionsPanel file={file} />);
    openPanel();
    fireEvent.change(await screen.findByLabelText('مسار ورقة المزامنة'), { target: { value: 'data/out.txt' } });
    fireEvent.click(screen.getByRole('button', { name: 'مزامنة الآن' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('أدخل مسار ورقة هدف صحيحًا ينتهي بـ .xlsx');
    expect(syncOfficeConnectorToSheet).not.toHaveBeenCalled();
  });

  it('deletes a connector only after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ConnectionsPanel file={file} />);
    openPanel();
    await screen.findByText('لوحة المؤشرات');
    fireEvent.click(screen.getByRole('button', { name: 'حذف' }));
    expect(deleteOfficeConnector).not.toHaveBeenCalled();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    // The row button is briefly disabled while the declined run unwinds; wait
    // for it to come back before clicking again.
    const deleteButton = await screen.findByRole('button', { name: 'حذف' });
    await waitFor(() => expect(deleteButton).toBeEnabled());
    fireEvent.click(deleteButton);
    await waitFor(() => expect(deleteOfficeConnector).toHaveBeenCalledWith('conn_1'));
    expect(await screen.findByText('لا توجد اتصالات مسجلة بعد.')).toBeInTheDocument();
  });

  it('creates a sqlite connector with the exact server payload fields', async () => {
    vi.mocked(createOfficeConnector).mockResolvedValue({
      ...restConnector, id: 'conn_2', name: 'قاعدة العملاء', type: 'sqlite', config: { databasePath: 'data/crm.sqlite', query: 'SELECT id, name FROM clients' },
    });
    render(<ConnectionsPanel file={file} />);
    openPanel();
    fireEvent.change(await screen.findByLabelText('اسم الاتصال'), { target: { value: 'قاعدة العملاء' } });
    fireEvent.change(screen.getByLabelText('نوع الاتصال'), { target: { value: 'sqlite' } });
    fireEvent.change(screen.getByLabelText('مسار قاعدة البيانات'), { target: { value: 'data/crm.sqlite' } });
    fireEvent.change(screen.getByLabelText('استعلام القراءة'), { target: { value: 'SELECT id, name FROM clients' } });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة اتصال' }));
    await screen.findByText('قاعدة العملاء');
    expect(createOfficeConnector).toHaveBeenCalledWith({
      name: 'قاعدة العملاء',
      type: 'sqlite',
      config: { databasePath: 'data/crm.sqlite', query: 'SELECT id, name FROM clients' },
    });
  });
});
