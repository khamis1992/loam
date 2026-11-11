'use client';

import { useEffect, useRef, useState } from 'react';
import { captureCompanionScreen } from '@/services/companionsApi';

export function CompanionCardPreview({ deviceId, state }: { deviceId: string; state: string }) {
  const [frame, setFrame] = useState<string | null>(null);
  const frameRef = useRef<string | null>(null);

  useEffect(() => {
    if (state !== 'running') {
      setFrame(null);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const capture = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const blob = await captureCompanionScreen(deviceId);
        if (cancelled) return;
        const next = URL.createObjectURL(blob);
        if (frameRef.current) URL.revokeObjectURL(frameRef.current);
        frameRef.current = next;
        setFrame(next);
      } catch {
        if (!cancelled) setFrame(null);
      } finally {
        inFlight = false;
      }
    };
    void capture();
    const interval = window.setInterval(() => void capture(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      if (frameRef.current) {
        URL.revokeObjectURL(frameRef.current);
        frameRef.current = null;
      }
      setFrame(null);
    };
  }, [deviceId, state]);

  if (!frame) return null;
  return <img src={frame} alt="" className="pointer-events-none absolute inset-0 size-full object-cover" />;
}
