/**
 * N9 web acceptance tests — the ask-user card.
 *
 * The acceptance criterion is that the card renders the clarification the agent
 * needs (headline, why it is asking, the questions and their preset options) and
 * that Send / Dismiss produce the right payload for `resolve_ask_user`. A card
 * raised by the auto-trigger localizes its own headline and reason, so an Arabic
 * user reads Arabic and an English user reads English; a card the model raised is
 * shown verbatim because the model already wrote it in the user's language.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { AskUserCard } from '../AskUserCard';
import type { AskUserRequested } from '../types';
import { setLocale } from '@/i18n/t';

function askRequest(overrides: Partial<AskUserRequested> = {}): AskUserRequested {
  return {
    type: 'askUserRequested',
    id: 'evt_ask_1',
    timestamp: 1,
    requestId: 'ask_abc',
    taskId: 'task_1',
    title: 'Which module should I refactor?',
    reason: 'The request does not name a file.',
    questions: [
      { id: 'q1', prompt: 'Which module?', options: ['Parser', 'Store', 'CLI'] },
      { id: 'q2', prompt: 'What is the goal?', allowFile: true },
    ],
    ...overrides,
  };
}

describe('AskUserCard', () => {
  beforeEach(() => setLocale('en'));

  it('renders the reason, every question and its preset options', () => {
    render(<AskUserCard request={askRequest()} onRespond={() => {}} />);

    expect(screen.getByText('Which module should I refactor?')).toBeInTheDocument();
    expect(screen.getByText('The request does not name a file.')).toBeInTheDocument();
    expect(screen.getByText('Which module?')).toBeInTheDocument();
    for (const option of ['Parser', 'Store', 'CLI']) {
      expect(screen.getByText(option)).toBeInTheDocument();
    }
  });

  it('sends the picked option and the note when answered', () => {
    const onRespond = vi.fn();
    render(<AskUserCard request={askRequest()} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole('button', { name: 'Store' }));
    fireEvent.change(screen.getByLabelText('Anything else I should know?'), { target: { value: 'Keep the public API stable' } });
    fireEvent.click(screen.getByRole('button', { name: /Send answer/ }));

    expect(onRespond).toHaveBeenCalledTimes(1);
    const [decision, answer] = onRespond.mock.calls[0] as [
      string,
      { text: string; answers: Record<string, string>; files: unknown[] },
    ];
    expect(decision).toBe('answer');
    expect(answer.answers).toEqual({ q1: 'Store' });
    expect(answer.text).toBe('Keep the public API stable');
    expect(answer.files).toEqual([]);
    // The card collapses to a decided state, so the buttons go away.
    expect(screen.queryByRole('button', { name: /Send answer/ })).toBeNull();
    expect(screen.getByText('Answer sent')).toBeInTheDocument();
  });

  it('rejects an empty answer and keeps the card open', () => {
    const onRespond = vi.fn();
    render(<AskUserCard request={askRequest()} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole('button', { name: /Send answer/ }));

    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByText('Answer at least one question or add a file.')).toBeInTheDocument();
  });

  it('dismisses without an answer', () => {
    const onRespond = vi.fn();
    render(<AskUserCard request={askRequest()} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));

    expect(onRespond).toHaveBeenCalledWith('dismiss');
    expect(screen.getByText('Clarification dismissed')).toBeInTheDocument();
  });

  it('attaches an uploaded file to the answer', async () => {
    const uploadFile = vi.fn(async () => ({
      path: 'uploads/ask_abc/design.md',
      name: 'design.md',
      bytes: 2048,
      contentType: 'text/markdown',
    }));
    const onRespond = vi.fn();
    render(<AskUserCard request={askRequest()} onRespond={onRespond} uploadFile={uploadFile} />);

    const picker = screen.getByLabelText('Add a file');
    fireEvent.change(picker, {
      target: { files: [new File(['# spec'], 'design.md', { type: 'text/markdown' })] },
    });
    // Wait on the rendered list, not on the mock: the upload promise resolves
    // outside the event, so the file row appears a tick after the call is seen.
    await vi.waitFor(() => expect(screen.getByText('design.md')).toBeInTheDocument());
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(screen.getByText('2 KB')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Anything else I should know?'), { target: { value: 'see the file' } });
    fireEvent.click(screen.getByRole('button', { name: /Send answer/ }));

    const [, answer] = onRespond.mock.calls[0] as [string, { files: { path: string; name: string }[] }];
    expect(answer.files).toEqual([
      { path: 'uploads/ask_abc/design.md', name: 'design.md', bytes: 2048, contentType: 'text/markdown' },
    ]);
  });

  it('localizes the auto-trigger headline and reason in Arabic', () => {
    setLocale('ar');
    render(
      <AskUserCard
        request={askRequest({ source: 'auto', reasonCode: 'missing_context', title: 'Before I start, I need one clarification', reason: 'fallback' })}
        onRespond={() => {}}
      />,
    );

    expect(screen.getByText('قبل أن أبدأ، أحتاج توضيحًا واحدًا')).toBeInTheDocument();
    expect(screen.getByText('يشير هذا الطلب إلى شيء لم تحدده أي مهمة أو ملف سابق في هذه المحادثة.')).toBeInTheDocument();
    // The English server-side fallback is never shown to an Arabic user.
    expect(screen.queryByText('fallback')).toBeNull();
  });

  it('shows a model-raised request verbatim instead of localizing it', () => {
    render(
      <AskUserCard
        request={askRequest({ source: 'model', title: 'أي وحدة أعد هيكلتها؟', reason: 'الطلب لا يذكر ملفًا.' })}
        onRespond={() => {}}
      />,
    );

    expect(screen.getByText('أي وحدة أعد هيكلتها؟')).toBeInTheDocument();
    expect(screen.getByText('الطلب لا يذكر ملفًا.')).toBeInTheDocument();
  });
});
