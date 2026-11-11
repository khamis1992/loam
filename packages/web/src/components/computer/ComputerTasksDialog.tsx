'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, RefreshCw } from 'lucide-react';
import { t } from '@/i18n/t';
import { Dialog } from '@/components/ui/Dialog';
import { listCompanionTasks, startCompanionTask, type CompanionDevice, type CompanionTask } from '@/services/companionsApi';

export function ComputerTasksDialog({ device, open, onClose, onOpenTask }: {
  device: CompanionDevice;
  open: boolean;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [tasks, setTasks] = useState<CompanionTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);

  const refresh = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      setTasks(await listCompanionTasks(device.agentId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [device.agentId, open]);

  useEffect(() => {
    setPrompt('');
    void refresh();
  }, [refresh]);

  const start = async () => {
    if (!prompt.trim()) return;
    setStarting(true);
    setError(null);
    try {
      const task = await startCompanionTask(device.agentId, prompt.trim());
      onOpenTask(task.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={`${device.name} — ${t('Tasks')}`} width={640}>
      <div className="flex flex-col gap-4">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t('Assign a task or ask anything')}
            className="min-w-0 flex-1 rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary"
          />
          <button type="submit" disabled={starting || !prompt.trim()} className="flex items-center gap-1.5 rounded-control bg-[#1a1a19] px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white/90 dark:text-black">
            {starting ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {t('New task')}
          </button>
        </form>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-text-primary">{t('Tasks')}</h3>
          <button type="button" disabled={loading} onClick={() => void refresh()} className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover" aria-label={t('Retry')}>
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {error && <p role="alert" className="text-xs text-func-error">{error}</p>}
        {loading && tasks.length === 0 ? (
          <div className="flex justify-center py-8 text-text-secondary"><Loader2 className="size-5 animate-spin" /></div>
        ) : tasks.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-tertiary">{t('No content')}</p>
        ) : (
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {tasks.map((task) => (
              <li key={task.id}>
                <button type="button" onClick={() => onOpenTask(task.id)} className="flex w-full items-center gap-3 rounded-control px-3 py-2 text-start hover:bg-fill-hover">
                  <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{task.title}</span>
                  <span className="shrink-0 text-xs text-text-tertiary">{task.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
