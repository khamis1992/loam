import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LegalVersionCompare } from '../LegalVersionCompare';
import { setLocale } from '@/i18n/t';
import type { LegalArticleResponse } from '@/services/legalApi';

const data: LegalArticleResponse = {
  resolved: { legislation: { titleAr: 'قانون اختباري' }, article: { label: '3' }, version: { avid: 'new' } },
  versions: [
    { avid: 'old', articleKey: 'law/1:body:3', text: 'النص القديم', effectiveFrom: '2020-01-01', effectiveTo: '2024-01-01', origin: 'original' },
    { avid: 'new', articleKey: 'law/1:body:3', text: 'النص الجديد', effectiveFrom: '2024-01-01', effectiveTo: null, origin: 'amendment', introducedBy: 'law/2024/1' },
  ],
};

describe('LegalVersionCompare', () => {
  beforeEach(() => setLocale('en'));

  it('shows both versions and allows selecting another comparison', () => {
    render(<LegalVersionCompare data={data} />);
    expect(screen.getByText('النص القديم')).toBeInTheDocument();
    expect(screen.getByText('النص الجديد')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('From version'), { target: { value: 'new' } });
    expect(screen.getAllByText('النص الجديد')).toHaveLength(2);
  });
});
