import { useState, type ReactNode } from 'react';
import type { NewPlanStepEvent, PlanUpdateEvent, TodoUpdateEvent } from '@shared/socket';

export function PlanStepRow({ e }: { e: NewPlanStepEvent }) {
  return <div className="mt-3 flex items-center gap-2 text-title-base text-text-primary">◉ {e.title}</div>;
}

/**
 * A plan step with its tool calls nested underneath, matching Manus's grouped
 * timeline: the step title is the header, and every toolUsed/statusUpdate that
 * carries the step's `planStepId` renders as an indented child row. The group
 * collapses so a long run stays scannable.
 */
export function StepGroup({ step, children }: { step: NewPlanStepEvent; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mt-3" data-testid="step-group" data-step-id={step.stepId}>
      <button
        type="button"
        className="flex items-center gap-2 text-start text-title-base text-text-primary hover:text-text-secondary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true" className="text-text-tertiary">{open ? '▾' : '▸'}</span>
        <span aria-hidden="true">◉</span>
        <span>{step.title}</span>
      </button>
      {open ? (
        <div className="mt-1 flex flex-col gap-1 border-s border-border-main ps-4">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function PlanUpdateRow({ e }: { e: PlanUpdateEvent }) {
  return (
    <div className="flex flex-col gap-1">
      {e.tasks.map((task, i) => (
        <div key={i} className="flex items-center gap-2 text-sm text-text-secondary">
          {task.status === 'done'
            ? <span className="text-func-success">✓</span>
            : task.status === 'doing'
              ? <span className="status-active-dot shrink-0" aria-hidden />
              : <span className="text-text-tertiary" aria-hidden>○</span>}
          <span className={task.status === 'done' ? 'opacity-70' : undefined}>{task.title}</span>
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
            {active
              ? <span className="status-active-dot shrink-0" aria-hidden />
              : <span className={done ? 'text-func-success' : 'text-text-tertiary'}>{TODO_STATUS_LABEL[todo.status] ?? '○'}</span>}
            <span className={done ? 'line-through opacity-70' : undefined}>{todo.content}</span>
          </div>
        );
      })}
    </div>
  );
}
