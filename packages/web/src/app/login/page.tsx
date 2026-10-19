'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { t, tRich, PRODUCT } from '@/i18n/t';
import { Button, Spinner } from '@/components/ui/Button';
import { desktopApis, desktopEvents } from '@/services/desktopApis';

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEnv, setShowEnv] = useState(false);

  useEffect(() => {
    const unsub = desktopEvents.auth.onLoginSuccess(() => router.replace('/app'));
    const unsubErr = desktopEvents.auth.onLoginError((err) => setError(err.error));
    return () => { unsub(); unsubErr(); };
  }, [router]);

  const signIn = useCallback(async (type: 'signIn' | 'signUp' = 'signIn') => {
    setLoading(true);
    setError(null);
    try {
      const nonce = crypto.randomUUID();
      const webBase = 'http://localhost:8787';
      const url = `${webBase}/login?from=desktop&type=${type}&nonce=${nonce}`;
      await desktopApis.auth.setToken(nonce); // store nonce via desktopLocalStorage stub
      await desktopApis.system.openExternal(url);
    } catch (e) {
      setError('token_exchange_failed');
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-login px-6">
      <div className="relative w-full max-w-md rounded-card bg-bg-menu p-8 shadow-card">
        {process.env.NODE_ENV !== 'production' && (
          <button
            onClick={() => setShowEnv(true)}
            className="absolute end-3 top-3 rounded-full bg-fill-tsp px-2 py-0.5 text-xs text-text-tertiary"
          >
            {t('Dev environment')}
          </button>
        )}

        <div className="flex flex-col items-center gap-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-text-primary text-xl text-text-onblack">
            {PRODUCT[0]}
          </div>

          <h1 className="text-headline-base text-text-primary">{t('Sign in to {product}', { product: PRODUCT })}</h1>

          <Button
            variant="primary"
            size="lg"
            loading={loading}
            onClick={() => signIn('signIn')}
            className="w-full"
          >
            {loading ? <Spinner className="size-4" /> : t('Sign in')}
          </Button>

          <button className="text-sm text-text-secondary hover:text-text-primary hover:underline">
            {t('Having trouble logging in?')}
          </button>

          {error && <p className="text-sm text-func-error">{t('Failed to switch environment. Please try again.')}</p>}

          <p className="max-w-xs text-center text-xs text-text-tertiary">
            {tRich(
              'By continuing, you agree to our <terms>Terms of Service</terms> and have read our <privacy>Privacy Policy</privacy>.',
              {
                terms: (children) => <a href="#" className="underline hover:text-text-primary">{children}</a>,
                privacy: (children) => <a href="#" className="underline hover:text-text-primary">{children}</a>,
              },
            )}
          </p>
        </div>
      </div>

      {showEnv && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40">
          <div className="w-80 rounded-card bg-bg-menu p-5 shadow-layer">
            <h2 className="mb-3 text-title-base text-text-primary">{t('Switch environment?')}</h2>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowEnv(false)}>{t('Close')}</Button>
              <Button variant="primary" size="sm" onClick={() => setShowEnv(false)}>{t('Switch and restart')}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
