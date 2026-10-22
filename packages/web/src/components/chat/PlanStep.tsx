import type { NewPlanStepEvent, PlanUpdateEvent } from '@shared/socket';

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
