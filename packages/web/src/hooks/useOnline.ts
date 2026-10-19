import { useCallback, useEffect, useState } from 'react';

export interface UseOnlineResult {
  /** Reflects the last window online/offline event. */
  online: boolean;
  /** True only after being offline for the grace period. */
  showBanner: boolean;
  /** True if the browser has recovered from offline at least once. */
  wasOffline: boolean;
  /** Manual retry trigger; only meaningful while offline. */
  retry: () => void;
}

export function useOnline(graceMs = 10_000): UseOnlineResult {
  const [online, setOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [showBanner, setShowBanner] = useState(false);
  const [wasOffline, setWasOffline] = useState(false);

  const retry = useCallback(() => {
    if (online) return;
    // Signal the socket layer to attempt an immediate reconnect/replay.
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
  }, [online]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const handleOnline = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      setOnline(true);
      setShowBanner(false);
      setWasOffline(true);
    };

    const handleOffline = () => {
      setOnline(false);
      timer = setTimeout(() => {
        setShowBanner(true);
      }, graceMs);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (timer) clearTimeout(timer);
    };
  }, [graceMs]);

  return { online, showBanner, wasOffline, retry };
}
