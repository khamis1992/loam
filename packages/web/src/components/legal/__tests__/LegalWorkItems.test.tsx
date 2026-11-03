import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setLocale } from '@/i18n/t';
import type { MatterWorkItem } from '@/services/legalApi';
import { LegalWorkItems } from '../LegalWorkItems';

const item: MatterWorkItem = {
  id: 'work-1', matterId: 'matter-1', kind: 'filing', title: 'Prepare filing', status: 'pending', dueAt: '2092-01-11', assignee: 'Reviewer', notes: null,
  createdAt: '2092-01-10T08:00:00Z', updatedAt: '2092-01-10T08:00:00Z', completedAt: null,
};
const api = vi.hoisted(() => ({ list: vi.fn(), report: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock('@/services/legalApi', () => ({
  legalApi: {
    listWorkItems: api.list,
    getMatterReport: api.report,
    addWorkItem: api.add,
    updateWorkItem: api.update,
    deleteWorkItem: api.remove,
  },
}));

describe('LegalWorkItems', () => {
  beforeEach(() => {
    setLocale('en');
    vi.clearAllMocks();
    api.list.mockResolvedValue({ items: [item] });
    api.report.mockResolvedValue({ report: { total: 1, pending: 1, inProgress: 0, done: 0, cancelled: 0, overdue: 1, nextDueAt: '2092-01-11' } });
    api.add.mockResolvedValue({ item });
    api.update.mockResolvedValue({ item: { ...item, status: 'done' } });
    api.remove.mockResolvedValue({ deleted: true });
  });

  it('creates a dated work item and refreshes the office report', async () => {
    render(<LegalWorkItems matterId="matter-1" />);
    expect(await screen.findByText('Prepare filing')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Overdue');
    fireEvent.change(screen.getByLabelText('Work item title'), { target: { value: 'New hearing' } });
    fireEvent.change(screen.getByLabelText('Work item type'), { target: { value: 'hearing' } });
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2092-01-20' } });
    fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: 'Counsel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add work item' }));
    await waitFor(() => expect(api.add).toHaveBeenCalledWith('matter-1', { title: 'New hearing', kind: 'hearing', status: 'pending', dueAt: '2092-01-20', assignee: 'Counsel', notes: null }));
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.report).toHaveBeenCalledTimes(2);
  });

  it('updates status and deletes only through the active matter', async () => {
    render(<LegalWorkItems matterId="matter-1" />);
    fireEvent.change(await screen.findByLabelText('Status: Prepare filing'), { target: { value: 'done' } });
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('matter-1', 'work-1', { status: 'done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete work item' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('matter-1', 'work-1'));
  });
});
