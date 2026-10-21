'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { t } from '@/i18n/t';

/** Hover copy affordance for one chat message (option #12, client-only). */
export function CopyMessageButton({ text, align = 'start' }: { text: string; align?: 'start' | 'end' }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      aria-label={t('Copy message')}
      title={t('Copy message')}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(text).then(
          () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
          () => setCopied(false),
        );
      }}
      className={`absolute top-1 ${align === 'end' ? 'left-1' : 'right-1'} z-10 rounded-control bg-bg-menu p-1 text-text-tertiary opacity-0 shadow-sm transition-opacity hover:bg-fill-hover hover:text-text-primary focus:opacity-100 group-hover:opacity-100`}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}
