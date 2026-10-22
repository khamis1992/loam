'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAppDispatch } from '@/store';
import { setToken, setUser } from '@/store/authSlice';
import { desktopApis, validateSessionToken, logoutAndRedirect } from '@/services/desktopApis';

export default function IndexPage() {
  const router = useRouter();
  const dispatch = useAppDispatch();
  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkSessionAgain = () => { void run(); };
    const run = async () => {
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
      if (check.status !== 'ok') {
        // Backend temporarily unreachable: keep the persisted session and
        // retry instead of logging the user out.
        timer = setTimeout(() => { if (mounted) checkSessionAgain(); }, 1500);
        return;
      }
      const user = check.user;
      dispatch(setToken(token));
      dispatch(setUser({
        displayname: user.displayname || `${user.firstname} ${user.lastname}`.trim() || user.email,
        email: user.email,
        avatar: user.avatar,
      }));
      router.replace('/app');
    };
    run();
    return () => { mounted = false; if (timer) clearTimeout(timer); };
  }, [router, dispatch]);
  return null;
}
