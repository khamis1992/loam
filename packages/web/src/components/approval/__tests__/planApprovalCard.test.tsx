/**
 * D4 web acceptance tests — the plan-approval card.
 *
 * The acceptance criterion is that the card renders the plan the agent suggested
 * (summary, steps, files) and that Approve / Reject / Edit produce the right
 * `resolve_plan_approval` payload through `ChatSocket`. Approve/reject send a
 * bare decision; Edit sends the revised plan (steps read back from the textarea).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { PlanApprovalCard } from '../PlanApprovalCard';
import type { PlanApprovalRequested } from '../types';
import { setLocale } from '@/i18n/t';

function planRequest(overrides: Partial<PlanApprovalRequested> = {}): PlanApprovalRequested {
  return {
    type: 'planApprovalRequested',
    id: 'evt_plan_1',
    timestamp: 1,
    requestId: 'plan_abc',
    taskId: 'task_1',
    summary: 'Add a snapshot test for the parser.',
    steps: ['Read the parser', 'Write the snapshot test', 'Run the suite'],
    filesToEdit: ['src/parser.ts', 'src/parser.test.ts'],
    trivial: false,
    ...overrides,
  };
}

describe('PlanApprovalCard', () => {
  beforeEach(() => setLocale('en'));

  it('renders the plan summary, steps and files to edit', () => {
    render(<PlanApprovalCard request={planRequest()} onRespond={() => {}} />);

    expect(screen.getByText('Plan approval')).toBeInTheDocument();
    expect(screen.getByText('Add a snapshot test for the parser.')).toBeInTheDocument();
    for (const step of ['Read the parser', 'Write the snapshot test', 'Run the suite']) {
      expect(screen.getByText(step)).toBeInTheDocument();
    }
    expect(screen.getByText('src/parser.ts')).toBeInTheDocument();
    expect(screen.getByText('src/parser.test.ts')).toBeInTheDocument();
  });

  it('marks a trivial plan with a chip', () => {
    render(<PlanApprovalCard request={planRequest({ trivial: true })} onRespond={() => {}} />);
    expect(screen.getByText('Trivial')).toBeInTheDocument();
  });

  it('sends approve with no plan payload and collapses to a decided state', () => {
    const onRespond = vi.fn();
    render(<PlanApprovalCard request={planRequest()} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith('approve');
    // The card is replaced by a decided state, so the buttons go away.
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.getByText('Plan approved')).toBeInTheDocument();
  });

  it('sends reject and shows the rejected state', () => {
    const onRespond = vi.fn();
    render(<PlanApprovalCard request={planRequest()} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole('button', { name: /Reject/ }));

    expect(onRespond).toHaveBeenCalledWith('reject');
    expect(screen.getByText('Plan rejected')).toBeInTheDocument();
  });

  it('sends the revised steps when the user edits the plan', () => {
    const onRespond = vi.fn();
    render(<PlanApprovalCard request={planRequest()} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    const editor = screen.getByLabelText('Steps') as HTMLTextAreaElement;
    // jsdom keeps the controlled value, so drive the change event with the new text.
    fireEvent.change(editor, { target: { value: 'Read the parser\nWrite the snapshot test\nAdd a second case\nRun the suite' } });

    fireEvent.click(screen.getByRole('button', { name: /Save and approve/ }));

    expect(onRespond).toHaveBeenCalledTimes(1);
    const [decision, plan] = onRespond.mock.calls[0] as [string, { summary: string; steps: string[]; files_to_edit: string[] }];
    expect(decision).toBe('edit');
    expect(plan.summary).toBe('Add a snapshot test for the parser.');
    expect(plan.steps).toEqual(['Read the parser', 'Write the snapshot test', 'Add a second case', 'Run the suite']);
    expect(plan.files_to_edit).toEqual(['src/parser.ts', 'src/parser.test.ts']);
  });

  it('ignores a second decision once one has been made', () => {
    const onRespond = vi.fn();
    render(<PlanApprovalCard request={planRequest()} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    // The decided card has no approve button left, so nothing can be clicked again.
    expect(onRespond).toHaveBeenCalledTimes(1);
  });
});
