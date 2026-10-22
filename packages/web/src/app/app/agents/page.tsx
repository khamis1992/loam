import { Suspense } from 'react';
import AgentsPageClient, { AgentsPageFallback } from './AgentsPageClient';

export default function AgentsPage() {
  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-bg-main">
      <Suspense fallback={<AgentsPageFallback />}>
        <AgentsPageClient />
      </Suspense>
    </div>
  );
}
