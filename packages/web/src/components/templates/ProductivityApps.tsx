'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, Pause, Play, Plus, RotateCcw, Trash2, Volume2, VolumeX } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';

function readStored<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

export function FocusTimerApp({ compact = false }: { compact?: boolean }) {
  const [seconds, setSeconds] = useState(() => readStored('loam:focus-seconds', 25 * 60));
  const [preset, setPreset] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [sound, setSound] = useState(false);
  const [soundscape, setSoundscape] = useState('Rain');
  const audioRef = useRef<{ context: AudioContext; source: AudioBufferSourceNode } | null>(null);

  useEffect(() => {
    if (!running || seconds <= 0) return;
    const id = window.setInterval(() => setSeconds((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(id);
  }, [running, seconds]);

  useEffect(() => {
    localStorage.setItem('loam:focus-seconds', JSON.stringify(seconds));
  }, [seconds]);

  useEffect(() => () => {
    audioRef.current?.source.stop();
    void audioRef.current?.context.close();
  }, []);

  const toggleSound = async () => {
    if (sound) {
      audioRef.current?.source.stop();
      void audioRef.current?.context.close();
      audioRef.current = null;
      setSound(false);
      return;
    }
    const context = new AudioContext();
    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = soundscape === 'Rain' ? 900 : soundscape === 'Forest' ? 600 : 350;
    const gain = context.createGain();
    gain.gain.value = 0.035;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(context.destination);
    source.start();
    await context.resume();
    audioRef.current = { context, source };
    setSound(true);
  };

  const reset = () => {
    setRunning(false);
    setSeconds(preset);
  };
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainingSeconds = (seconds % 60).toString().padStart(2, '0');

  return (
    <section className={clsx('flex h-full flex-col items-center justify-center rounded-card bg-[#10182a] text-white', compact ? 'p-4' : 'p-8')} aria-label={t('Focus timer')}>
      <div className="mb-5 flex gap-2">
        {[25, 5, 15].map((minutes) => (
          <button
            key={minutes}
            type="button"
            onClick={() => { setPreset(minutes * 60); setSeconds(minutes * 60); setRunning(false); }}
            className={clsx('rounded-full px-3 py-1 text-xs', preset === minutes * 60 ? 'bg-[#9df2dd] text-[#102a25]' : 'bg-white/10 text-white/60')}
          >
            {minutes}m
          </button>
        ))}
      </div>
      <div className="mb-5 font-mono text-6xl font-semibold tracking-tight" data-testid="focus-time">{minutes}:{remainingSeconds}</div>
      <div className="mb-5 flex gap-2">
        <button type="button" onClick={() => setRunning((value) => !value)} className="flex items-center gap-2 rounded-lg bg-[#9df2dd] px-4 py-2 text-sm font-medium text-[#102a25]">
          {running ? <Pause className="size-4" /> : <Play className="size-4" />}
          {running ? t('Pause') : t('Start')}
        </button>
        <button type="button" onClick={reset} className="flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm text-white/70">
          <RotateCcw className="size-4" /> {t('Reset')}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <select aria-label={t('Ambient sound')} value={soundscape} onChange={(event) => setSoundscape(event.target.value)} className="rounded-lg border border-white/10 bg-[#10182a] px-2 py-1.5 text-xs text-white/60">
          <option>Rain</option>
          <option>Forest</option>
          <option>Waves</option>
        </select>
        <button type="button" onClick={() => void toggleSound()} className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white/60">
          {sound ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
          {sound ? t('Sound on') : t('Sound off')}
        </button>
      </div>
    </section>
  );
}

interface Habit {
  id: string;
  name: string;
  days: boolean[];
}

const INITIAL_HABITS: Habit[] = [
  { id: 'water', name: 'Drink water', days: [true, true, true, true, true, true, false] },
  { id: 'reading', name: 'Read 20 minutes', days: [true, false, true, true, false, true, false] },
  { id: 'exercise', name: 'Exercise', days: [false, true, true, false, true, true, false] },
];

export function HabitTrackerApp({ compact = false }: { compact?: boolean }) {
  const [habits, setHabits] = useState<Habit[]>(() => readStored('loam:habits', INITIAL_HABITS));
  const [name, setName] = useState('');

  useEffect(() => {
    localStorage.setItem('loam:habits', JSON.stringify(habits));
  }, [habits]);

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setHabits((items) => [...items, { id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), name: name.trim(), days: Array(7).fill(false) }]);
    setName('');
  };
  const toggle = (id: string) => {
    setHabits((items) => items.map((habit) => habit.id === id ? { ...habit, days: habit.days.map((day, index) => index === 6 ? !day : day) } : habit));
  };
  const remove = (id: string) => setHabits((items) => items.filter((habit) => habit.id !== id));

  return (
    <section className={clsx('h-full overflow-y-auto rounded-card bg-[#f5f7fb] text-[#172033]', compact ? 'p-4' : 'p-6')} aria-label={t('Habit tracker')}>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{t('Habit tracker')}</h2>
          <p className="text-xs text-[#667085]">{t('Small steps, every day.')}</p>
        </div>
        <span className="rounded-full bg-[#e1f8ef] px-3 py-1 text-xs font-medium text-[#14745a]">{habits.filter((habit) => habit.days[6]).length}/{habits.length} {t('Today')}</span>
      </div>
      <form onSubmit={add} className="mb-5 flex gap-2">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('New habit')} aria-label={t('New habit')} className="min-w-0 flex-1 rounded-lg border border-[#d9e0eb] bg-white px-3 py-2 text-sm outline-none" />
        <button type="submit" className="flex items-center gap-1 rounded-lg bg-[#233154] px-3 py-2 text-sm font-medium text-white"><Plus className="size-4" /> {t('Add')}</button>
      </form>
      <div className="grid gap-3">
        {habits.map((habit) => {
          const streak = habit.days.filter(Boolean).length;
          return (
            <article key={habit.id} className="rounded-xl border border-[#e1e6ef] bg-white p-3">
              <div className="mb-3 flex items-center gap-2">
                <button type="button" onClick={() => toggle(habit.id)} aria-label={t('Toggle {name}', { name: habit.name })} className={clsx('flex size-6 items-center justify-center rounded-full border', habit.days[6] ? 'border-[#2ea97c] bg-[#2ea97c] text-white' : 'border-[#ccd5e1]')}>
                  {habit.days[6] && <Check className="size-4" />}
                </button>
                <h3 className="flex-1 text-sm font-medium">{habit.name}</h3>
                <span className="text-xs text-[#667085]">{streak}/7</span>
                <button type="button" onClick={() => remove(habit.id)} aria-label={t('Delete {name}', { name: habit.name })} className="text-[#98a2b3] hover:text-[#d92d20]"><Trash2 className="size-4" /></button>
              </div>
              <div className="grid grid-cols-7 gap-1">
                {habit.days.map((day, index) => <span key={index} className={clsx('h-2 rounded-full', day ? 'bg-[#2ea97c]' : 'bg-[#e6eaf0]')} />)}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

type KanbanStatus = 'todo' | 'progress' | 'done';
interface KanbanTask { id: string; title: string; status: KanbanStatus }

const INITIAL_TASKS: KanbanTask[] = [
  { id: 'research', title: 'Research competitors', status: 'todo' },
  { id: 'wireframe', title: 'Create wireframes', status: 'progress' },
  { id: 'kickoff', title: 'Team kickoff', status: 'done' },
];
const COLUMNS: Array<{ id: KanbanStatus; label: string }> = [
  { id: 'todo', label: 'To do' },
  { id: 'progress', label: 'In progress' },
  { id: 'done', label: 'Done' },
];

export function KanbanApp({ compact = false }: { compact?: boolean }) {
  const [tasks, setTasks] = useState<KanbanTask[]>(() => readStored('loam:kanban', INITIAL_TASKS));
  const [title, setTitle] = useState('');

  useEffect(() => {
    localStorage.setItem('loam:kanban', JSON.stringify(tasks));
  }, [tasks]);

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setTasks((items) => [...items, { id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), title: title.trim(), status: 'todo' }]);
    setTitle('');
  };
  const move = (task: KanbanTask, direction: -1 | 1) => {
    const current = COLUMNS.findIndex((column) => column.id === task.status);
    const next = COLUMNS[current + direction];
    if (!next) return;
    setTasks((items) => items.map((item) => item.id === task.id ? { ...item, status: next.id } : item));
  };

  return (
    <section className={clsx('h-full overflow-y-auto rounded-card bg-[#111827] text-white', compact ? 'p-3' : 'p-5')} aria-label={t('Kanban board')}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('Team board')}</h2>
        <span className="text-xs text-white/45">{tasks.length} {t('tasks')}</span>
      </div>
      <form onSubmit={add} className="mb-4 flex gap-2">
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t('New task')} aria-label={t('New task')} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#1f2937] px-3 py-2 text-sm text-white outline-none placeholder:text-white/35" />
        <button type="submit" aria-label={t('Add task')} className="rounded-lg bg-[#9df2dd] px-3 py-2 text-sm font-medium text-[#102a25]"><Plus className="size-4" /></button>
      </form>
      <div className="grid grid-cols-3 gap-2">
        {COLUMNS.map((column) => (
          <div key={column.id} className="rounded-xl bg-white/5 p-2">
            <h3 className="mb-3 px-1 text-xs font-medium text-white/55">{t(column.label)}</h3>
            <div className="flex flex-col gap-2">
              {tasks.filter((task) => task.status === column.id).map((task) => (
                <article key={task.id} className="rounded-lg border border-white/10 bg-[#1f2937] p-2.5">
                  <p className="mb-2 text-xs leading-5">{task.title}</p>
                  <div className="flex items-center justify-between">
                    <button type="button" disabled={column.id === 'todo'} onClick={() => move(task, -1)} aria-label={t('Move {title} left', { title: task.title })} className="rounded p-1 text-white/45 hover:bg-white/10 disabled:opacity-20"><ArrowLeft className="size-3.5 rtl:rotate-180" /></button>
                    <button type="button" onClick={() => setTasks((items) => items.filter((item) => item.id !== task.id))} aria-label={t('Delete {title}', { title: task.title })} className="rounded p-1 text-white/35 hover:bg-white/10 hover:text-white"><Trash2 className="size-3.5" /></button>
                    <button type="button" disabled={column.id === 'done'} onClick={() => move(task, 1)} aria-label={t('Move {title} right', { title: task.title })} className="rounded p-1 text-white/45 hover:bg-white/10 disabled:opacity-20"><ArrowRight className="size-3.5 rtl:rotate-180" /></button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
