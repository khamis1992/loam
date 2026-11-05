import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BudgetApp } from '../BudgetApp';

beforeEach(() => {
  localStorage.clear();
});

describe('BudgetApp', () => {
  it('computes the initial summary from the template transactions', () => {
    render(<BudgetApp />);

    expect(screen.getByText('$2,616.07')).toBeTruthy();
    expect(screen.getByText('$5,250.00')).toBeTruthy();
    expect(screen.getAllByText('$2,633.93').length).toBe(2);
    expect(screen.getByText('$16.07')).toBeTruthy();
  });

  it('adds an expense, updates the balance, and persists it locally', async () => {
    render(<BudgetApp />);

    fireEvent.click(screen.getByRole('button', { name: 'Add transaction' }));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Groceries' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByText('$2,516.07')).toBeTruthy();
    expect(screen.getByText('Groceries')).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem('loam:budget-template:v1')).toContain('Groceries'));
  });

  it('navigates between months and filters transactions', () => {
    render(<BudgetApp />);

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getAllByText('December 2026').length).toBeGreaterThan(0);
    expect(screen.getByText('No transactions this month.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByText('$2,616.07')).toBeTruthy();
  });

  it('deletes a transaction and recalculates the balance', () => {
    render(<BudgetApp />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Rent' }));
    expect(screen.getByText('$3,816.07')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete Rent' })).toBeNull();
  });
});
