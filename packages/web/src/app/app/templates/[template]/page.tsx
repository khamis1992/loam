import { notFound } from 'next/navigation';
import { FocusTimerApp, HabitTrackerApp, KanbanApp } from '@/components/templates/ProductivityApps';

export function generateStaticParams() {
  return [{ template: 'focus-timer' }, { template: 'habit-tracker' }, { template: 'kanban' }];
}

export default async function ProductivityTemplatePage({ params }: { params: Promise<{ template: string }> }) {
  const { template } = await params;
  if (template === 'focus-timer') return <FocusTimerApp />;
  if (template === 'habit-tracker') return <HabitTrackerApp />;
  if (template === 'kanban') return <KanbanApp />;
  notFound();
}
