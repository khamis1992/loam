'use client';

import { Sidebar } from '@/components/shell/Sidebar';
import { TitleBar } from '@/components/shell/TitleBar';
import { useAppSelector } from '@/store';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const sidebarOpen = useAppSelector((s) => s.ui.sidebarOpen);
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-main">
      {sidebarOpen && <Sidebar />}
      <div className="flex flex-1 flex-col overflow-hidden">
        <TitleBar>{null}</TitleBar>
        <main className="flex flex-1 flex-col overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
