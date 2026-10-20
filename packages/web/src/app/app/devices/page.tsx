'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, MonitorSmartphone } from 'lucide-react';
import { t } from '@/i18n/t';
import { getSessionToken, getApiBase } from '@/services/rpc';

interface DesktopDevice {
  id: string;
  name?: string;
  type?: string;
}

export default function DevicesPage() {
  const router = useRouter();
  const [devices, setDevices] = useState<DesktopDevice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const token = await getSessionToken();
      try {
        const res = await fetch(`${getApiBase()}/desktop.v1.DesktopService/GetDesktopDevices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'Authorization': `Bearer ${token}`,
          },
          body: '{}',
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { devices?: DesktopDevice[] };
        if (mounted) setDevices(data.devices ?? []);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('failed to load desktop devices', e);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg-main">
      <div className="flex h-row items-center gap-3 border-b border-border-main px-4">
        <button
          type="button"
          onClick={() => router.push('/app')}
          className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
        >
          <ArrowLeft className="size-4" />
        </button>
        <h1 className="text-title-lg text-text-primary">{t('Devices')}</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-text-secondary">
            <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
          </div>
        ) : devices.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-tertiary">
            <p className="text-sm">{t('No linked devices.')}</p>
            <p className="max-w-[320px] text-center text-xs">{t('Desktop and companion devices will appear here.')}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center gap-3 rounded-card border border-border-main bg-bg-menu p-3">
                <MonitorSmartphone className="size-4 text-text-tertiary" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">{d.name || d.id}</p>
                  <p className="text-xs text-text-tertiary">{d.type || 'desktop'}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
