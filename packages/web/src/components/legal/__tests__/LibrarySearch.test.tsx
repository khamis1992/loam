import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LibraryBanner, LibraryResults, LibraryStatusChip } from '../LibrarySearch';
import type { LibraryHit } from '@/services/legalApi';

const hit = (status: LibraryHit['status']): LibraryHit => ({ kind: 'legislation', folder: 'laws', title: 'قانون العمل', ref: '14/2004', article: `مادة ${status}`, status, statusAr: '', rawState: '', snippet: 'نص', url: 'https://almeezan.qa/x', file: 'laws/a.md', verified: false, warning: '' });

describe('LibrarySearch', () => {
  it('banner warns that tags are inferred and must be verified', () => {
    render(<LibraryBanner />);
    expect(screen.getByTestId('library-banner').textContent).toContain('تحقّق قبل الاستشهاد');
  });
  it('renders a chip for every status incl. added and unknown', () => {
    for (const s of ['in_force', 'amended', 'added', 'superseded', 'repealed', 'unknown'] as const) render(<LibraryStatusChip status={s} />);
    expect(screen.getByText('نافذ — مضافة')).toBeInTheDocument();
    expect(screen.getByText('حالة غير معروفة')).toBeInTheDocument();
  });
  it('marks every result unverified', () => {
    render(<LibraryResults hits={[hit('in_force'), hit('repealed')]} />);
    expect(screen.getAllByText('غير مُتحقَّق')).toHaveLength(2);
  });
});
