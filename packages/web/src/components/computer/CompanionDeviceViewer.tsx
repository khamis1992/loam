'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Loader2, Send } from 'lucide-react';
import { t } from '@/i18n/t';
import { Dialog } from '@/components/ui/Dialog';
import { captureCompanionScreen, ensureCompanionGui, sendCompanionInput, setCompanionControl, type CompanionDevice } from '@/services/companionsApi';

export function CompanionDeviceViewer({ device, open, onClose }: { device: CompanionDevice; open: boolean; onClose: () => void }) {
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const frameRef = useRef<string | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let inFlight = false;
    const updateFrame = (blob: Blob) => {
      const next = URL.createObjectURL(blob);
      if (frameRef.current) URL.revokeObjectURL(frameRef.current);
      frameRef.current = next;
      setFrame(next);
    };
    const capture = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const blob = await captureCompanionScreen(device.id);
        if (!cancelled) {
          updateFrame(blob);
          setError(null);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      } finally {
        inFlight = false;
      }
    };
    setLoading(true);
    setError(null);
    void setCompanionControl(device.id, true)
      .then(() => ensureCompanionGui(device.id))
      .then(capture)
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    const interval = window.setInterval(() => void capture(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      void setCompanionControl(device.id, false).catch(() => undefined);
      if (frameRef.current) {
        URL.revokeObjectURL(frameRef.current);
        frameRef.current = null;
      }
      setFrame(null);
    };
  }, [device.id, open]);

  const click = async (event: MouseEvent<HTMLImageElement>) => {
    const image = imageRef.current;
    if (!image?.naturalWidth || !image.naturalHeight) return;
    const rect = image.getBoundingClientRect();
    const x = Math.round((event.clientX - rect.left) * image.naturalWidth / rect.width);
    const y = Math.round((event.clientY - rect.top) * image.naturalHeight / rect.height);
    try {
      await sendCompanionInput(device.id, { type: 'click', x, y });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const sendText = async () => {
    if (!text) return;
    setSending(true);
    try {
      await sendCompanionInput(device.id, { type: 'type', text });
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={device.name} width={960}>
      <div className="flex flex-col gap-3">
        <div className="flex min-h-[360px] items-center justify-center overflow-hidden rounded-card bg-[#111114]">
          {frame ? (
            <img ref={imageRef} src={frame} alt={`${device.name} ${t('Live screen')}`} onClick={(event) => void click(event)} className="max-h-[65vh] w-full cursor-crosshair object-contain" />
          ) : loading ? (
            <div className="flex items-center gap-2 text-sm text-white/70"><Loader2 className="size-5 animate-spin" />{t('Connecting to live view…')}</div>
          ) : (
            <p className="p-6 text-center text-sm text-red-200">{error || t('Live view unavailable')}</p>
          )}
        </div>
        {error && frame && <p role="alert" className="text-xs text-func-error">{error}</p>}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void sendText();
          }}
        >
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t('Type on the remote computer')}
            className="min-w-0 flex-1 rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary"
          />
          <button type="submit" disabled={sending || !text} className="flex items-center gap-1.5 rounded-control bg-fill-hover px-3 py-2 text-sm text-text-primary disabled:opacity-50">
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            {t('Send')}
          </button>
        </form>
      </div>
    </Dialog>
  );
}
