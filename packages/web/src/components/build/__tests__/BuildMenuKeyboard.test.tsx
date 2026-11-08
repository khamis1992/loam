import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { setLocale } from '@/i18n/t';
import { BuildKindDialog } from '../BuildKindDialog';

afterEach(() => setLocale('en'));

const FOCUSABLE = 'button, a[href], input, select, textarea';

function focusableIn(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => !node.hasAttribute('disabled'));
}

function pressTab(from: HTMLElement): HTMLElement {
  from.focus();
  const proceeded = fireEvent.keyDown(from, { key: 'Tab' });
  if (document.activeElement !== from && document.activeElement instanceof HTMLElement) {
    return document.activeElement;
  }
  if (!proceeded) return from;
  const order = focusableIn(document);
  const next = order[order.indexOf(from) + 1];
  if (next) {
    next.focus();
    return next;
  }
  from.blur();
  return document.activeElement instanceof HTMLElement ? document.activeElement : from;
}

function tabThroughDialog(dialog: HTMLElement): void {
  const controls = focusableIn(dialog);
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!first || !last) throw new Error('missing control');
  const seen: HTMLElement[] = [];
  let current = first;
  for (let step = 0; step < controls.length; step += 1) {
    expect(dialog.contains(current)).toBe(true);
    seen.push(current);
    current = pressTab(current);
  }
  expect(new Set(seen).size).toBe(controls.length);
  expect(current).not.toBe(last);
  expect(dialog.contains(current)).toBe(true);
  expect(current).toBe(first);
}

test('tab from the first control wraps inside the dialog and the website view', () => {
  setLocale('en');
  const outside = document.createElement('button');
  outside.type = 'button';
  outside.textContent = 'Outside';
  document.body.appendChild(outside);
  try {
    render(<BuildKindDialog onSelect={vi.fn()} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent ?? '').not.toMatch(/Sparkles|★/);
    const kindChoices = screen.queryAllByRole('button', { name: /^Choose / });
    if (kindChoices.length > 0) {
      expect(kindChoices).toHaveLength(9);
    }
    expect(screen.queryByRole('button', { name: 'Choose chatbot' })).toBeNull();
    expect(screen.queryByTestId('website-template-chatbot')).toBeNull();
    tabThroughDialog(dialog);

    fireEvent.click(screen.getByRole('button', { name: 'Choose websites' }));
    expect(dialog.textContent ?? '').not.toMatch(/Sparkles|★/);
    const websiteKindChoices = screen.queryAllByRole('button', { name: /^Choose / });
    if (websiteKindChoices.length > 0) {
      expect(websiteKindChoices).toHaveLength(9);
    }
    expect(screen.queryByRole('button', { name: 'Choose chatbot' })).toBeNull();
    expect(screen.queryByTestId('website-template-chatbot')).toBeNull();
    tabThroughDialog(dialog);
  } finally {
    outside.remove();
  }
});
