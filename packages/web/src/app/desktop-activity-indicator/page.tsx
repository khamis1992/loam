'use client';

import { useState } from 'react';
import { t, PRODUCT } from '@/i18n/t';

interface Task {
  id: string;
  title: string;
  state: 'running' | 'completed' | 'waiting';
}

export default function ActivityIndicatorPage() {
  const [tasks, setTasks] = useState<Task[]>([
    { id: '1', title: 'Summarize the quarterly report', state: 'running' },
    { id: '2', title: 'Draft an email to the team', state: 'completed' },
    { id: '3', title: 'Review the design mockups', state: 'waiting' },
  ]);

  const updateTask = (id: string, state: Task['state']) => {
    setTasks(tasks.map((t) => t.id === id ? { ...t, state } : t));
  };

  return (
    <div
      className="relative h-[788px] w-[600px] overflow-hidden p-4"
      style={{ background: 'transparent' }}
    >
      <div className="absolute inset-0" style={{ pointerEvents: 'none' }} />
      <div className="relative flex flex-col gap-2" style={{ pointerEvents: 'auto' }}>
        {tasks.map((task) => (
          <div
            key={task.id}
            className="rounded-card border px-3 py-2.5 transition-colors"
            style={{
              backgroundColor: 'var(--activity-indicator-card-background)',
              borderColor: 'var(--activity-indicator-card-border)',
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 overflow-hidden">
                <StatusDot state={task.state} />
                <span className="truncate text-sm font-medium" style={{ color: 'var(--activity-indicator-title)' }}>
                  {task.title}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs" style={{ color: statusColor(task.state) }}>
                  {task.state === 'running' ? t('Thinking') : task.state === 'completed' ? t('Task completed') : t('Waiting for user...')}
                </span>
                {task.state === 'running' ? (
                  <button
                    onClick={() => updateTask(task.id, 'waiting')}
                    className="flex h-6 w-6 items-center justify-center rounded-control text-xs text-text-onblack"
                    style={{ backgroundColor: 'var(--Button-black)' }}
                    aria-label={t('Stop task')}
                  >
                    ■
                  </button>
                ) : (
                  <button
                    className="text-xs font-medium"
                    style={{ color: 'var(--text-blue)' }}
                    onClick={() => updateTask(task.id, 'running')}
                  >
                    {t('Open')}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
        {tasks.some((t) => t.state === 'completed') && (
          <button
            className="ms-auto text-xs"
            style={{ color: 'var(--activity-indicator-description)' }}
            onClick={() => setTasks(tasks.filter((t) => t.state !== 'completed'))}
          >
            {t('Mark as read')}
          </button>
        )}
      </div>
    </div>
  );
}

function StatusDot({ state }: { state: Task['state'] }) {
  const color = state === 'running' ? 'var(--activity-indicator-running)' : state === 'completed' ? 'var(--activity-indicator-success)' : 'var(--activity-indicator-warning)';
  return (
    <span
      className={`size-2 rounded-full ${state === 'running' ? 'animate-pulse' : ''}`}
      style={{ backgroundColor: color }}
      aria-hidden
    />
  );
}

function statusColor(state: Task['state']) {
  return state === 'running' ? 'var(--activity-indicator-running)' : state === 'completed' ? 'var(--activity-indicator-success)' : 'var(--activity-indicator-warning)';
}
