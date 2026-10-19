import { useState } from 'react';
import { useOnline } from '../../hooks/useOnline.js';

const OFFLINE_STRINGS: Record<string, string> = {
  en: "You're offline. Reconnecting…",
  ar: 'أنت غير متصل. جارٍ إعادة الاتصال…',
};

function currentLocale(): string {
  if (typeof document === 'undefined') return 'en';
  return document.documentElement.lang === 'ar' ? 'ar' : 'en';
}

export function OfflineBanner() {
  const { showBanner } = useOnline();
  const [dismissed, setDismissed] = useState(false);

  if (!showBanner || dismissed) return null;

  const locale = currentLocale();
  const message = OFFLINE_STRINGS[locale] ?? OFFLINE_STRINGS.en;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        insetInline: '16px',
        bottom: '16px',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '12px 16px',
        borderRadius: '12px',
        background: '#1a1a1a',
        color: '#fff',
        boxShadow: '0 8px 24px rgba(0,0,0,.2)',
      }}
    >
      <span style={{ fontSize: '14px', lineHeight: '20px' }}>{message}</span>
      <button
        aria-label="Close"
        onClick={() => setDismissed(true)}
        style={{
          flex: 'none',
          width: '28px',
          height: '28px',
          border: 'none',
          borderRadius: '8px',
          background: 'rgba(255,255,255,.1)',
          color: '#fff',
          cursor: 'pointer',
        }}
      >
        ×
      </button>
    </div>
  );
}
