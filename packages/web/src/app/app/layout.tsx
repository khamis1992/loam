'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/shell/Sidebar';
import { PanelLeft } from 'lucide-react';
import { toggleSidebar } from '@/store';
import { Spinner } from '@/components/ui/Button';
import { useAppSelector, useAppDispatch } from '@/store';
import { setToken, setUser } from '@/store/authSlice';
import { desktopApis, validateSessionToken, logoutAndRedirect } from '@/services/desktopApis';
import { t } from '@/i18n/t';

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
        const check = await validateSessionToken(token);
        if (!mounted) return;
        if (check.status === 'invalid') {
          await logoutAndRedirect(router, dispatch);
          return;
        }
        if (check.status === 'ok') {
          const user = check.user;
          dispatch(setToken(token));
          dispatch(setUser({
            displayname: user.displayname || `${user.firstname} ${user.lastname}`.trim() || user.email,
            email: user.email,
            avatar: user.avatar,
          }));
        }
        // unreachable: keep a persisted session; pages still retrieve the
        // token via getSessionToken()
      } finally {
        if (mounted) setChecking(false);
      }
    })();
    return () => { mounted = false; };
  }, [router, dispatch]);

  if (checking) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-bg-main">
        <Spinner className="size-6 text-text-secondary" />
      </div>
    );
  }

  return (
    <div className="flex h-dvh w-full min-w-0 overflow-hidden bg-bg-main">
      {sidebarOpen && <div className="shrink-0"><Sidebar /></div>}
      {!sidebarOpen && (
        <button
          type="button"
          aria-label={t('Toggle sidebar')}
          title={t('Toggle sidebar')}
          onClick={() => dispatch(toggleSidebar())}
          className="absolute start-1 top-1 z-50 flex h-7 w-7 items-center justify-center rounded-control bg-bg-menu text-text-secondary shadow-card hover:bg-fill-hover"
        >
          <PanelLeft className="size-4" />
        </button>
      )}
      <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
