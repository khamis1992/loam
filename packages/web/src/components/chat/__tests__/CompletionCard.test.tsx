// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { t } from '@/i18n/t';

import { CompletionCard } from '../CompletionCard';

describe('CompletionCard (H5 + L3)', () => {
  it('shows the completion line and three follow-up chips', () => {
    render(<CompletionCard onFill={() => {}} onDismiss={() => {}} />);
    expect(screen.getByTestId('completion-card')).toHaveTextContent(t('Task completed'));
    expect(screen.getAllByTestId('follow-up-chip')).toHaveLength(3);
  });

  it('fills the composer with the chip text and never auto-sends', () => {
    const onFill = vi.fn();
    render(<CompletionCard onFill={onFill} onDismiss={() => {}} />);
    const chips = screen.getAllByTestId('follow-up-chip');
    fireEvent.click(chips[1]!);
    expect(onFill).toHaveBeenCalledTimes(1);
    expect(typeof onFill.mock.calls[0]![0]).toBe('string');
    expect((onFill.mock.calls[0]![0] as string).length).toBeGreaterThan(10);
  });

  it('dismisses the card', () => {
    const onDismiss = vi.fn();
    render(<CompletionCard onFill={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: t('Dismiss') }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
