import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LegalMatterPanel from '../LegalMatterPanel';
import { attachCurrentArtifact, createMatter, getMatterConflicts, getMatterDashboard, listMatters, searchMatterArchive, searchOfficialSources, type Matter } from '../officeLegalApi';
import type { WorkspaceFile } from '../../types';

vi.mock('../officeLegalApi', () => ({
  listMatters: vi.fn(), createMatter: vi.fn(), getMatterDashboard: vi.fn(), getMatterConflicts: vi.fn(),
  attachCurrentArtifact: vi.fn(), searchMatterArchive: vi.fn(), searchOfficialSources: vi.fn(),
}));

const file: WorkspaceFile = { taskId: 'task_1', path: 'case.docx', name: 'case.docx', kind: 'doc' };
const matter: Matter = { id: 'matter_1', tenantId: 'local', title: 'نزاع تجاري', client: 'شركة الاختبار', practiceArea: 'general', summary: '', status: 'active', parties: [], revision: 1 };

describe('LegalMatterPanel', () => {
  beforeEach(() => {
    vi.mocked(listMatters).mockResolvedValue([]);
    vi.mocked(createMatter).mockResolvedValue(matter);
    vi.mocked(getMatterDashboard).mockResolvedValue({ openTasks: 2, overdueDeadlines: [], upcomingDeadlines: [], artifacts: 1, events: 3 });
    vi.mocked(attachCurrentArtifact).mockResolvedValue({ ...matter, revision: 2 });
    vi.mocked(getMatterConflicts).mockResolvedValue([{ matterId: 'matter_2', client: 'عميل سابق', matchedParty: 'شركة الاختبار' }]);
    vi.mocked(searchOfficialSources).mockResolvedValue([{ id: 'source_1', title: 'مصدر رسمي', citation: 'المادة 1', issuer: 'جهة رسمية', sourceUrl: 'https://example.gov.qa', effectiveFrom: '2020-01-01', text: 'نص رسمي' }]);
    vi.mocked(searchMatterArchive).mockResolvedValue([]);
  });

  it('creates and opens a matter, attaches the document and checks conflicts', async () => {
    render(<LegalMatterPanel file={file} />);
    fireEvent.click(screen.getByRole('button', { name: /ملف القضية والمعرفة القانونية/ }));
    fireEvent.change(screen.getByLabelText('اسم القضية'), { target: { value: matter.title } });
    fireEvent.change(screen.getByLabelText('العميل'), { target: { value: matter.client } });
    fireEvent.click(screen.getByRole('button', { name: 'إنشاء قضية' }));
    await waitFor(() => expect(createMatter).toHaveBeenCalledWith(matter.title, matter.client));
    expect(await screen.findByText('مهام مفتوحة: 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /إرفاق المستند/ }));
    await waitFor(() => expect(attachCurrentArtifact).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /فحص التعارض/ }));
    expect(await screen.findByText(/عميل سابق/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('بحث قانوني'), { target: { value: 'المادة 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'بحث' }));
    expect(await screen.findByText(/مصدر رسمي — المادة 1/)).toBeInTheDocument();
  });
});
