import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { TodoListRow } from '../PlanStep';
import type { TodoUpdateEvent } from '@shared/socket';

function todoEvent(): TodoUpdateEvent {
  return {
    id: 'evt_1',
    type: 'todoUpdate',
    timestamp: 1,
    todos: [
      { id: 'todo-0', content: 'read the spec', status: 'completed' },
      { id: 'todo-1', content: 'write the parser', status: 'in_progress' },
      { id: 'todo-2', content: 'run the tests', status: 'pending' },
    ],
  };
}

describe('TodoListRow', () => {
  it('renders every todo item with its content', () => {
    render(<TodoListRow e={todoEvent()} />);
    const list = screen.getByTestId('todo-list');
    expect(within(list).getByText('read the spec')).toBeTruthy();
    expect(within(list).getByText('write the parser')).toBeTruthy();
    expect(within(list).getByText('run the tests')).toBeTruthy();
  });

  it('marks each item with its status', () => {
    render(<TodoListRow e={todoEvent()} />);
    expect(screen.getByText('read the spec').closest('[data-todo-status]')?.getAttribute('data-todo-status')).toBe('completed');
    expect(screen.getByText('write the parser').closest('[data-todo-status]')?.getAttribute('data-todo-status')).toBe('in_progress');
    expect(screen.getByText('run the tests').closest('[data-todo-status]')?.getAttribute('data-todo-status')).toBe('pending');
  });
});
