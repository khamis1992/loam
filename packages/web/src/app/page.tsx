'use client';

import { useState } from 'react';
import { TitleBar } from '@/components/shell/TitleBar';
import { Sidebar } from '@/components/shell/Sidebar';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

export default function HomePage() {
  const [demoOpen, setDemoOpen] = useState(false);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg-main">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-h-0 flex-1 flex-col items-center justify-center p-8">
          <div className="flex max-w-[768px] flex-col items-center gap-6 text-center">
            <h1 className="text-headline-lg text-text-primary">Agent Studio</h1>
            <p className="text-body-sm text-text-secondary">
              Design-system shell scaffold. Replace this page with the Home / New task workspace.
            </p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => setDemoOpen(true)}>Open dialog</Button>
              <Button>Secondary</Button>
            </div>
          </div>
        </main>
      </div>

      <Dialog open={demoOpen} onClose={() => setDemoOpen(false)} title="Design system check">
        <p className="text-sm text-text-secondary">
          If this dialog rendered with the correct backdrop, radius and shadow, the base UI layer is working.
        </p>
      </Dialog>
    </div>
  );
}
