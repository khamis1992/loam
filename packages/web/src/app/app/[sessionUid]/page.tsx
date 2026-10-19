import { Suspense } from 'react';
import TaskPageClient from './TaskPageClient';

export function generateStaticParams() {
  return ['demo-running', 'demo-completed'].map((sessionUid) => ({ sessionUid }));
}

export default function TaskPage({ params }: { params: Promise<{ sessionUid: string }> }) {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center text-text-secondary">Loading…</div>}>
      <TaskPageClient params={params} />
    </Suspense>
  );
}
