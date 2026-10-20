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
    (async () => {
      const token = await desktopApis.auth.getToken();
      if (!mounted) return;
      if (!token) {
        router.replace('/login');
        return;
      }
      const user = await validateSessionToken(token);
      if (!mounted) return;
      if (!user) {
        await logoutAndRedirect(router, dispatch);
        return;
      }
      dispatch(setToken(token));
      dispatch(setUser({
        displayname: user.displayname || `${user.firstname} ${user.lastname}`.trim() || user.email,
        email: user.email,
        avatar: user.avatar,
      }));
      router.replace('/app');
    })();
    return () => { mounted = false; };
  }, [router, dispatch]);
  return null;
}
