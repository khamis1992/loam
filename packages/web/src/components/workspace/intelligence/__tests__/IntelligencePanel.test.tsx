import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import IntelligencePanel from '../IntelligencePanel';
import { applyOfficeRun, startOfficeRun } from '../officeIntelligenceApi';
import type { OfficeRun } from '../officeIntelligenceApi';
import type { WorkspaceFile } from '../../types';

vi.mock('../officeIntelligenceApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../officeIntelligenceApi')>();
  return { ...actual, startOfficeRun: vi.fn(), applyOfficeRun: vi.fn(), cancelOfficeRun: vi.fn(), getOfficeRun: vi.fn() };
});

const file: WorkspaceFile = { taskId: 'task_1', path: 'case.docx', name: 'case.docx', kind: 'doc' };
const artifact = { taskId: 'task_1', path: 'case.docx', kind: 'document' as const, revision: 0, contentHash: 'a'.repeat(64), tenantId: 'local' };
const completedRun: OfficeRun = {
  id: 'run_1', capability: 'doc-summary', artifact, instruction: '', status: 'succeeded', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  result: {
    summary: 'ملخص موثق للقضية', citations: [{ id: 'src_1', artifact, kind: 'block', anchor: '1', excerpt: 'دليل من المستند', contentHash: 'b'.repeat(64) }],
    warnings: ['تحتاج المراجعة القانونية'], data: { claims: 1 }, changeSet: { id: 'chg_1', expectedRevision: 0, preview: ['تحديث الفقرة 1'], destructive: false },
  },
};

describe('IntelligencePanel', () => {
  beforeEach(() => {
    vi.mocked(startOfficeRun).mockResolvedValue(completedRun);
    vi.mocked(applyOfficeRun).mockResolvedValue(undefined);
  });

  it('shows sources and previews then applies only after approval', async () => {
    const onApplied = vi.fn();
    render(<IntelligencePanel file={file} onApplied={onApplied} />);
    fireEvent.click(screen.getByRole('button', { name: /المساعد الذكي والقانوني/ }));
    fireEvent.click(screen.getByRole('button', { name: 'تشغيل' }));
    expect(await screen.findByText('ملخص موثق للقضية')).toBeInTheDocument();
    expect(screen.getByText('دليل من المستند')).toBeInTheDocument();
    expect(screen.getByText('تحديث الفقرة 1')).toBeInTheDocument();
    expect(applyOfficeRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'اعتماد وتطبيق' }));
    await waitFor(() => expect(applyOfficeRun).toHaveBeenCalledWith('run_1'));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it('blocks application while the editor has unsaved changes', async () => {
    render(<IntelligencePanel file={file} applyDisabled />);
    fireEvent.click(screen.getByRole('button', { name: /المساعد الذكي والقانوني/ }));
    fireEvent.click(screen.getByRole('button', { name: 'تشغيل' }));
    const button = await screen.findByRole('button', { name: 'اعتماد وتطبيق' });
    expect(button).toBeDisabled();
  });
});
