'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/shell/Sidebar';
import { TitleBar } from '@/components/shell/TitleBar';
import { Spinner } from '@/components/ui/Button';
import { useAppSelector, useAppDispatch } from '@/store';
import { setToken } from '@/store/authSlice';
import { desktopApis } from '@/services/desktopApis';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const sidebarOpen = useAppSelector((s) => s.ui.sidebarOpen);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const token = await desktopApis.auth.getToken();
        if (!mounted) return;
        if (!token) {
          router.replace('/login');
          return;
        }
        dispatch(setToken(token));
      } finally {
        if (mounted) setChecking(false);
      }
    })();
    return () => { mounted = false; };
  }, [router, dispatch]);

  if (checking) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg-main">
        <Spinner className="size-6 text-text-secondary" />
      </div>
    );
  }

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
