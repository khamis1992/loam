'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAppDispatch } from '@/store';
import { setToken } from '@/store/authSlice';
import { desktopApis } from '@/services/desktopApis';

export default function IndexPage() {
  const router = useRouter();
  const dispatch = useAppDispatch();
  useEffect(() => {
    let mounted = true;
    (async () => {
      const token = await desktopApis.auth.getToken();
      if (!mounted) return;
      if (token) {
        dispatch(setToken(token));
        router.replace('/app');
      } else {
        router.replace('/login');
      }
    })();
    return () => { mounted = false; };
  }, [router, dispatch]);
  return null;
}
