import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { setLocale } from '@/i18n/t';
import { BuildKindDialog, websiteSubtypeForPrompt } from '../BuildKindDialog';

afterEach(() => setLocale('en'));

test('websites opens the current gallery; a tile selects its kind', () => {
  setLocale('ar');
  const pick = vi.fn();
  render(<BuildKindDialog onSelect={pick} onClose={vi.fn()} />);
  const dialog = screen.getByRole('dialog');
  expect(dialog.getAttribute('dir')).toBe('rtl');
  expect(dialog.getAttribute('lang')).toBe('ar');
  expect(dialog.className).toContain('focus-visible:outline');
  expect(dialog.className).not.toMatch(/#[0-9a-f]{3,8}/i);
  expect(dialog.textContent ?? '').not.toMatch(/Sparkles|★/);
  expect(screen.getAllByRole('button', { name: /^اختر / })).toHaveLength(9);
  fireEvent.click(screen.getByRole('button', { name: 'اختر تطبيق سطح المكتب' }));
  expect(pick).toHaveBeenCalledWith({ kind: 'desktop' });
  pick.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'اختر المواقع' }));
  expect(pick).not.toHaveBeenCalled();
  expect(screen.getByTestId('website-category-All')).toBeTruthy();
  expect(screen.getByTestId('website-template-merch-store')).toBeTruthy();
  expect(screen.getByTestId('website-template-online-booking')).toBeTruthy();
  expect(screen.getByTestId('website-template-christmas-sale')).toBeTruthy();
  expect(screen.queryByTestId('website-template-sales-crm')).toBeNull();
  expect(screen.getByRole('button', { name: 'روبوت دردشة' })).toBeTruthy();
});

test('tab stays inside the dialog and websites keep focus there', () => {
  setLocale('en');
  const closeDialog = vi.fn();
  render(<BuildKindDialog onSelect={vi.fn()} onClose={closeDialog} />);
  const dialog = screen.getByRole('dialog');
  const close = screen.getByRole('button', { name: 'Close' });
  expect(document.activeElement).toBe(close);
  const last = screen.getAllByRole('button').at(-1);
  if (!last) throw new Error('missing button');
  last.focus();
  fireEvent.keyDown(dialog, { key: 'Tab' });
  expect(document.activeElement).toBe(close);
  close.focus();
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(closeDialog).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Choose websites' }));
  expect(dialog.contains(document.activeElement)).toBe(true);
});

test('english labels stay on the same nine choices', () => {
  setLocale('en');
  render(<BuildKindDialog onSelect={vi.fn()} onClose={vi.fn()} />);
  const dialog = screen.getByRole('dialog');
  expect(dialog.getAttribute('dir')).toBe('ltr');
  expect(dialog.getAttribute('lang')).toBe('en');
  expect(screen.getByRole('button', { name: 'Choose websites' })).toBeTruthy();
  expect(screen.getAllByRole('button', { name: /^Choose / })).toHaveLength(9);
});

test('store and booking prompts keep their subtype', () => {
  expect(websiteSubtypeForPrompt('Create a merchandise store with a cart and checkout.')).toBe('store');
  expect(websiteSubtypeForPrompt('Create an online booking website with appointment scheduling.')).toBe('booking');
  expect(websiteSubtypeForPrompt('A solar company landing page.')).toBe('landing');
  expect(websiteSubtypeForPrompt('Create a Christmas sale landing page for a fashion store with a bold offer.')).toBe('landing');
  expect(websiteSubtypeForPrompt('ابنِ متجر عبايات')).toBe('store');
  expect(websiteSubtypeForPrompt('Build a local chatbot that answers inside the page')).toBe('chatbot');
});
