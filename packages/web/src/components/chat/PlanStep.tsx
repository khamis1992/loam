import type { NewPlanStepEvent, PlanUpdateEvent, TodoUpdateEvent } from '@shared/socket';

export function PlanStepRow({ e }: { e: NewPlanStepEvent }) {
  return <div className="mt-3 flex items-center gap-2 text-title-base text-text-primary">◉ {e.title}</div>;
}

export function PlanUpdateRow({ e }: { e: PlanUpdateEvent }) {
  return (
    <div className="flex flex-col gap-1">
      {e.tasks.map((task, i) => (
        <div key={i} className="flex items-center gap-2 text-sm text-text-secondary">
          <span className={task.status === 'done' ? 'text-func-success' : 'text-icon-blue'}>
            {task.status === 'done' ? '✓' : '●'}
          </span>
          {task.title}
        </div>
      ))}
    </div>
  );
}

const TODO_STATUS_LABEL: Record<string, string> = {
  pending: '○',
  in_progress: '◉',
  completed: '✓',
};

/** The model's live task list, replaced in full by `todo_write`. */
export function TodoListRow({ e }: { e: TodoUpdateEvent }) {
  return (
    <div className="flex flex-col gap-1" data-testid="todo-list">
      {e.todos.map((todo) => {
        const done = todo.status === 'completed';
        const active = todo.status === 'in_progress';
        return (
          <div key={todo.id} className="flex items-center gap-2 text-sm text-text-secondary" data-todo-status={todo.status}>
            <span className={done ? 'text-func-success' : active ? 'text-icon-blue' : 'text-text-tertiary'}>
              {TODO_STATUS_LABEL[todo.status] ?? '○'}
            </span>
            <span className={done ? 'line-through opacity-70' : undefined}>{todo.content}</span>
          </div>
        );
      })}
    </div>
  );
}
